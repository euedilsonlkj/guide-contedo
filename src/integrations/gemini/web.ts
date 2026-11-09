import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type CDPSession, type Locator, type Page } from "playwright-core";
import { installPageShims } from "./page-shim";

export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

/** Any HTTP answer from the debug port counts as up. */
export async function probeBrowser(cdpUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gemini (gemini.google.com), driven like a person in the operator's logged-in Chrome: a new
 * chat, the "Criar imagem" or "Criar vídeo" tool, the prompt, wait for the result and press
 * the download button of the answer. Gemini uses generated class names, so the code relies on
 * its custom elements (rich-textarea, model-response, generated-image, generated-video), roles
 * and aria-labels in Portuguese and English.
 *
 * Downloads go to a folder of the post through the CDP download behaviour, named by Chrome's
 * own download id, so the file of this answer can never be confused with another one.
 */

export type GeminiStateKind = "logged_out" | "limit" | "refused" | "no_editor" | "no_result" | "no_download";

export class GeminiStateError extends Error {
  constructor(
    public readonly kind: GeminiStateKind,
    detail = "",
  ) {
    super(`gemini ${kind}${detail ? `: ${detail}` : ""}`);
    this.name = "GeminiStateError";
  }
}

export type GeminiMedia = "image" | "video";

export interface GeminiRequest {
  cdpUrl: string;
  origin: string;
  kind: GeminiMedia;
  prompt: string;
  /** Folder where the file is saved; the name is `${baseName}.<ext>`. */
  downloadDir: string;
  baseName: string;
  /** How long the answer may take (videos take minutes). */
  timeoutMs: number;
  /** Image sent with the prompt (the story's character), so every scene shows the same person. */
  referenceImage?: string | null;
}

const TOOL_LABEL: Record<GeminiMedia, RegExp> = {
  image: /^(criar imagem|create image|imagem|image)s?$/i,
  video: /^(criar v[ií]deo|create video|v[ií]deo|video)s?$/i,
};
const FALLBACK_PREFIX: Record<GeminiMedia, string> = {
  image: "Crie uma imagem: ",
  video: "Gere um vídeo: ",
};
const DOWNLOAD_LABEL: Record<GeminiMedia, RegExp> = {
  image: /baixar imagem|download (full size )?image|baixar/i,
  video: /baixar v[ií]deo|download video|baixar/i,
};
/** Text of an answer that means "not today" (daily limit) or "won't do it". */
const LIMIT_TEXT = /(atingiu o limite|limite di[aá]rio|limite de (gera[cç][aã]o|v[ií]deos|imagens)|volte amanh[aã]|tente novamente amanh[aã]|reached (your|the) (daily )?limit|daily limit|try again tomorrow|come back tomorrow)/i;
const REFUSED_TEXT = /(n[aã]o (posso|consigo) (criar|gerar|ajudar)|n[aã]o [eé] poss[ií]vel (criar|gerar)|can.?t (create|generate|help)|unable to (create|generate)|viola|pol[ií]tica)/i;
const LOGIN_URL = /accounts\.google\.com|\/signin|ServiceLogin/i;

function sameHost(url: string, origin: string): boolean {
  try {
    return new URL(url).host === new URL(origin).host;
  } catch {
    return false;
  }
}

async function visible(locator: Locator, timeout = 1500): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: "visible", timeout })
    .then(
      () => true,
      () => false,
    );
}

async function dismissDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    if (!(await visible(page.locator("mat-dialog-container, [role=dialog]"), 800))) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }
}

/** Opens a new chat and checks that the session is logged in. */
export async function openNewChat(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin.replace(/\/$/, "")}/app`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2500);
  if (LOGIN_URL.test(page.url()) || !sameHost(page.url(), origin)) throw new GeminiStateError("logged_out", page.url().slice(0, 80));
  const editor = page.locator("rich-textarea [contenteditable=true], [contenteditable=true][aria-label]").first();
  if (!(await visible(editor, 20_000))) {
    if (await visible(page.getByRole("link", { name: /fazer login|sign in/i }), 500)) throw new GeminiStateError("logged_out");
    throw new GeminiStateError("no_editor");
  }
  await dismissDialogs(page);
}

/** Turns on the "Criar imagem" / "Criar vídeo" tool. False when the menu was not found. */
export async function selectTool(page: Page, kind: GeminiMedia): Promise<boolean> {
  const toolsButton = page.locator('button[aria-label="Envio e ferramentas"], button[aria-label*="ferramentas" i], button[aria-label*="tools" i]').first();
  if (!(await visible(toolsButton, 3000))) return false;
  await toolsButton.click();
  const item = page.getByRole("menuitemcheckbox", { name: TOOL_LABEL[kind] }).or(page.getByRole("menuitem", { name: TOOL_LABEL[kind] }));
  if (!(await visible(item, 4000))) {
    await page.keyboard.press("Escape");
    return false;
  }
  const checked = await item.first().getAttribute("aria-checked");
  if (checked !== "true") await item.first().click();
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  await dismissDialogs(page);
  return true;
}

/**
 * Attaches an image to the prompt through "Enviar arquivos". Returns false when the menu or the
 * upload did not work; the prompt then goes without it (it still describes the person).
 */
export async function attachImage(page: Page, file: string): Promise<boolean> {
  const toolsButton = page.locator('button[aria-label="Envio e ferramentas"], button[aria-label*="ferramentas" i], button[aria-label*="tools" i]').first();
  if (!(await visible(toolsButton, 3000))) return false;
  await toolsButton.click();
  const upload = page.getByRole("menuitem", { name: /enviar arquivos|upload files|carregar arquivos/i }).first();
  if (!(await visible(upload, 4000))) {
    await page.keyboard.press("Escape");
    return false;
  }
  try {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), upload.click()]);
    await chooser.setFiles(file);
  } catch {
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }
  // Wait for the thumbnail of the attached image in the input area.
  const preview = page.locator("input-area-v2 img, uploader-file-preview img, [data-test-id*=file] img, .file-preview img").first();
  const shown = await visible(preview, 20_000);
  await page.waitForTimeout(1500);
  await dismissDialogs(page);
  return shown;
}

async function typePrompt(page: Page, prompt: string): Promise<void> {
  const editor = page.locator("rich-textarea [contenteditable=true], [contenteditable=true][aria-label]").first();
  await editor.click();
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(600);
  const send = page.locator('button[aria-label*="Enviar" i], button[aria-label*="Send" i]').first();
  if (await visible(send, 1500)) await send.click();
  else await page.keyboard.press("Enter");
}

async function responseCount(page: Page): Promise<number> {
  return page.locator("model-response").count();
}

/** Waits for the new answer to show the generated image or video, or a refusal/limit text. */
async function waitForResult(page: Page, kind: GeminiMedia, before: number, timeoutMs: number): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  const mediaSelector = kind === "image" ? "generated-image img, single-image img" : "generated-video video, video-player video";
  while (Date.now() < deadline) {
    await page.waitForTimeout(4000);
    if (LOGIN_URL.test(page.url())) throw new GeminiStateError("logged_out");
    const count = await responseCount(page);
    if (count <= before) continue;
    const answer = page.locator("model-response").last();
    const media = answer.locator(mediaSelector).first();
    if ((await media.count()) > 0) {
      const ready = await media
        .evaluate((element) => {
          if (element instanceof HTMLImageElement) return element.complete && element.naturalWidth > 0;
          if (element instanceof HTMLVideoElement) return Boolean(element.currentSrc || element.src);
          return false;
        })
        .catch(() => false);
      if (ready) return answer;
      continue;
    }
    const text = (await answer.innerText().catch(() => "")).trim();
    // Still thinking or showing "Gerando seu vídeo...": keep waiting until the text settles on an answer.
    if (LIMIT_TEXT.test(text)) throw new GeminiStateError("limit", text.slice(0, 160));
    const busy = await answer.locator("[class*=loading], [class*=progress], mat-progress-spinner, mat-progress-bar, thinking-overlay[active], .generating").count();
    if (busy === 0 && text.length > 40 && REFUSED_TEXT.test(text)) throw new GeminiStateError("refused", text.slice(0, 160));
  }
  throw new GeminiStateError("no_result", `nothing after ${Math.round(timeoutMs / 1000)}s`);
}

interface DownloadWatch {
  done: Promise<{ guid: string; suggested: string }>;
  stop: () => Promise<void>;
}

async function watchDownloads(browser: Browser, dir: string, timeoutMs: number): Promise<DownloadWatch> {
  const session: CDPSession = await browser.newBrowserCDPSession();
  await session.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
  const names = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<{ guid: string; suggested: string }>((resolve, reject) => {
    session.on("Browser.downloadWillBegin", (event: { guid: string; suggestedFilename: string }) => names.set(event.guid, event.suggestedFilename));
    session.on("Browser.downloadProgress", (event: { guid: string; state: string }) => {
      if (event.state === "completed") resolve({ guid: event.guid, suggested: names.get(event.guid) ?? "" });
      if (event.state === "canceled") reject(new GeminiStateError("no_download", "download canceled"));
    });
    timer = setTimeout(() => reject(new GeminiStateError("no_download", "download did not finish")), timeoutMs);
  });
  return {
    done,
    stop: async () => {
      clearTimeout(timer);
      // Back to Chrome's normal behaviour, so the operator's own downloads in this window work as usual.
      await session.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => undefined);
      await session.detach().catch(() => undefined);
    },
  };
}

async function clickDownload(page: Page, answer: Locator, kind: GeminiMedia): Promise<void> {
  const media = answer.locator(kind === "image" ? "generated-image, single-image" : "generated-video, video-player").first();
  await media.hover().catch(() => undefined);
  const button = answer.getByRole("button", { name: DOWNLOAD_LABEL[kind] }).first();
  if (!(await visible(button, 5000))) throw new GeminiStateError("no_download", "download button not found");
  await button.click();
  // Some versions open a small menu ("Baixar" / "Download") after the first click.
  const item = page.getByRole("menuitem", { name: /baixar|download/i }).first();
  if (await visible(item, 1500)) await item.click();
}

function extensionFor(kind: GeminiMedia, suggested: string): string {
  const ext = path.extname(suggested).toLowerCase();
  if (ext && ext.length <= 5) return ext;
  return kind === "image" ? ".png" : ".mp4";
}

/**
 * Asks Gemini for one image or one video clip in a new tab of the Gemini Chrome and saves it.
 * Returns the saved file. The tab is always closed; the operator's tabs are never touched.
 */
export async function generateWithGemini(request: GeminiRequest): Promise<string> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(request.cdpUrl, { timeout: 8000 });
  } catch (error) {
    throw new BrowserUnavailableError(`cannot reach the Gemini Chrome at ${request.cdpUrl}: ${error instanceof Error ? error.message : error}`);
  }
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new BrowserUnavailableError("Gemini Chrome has no default context (profile not loaded)");
  }
  mkdirSync(request.downloadDir, { recursive: true });
  const page = await context.newPage();
  let watch: DownloadWatch | undefined;
  try {
    await installPageShims(page);
    await openNewChat(page, request.origin);
    const tool = await selectTool(page, request.kind);
    if (request.referenceImage) await attachImage(page, request.referenceImage);
    const before = await responseCount(page);
    await typePrompt(page, tool ? request.prompt : FALLBACK_PREFIX[request.kind] + request.prompt);
    const answer = await waitForResult(page, request.kind, before, request.timeoutMs);
    // Videos keep encoding for a moment after the player shows up.
    await page.waitForTimeout(request.kind === "video" ? 4000 : 1500);
    watch = await watchDownloads(browser, request.downloadDir, request.kind === "video" ? 180_000 : 90_000);
    await clickDownload(page, answer, request.kind);
    const { guid, suggested } = await watch.done;
    const downloaded = path.join(request.downloadDir, guid);
    // Chrome may report "completed" a moment before the file is renamed from its temporary name.
    for (let i = 0; i < 20 && !existsSync(downloaded); i += 1) await page.waitForTimeout(250);
    if (!existsSync(downloaded) || statSync(downloaded).size === 0) throw new GeminiStateError("no_download", "file missing after download");
    const target = path.join(request.downloadDir, `${request.baseName}${extensionFor(request.kind, suggested)}`);
    renameSync(downloaded, target);
    return target;
  } finally {
    await watch?.stop();
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
