import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright-core";
import { findWebBrowser, WebBrowserUnavailableError } from "@/integrations/browser";
import type { Env } from "@/lib/env";
import type { CarouselScript, PhotoCarouselScript, PhotoSlide, Slide } from "./ai";
import type { ContentConfig } from "./schedule";

/**
 * Draws the posts: every slide is an HTML page in the brand (style vexa or obra, see the config),
 * rendered by an invisible Chrome. The AI never writes inside an image, so the text is always
 * spelled right; Gemini only supplies the background photo of the cover and the video clips.
 */

export const FEED = { width: 1080, height: 1350 };
export const STORY = { width: 1080, height: 1920 };

type Brand = ContentConfig["brand"];

const fontCss = new Map<string, string>();

/** The font of a style, embedded (the slides are drawn offline). */
function fontFace(family: "Montserrat" | "Archivo"): string {
  const cached = fontCss.get(family);
  if (cached !== undefined) return cached;
  let css = "";
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const file =
      family === "Archivo"
        ? require.resolve("@fontsource-variable/archivo/files/archivo-latin-standard-normal.woff2")
        : require.resolve("@fontsource-variable/montserrat/files/montserrat-latin-wght-normal.woff2");
    const data = readFileSync(file).toString("base64");
    css = `@font-face{font-family:"${family}";font-style:normal;font-weight:100 900;${family === "Archivo" ? "font-stretch:62% 125%;" : ""}font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2");}`;
  } catch {
    css = "";
  }
  fontCss.set(family, css);
  return css;
}

/**
 * The "obra" look (Guide): Archivo condensed in capitals for titles, square corners everywhere,
 * no glow, a thin frame like a window around the slide. It reshapes the same slides by CSS.
 */
function obraCss(brand: Brand): string {
  return `
body{font-family:"Archivo",Arial,sans-serif}
h1,h2{font-family:"Archivo",Arial,sans-serif;text-transform:uppercase;font-stretch:78%;font-weight:800 !important;letter-spacing:-.005em !important;line-height:.98 !important}
[style*="border-radius"]{border-radius:0 !important}
.glow,.grid{display:none}
.top{letter-spacing:.32em;font-weight:800;font-size:24px}
.top .dot{border-radius:0;width:14px;height:14px}
.top .mark::after{content:"";display:block;width:90px;height:2px;background:${brand.accent};margin-left:10px}
.bar{border-radius:0;width:96px;height:6px}
.foot{letter-spacing:.06em;text-transform:uppercase;font-size:22px}
.slide::after{content:"";position:absolute;inset:34px;border:2px solid ${brand.text}1f;pointer-events:none}`;
}

function styleOf(brand: Brand): "vexa" | "obra" {
  return brand.style ?? "vexa";
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);
}

function imageData(file: string | null | undefined): string | null {
  if (!file) return null;
  try {
    const ext = path.extname(file).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return `data:${type};base64,${readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

/** Shrinks every [data-fit] element until its text fits its box (long titles stay inside the slide). */
const FIT_SCRIPT = `
document.fonts.ready.then(() => {
for (const el of document.querySelectorAll('[data-fit]')) {
  let size = parseFloat(getComputedStyle(el).fontSize);
  const min = parseFloat(el.dataset.fit) || 28;
  const max = parseFloat(getComputedStyle(el).maxHeight) || el.clientHeight;
  // Glyphs of big bold type stick out of a tight line-height by a few pixels; only real overflow counts.
  const over = () => el.scrollHeight > max + 10 || el.scrollWidth > el.clientWidth + 4;
  while (over() && size > min) {
    size -= 2;
    el.style.fontSize = size + 'px';
  }
}
document.body.dataset.ready = '1';
});`;

function page(brand: Brand, size: { width: number; height: number }, body: string, transparent = false): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
${fontFace(styleOf(brand) === "obra" ? "Archivo" : "Montserrat")}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${size.width}px;height:${size.height}px;overflow:hidden}
body{font-family:"Montserrat",Arial,sans-serif;background:${transparent ? "transparent" : brand.background};color:${brand.text};-webkit-font-smoothing:antialiased}
.slide{position:relative;width:100%;height:100%;overflow:hidden}
.glow{position:absolute;inset:0;background:radial-gradient(900px 700px at 110% -10%,${brand.accent}33,transparent 60%),radial-gradient(700px 600px at -20% 120%,${brand.accent}1f,transparent 60%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:90px 90px;mask-image:linear-gradient(180deg,#000 0,transparent 75%)}
.top{position:absolute;top:64px;left:80px;right:80px;display:flex;justify-content:space-between;align-items:center;font-weight:800;letter-spacing:.18em;font-size:26px}
.top .mark{display:flex;align-items:center;gap:12px}
.top .dot{width:16px;height:16px;border-radius:50%;background:${brand.accent}}
.top .count{color:${brand.muted};letter-spacing:.08em;font-weight:600}
.foot{position:absolute;bottom:60px;left:80px;right:80px;display:flex;justify-content:space-between;align-items:center;font-size:26px;font-weight:600;color:${brand.muted}}
.foot .swipe{color:${brand.accent};font-weight:800}
.accent{color:${brand.accent}}
.bar{width:120px;height:10px;border-radius:6px;background:${brand.accent};margin-bottom:40px}
${styleOf(brand) === "obra" ? obraCss(brand) : ""}
</style></head><body>${body}<script>${FIT_SCRIPT}</script></body></html>`;
}

function topBar(brand: Brand, count: string | null): string {
  return `<div class="top"><div class="mark"><span class="dot"></span>${escapeHtml(brand.wordmark)}</div>${count ? `<div class="count">${count}</div>` : ""}</div>`;
}

function footer(brand: Brand, swipe: boolean): string {
  return `<div class="foot"><span>${escapeHtml(brand.handle)}</span>${swipe ? '<span class="swipe">arrasta para o lado &rarr;</span>' : ""}</div>`;
}

function coverSlide(brand: Brand, slide: Slide, background: string | null, total: number): string {
  const bg = background
    ? `<div style="position:absolute;inset:0;background:url('${background}') center/cover"></div><div style="position:absolute;inset:0;background:linear-gradient(180deg,${brand.background}66 0%,${brand.background}22 30%,${brand.background}d9 62%,${brand.background} 100%)"></div>`
    : `<div class="glow"></div><div class="grid"></div><div style="position:absolute;right:-220px;top:180px;width:760px;height:760px;border-radius:50%;border:70px solid ${brand.accent};opacity:.9"></div>`;
  return `<div class="slide">${bg}${topBar(brand, `01/${String(total).padStart(2, "0")}`)}
<div style="position:absolute;left:80px;right:80px;bottom:170px;display:flex;flex-direction:column">
<div class="bar"></div>
<h1 data-fit="52" style="font-size:96px;line-height:1.02;font-weight:900;letter-spacing:-.02em;max-height:560px;overflow:hidden">${escapeHtml(slide.title)}</h1>
${slide.body ? `<p data-fit="26" style="margin-top:34px;font-size:38px;line-height:1.3;font-weight:500;color:${brand.muted};max-height:160px;overflow:hidden">${escapeHtml(slide.body)}</p>` : ""}
</div>${footer(brand, true)}</div>`;
}

function textSlide(brand: Brand, slide: Slide, index: number, total: number): string {
  const step = slide.kind === "step" && slide.stepNumber !== null;
  return `<div class="slide"><div class="glow"></div>${topBar(brand, `${String(index + 1).padStart(2, "0")}/${String(total).padStart(2, "0")}`)}
<div style="position:absolute;left:80px;right:80px;top:200px;bottom:170px;display:flex;flex-direction:column;justify-content:center">
${step ? `<div style="font-size:220px;line-height:.9;font-weight:900;color:transparent;-webkit-text-stroke:4px ${brand.accent};margin-bottom:30px">${String(slide.stepNumber).padStart(2, "0")}</div>` : '<div class="bar"></div>'}
<h2 data-fit="40" style="font-size:72px;line-height:1.08;font-weight:800;letter-spacing:-.015em;max-height:340px;overflow:hidden">${escapeHtml(slide.title)}</h2>
<p data-fit="26" style="margin-top:36px;font-size:42px;line-height:1.38;font-weight:500;color:#E9E5E0;max-height:420px;overflow:hidden">${escapeHtml(slide.body)}</p>
</div>${footer(brand, index < total - 1)}</div>`;
}

function quoteSlide(brand: Brand, slide: Slide, photo: string | null): string {
  const bg = photo
    ? `<div style="position:absolute;inset:0;background:url('${photo}') center 20%/cover"></div><div style="position:absolute;inset:0;background:linear-gradient(180deg,${brand.background}00 0%,${brand.background}33 35%,${brand.background}e6 66%,${brand.background} 100%)"></div>`
    : `<div class="glow"></div><div class="grid"></div>`;
  return `<div class="slide">${bg}${topBar(brand, null)}
<div style="position:absolute;left:80px;right:80px;bottom:170px">
<div style="font-size:200px;line-height:.6;font-weight:900;color:${brand.accent};height:110px">&ldquo;</div>
<h1 data-fit="44" style="font-size:80px;line-height:1.08;font-weight:800;letter-spacing:-.015em;max-height:520px;overflow:hidden">${escapeHtml(slide.title)}</h1>
<p style="margin-top:34px;font-size:34px;font-weight:700;color:${brand.accent}">${escapeHtml(slide.body || "")}</p>
</div>${footer(brand, true)}</div>`;
}

function ctaSlide(brand: Brand, slide: Slide, size: { width: number; height: number }): string {
  return `<div class="slide" style="background:${brand.accent};color:${brand.background}">
<div class="top" style="color:${brand.background}"><div class="mark"><span class="dot" style="background:${brand.background}"></span>${escapeHtml(brand.wordmark)}</div></div>
<div style="position:absolute;left:80px;right:80px;top:${size.height > 1500 ? 420 : 240}px;bottom:${size.height > 1500 ? 420 : 240}px;display:flex;flex-direction:column;justify-content:center">
<h2 data-fit="48" style="font-size:96px;line-height:1.02;font-weight:900;letter-spacing:-.02em;max-height:${size.height > 1500 ? 700 : 520}px;overflow:hidden">${escapeHtml(slide.title)}</h2>
<p data-fit="26" style="margin-top:36px;font-size:42px;line-height:1.35;font-weight:600;max-height:240px;overflow:hidden">${escapeHtml(slide.body)}</p>
<div style="margin-top:56px;align-self:flex-start;padding:22px 34px;border-radius:999px;background:${brand.background};color:${brand.text};font-size:32px;font-weight:800">${escapeHtml(brand.ctaBadge || `Chama no Direct ${brand.handle}`)}</div>
</div></div>`;
}

export interface RenderPage {
  html: string;
  file: string;
  width: number;
  height: number;
  /** Transparent PNG (video overlays); otherwise JPEG, the only image format the Instagram API accepts. */
  transparent?: boolean;
}

export function carouselPages(brand: Brand, script: CarouselScript, outDir: string, images: { cover: string | null; photo: string | null }): RenderPage[] {
  const cover = imageData(images.cover);
  const photo = imageData(images.photo);
  const total = script.slides.length;
  return script.slides.map((slide, index) => {
    let body: string;
    if (slide.kind === "cover") body = coverSlide(brand, slide, cover, total);
    else if (slide.kind === "quote") body = quoteSlide(brand, slide, photo ?? cover);
    else if (slide.kind === "cta") body = ctaSlide(brand, slide, FEED);
    else body = textSlide(brand, slide, index, total);
    return { html: page(brand, FEED, body), file: path.join(outDir, `${String(index + 1).padStart(2, "0")}.jpg`), ...FEED };
  });
}

/** A slide of the operator's photo, full bleed: tag in the corner, short text over a dark fade at the bottom. */
function photoSlide(brand: Brand, slide: PhotoSlide, photo: string | null, index: number, total: number): string {
  const bg = photo
    ? `<div style="position:absolute;inset:0;background:url('${photo}') center/cover"></div><div style="position:absolute;inset:0;background:linear-gradient(180deg,${brand.background}99 0%,${brand.background}00 22%,${brand.background}00 50%,${brand.background}e6 80%,${brand.background} 100%)"></div>`
    : `<div class="glow"></div>`;
  const tag = slide.tag.trim()
    ? `<div style="position:absolute;top:140px;left:80px;background:${/^antes$/i.test(slide.tag.trim()) ? brand.text : brand.accent};color:${brand.background};font-size:40px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;padding:10px 26px;border-radius:10px">${escapeHtml(slide.tag.trim())}</div>`
    : "";
  return `<div class="slide">${bg}${topBar(brand, `${String(index + 1).padStart(2, "0")}/${String(total).padStart(2, "0")}`)}${tag}
<div style="position:absolute;left:80px;right:80px;bottom:150px;display:flex;flex-direction:column">
${slide.title ? `<h2 data-fit="36" style="font-size:64px;line-height:1.08;font-weight:800;letter-spacing:-.015em;max-height:290px;overflow:hidden">${escapeHtml(slide.title)}</h2>` : ""}
${slide.body ? `<p data-fit="24" style="margin-top:22px;font-size:38px;line-height:1.32;font-weight:500;color:#E9E5E0;max-height:210px;overflow:hidden">${escapeHtml(slide.body)}</p>` : ""}
</div>${footer(brand, index < total - 1)}</div>`;
}

/** Carousel built on the operator's photos (`photos[i]` is photo i + 1 of the script). */
export function photoCarouselPages(brand: Brand, script: PhotoCarouselScript, outDir: string, photos: ReadonlyArray<string | null>): RenderPage[] {
  const data = photos.map((file) => imageData(file));
  const total = script.slides.length;
  return script.slides.map((slide, index) => {
    const photo = slide.photo ? (data[slide.photo - 1] ?? null) : null;
    const plain: Slide = { kind: slide.kind === "photo" ? "text" : slide.kind, title: slide.title, body: slide.body, stepNumber: null };
    let body: string;
    if (slide.kind === "cover") body = coverSlide(brand, plain, photo, total);
    else if (slide.kind === "photo") body = photoSlide(brand, slide, photo, index, total);
    else if (slide.kind === "cta") body = ctaSlide(brand, plain, FEED);
    else body = textSlide(brand, plain, index, total);
    return { html: page(brand, FEED, body), file: path.join(outDir, `${String(index + 1).padStart(2, "0")}.jpg`), ...FEED };
  });
}

/**
 * Splits a narration into short subtitle chunks (about 3 to 6 words), the way story Reels show
 * them: one short line at a time, in the rhythm of the voice.
 */
const DANGLING = /^(o|a|os|as|um|uma|de|do|da|dos|das|e|que|em|no|na|nos|nas|por|pra|pro|com|se|ao|à|seu|sua)$/i;

export function subtitleChunks(narration: string, maxWords = 5): string[] {
  const words = narration.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];
  for (const word of words) {
    current.push(word);
    const endsPhrase = /[.!?;:,]$/.test(word) && current.length >= 2;
    if (current.length >= maxWords || endsPhrase) {
      // A line never ends on a small word ("o", "de", "que"): it moves to the next line.
      const carry = !endsPhrase && current.length > 2 && DANGLING.test(current[current.length - 1]) ? [current.pop() as string] : [];
      chunks.push(current.join(" "));
      current = carry;
    }
  }
  if (current.length > 0) {
    // A lone last word joins the previous chunk instead of flashing by alone.
    if (current.length === 1 && chunks.length > 0 && chunks[chunks.length - 1].split(" ").length < maxWords + 2) chunks[chunks.length - 1] += ` ${current[0]}`;
    else chunks.push(current.join(" "));
  }
  return chunks;
}

/**
 * Boxed text, the account's signature look: each line sits in its own solid box (uppercase,
 * heavy type), readable over any scene and recognizable in the feed with the sound off.
 */
function boxed(text: string, colors: { box: string; ink: string }): string {
  // Size and line height come from the parent, so [data-fit] can shrink it.
  return `<span style="display:inline;background:${colors.box};color:${colors.ink};font-weight:900;text-transform:uppercase;letter-spacing:-.01em;padding:.06em .3em;border-radius:12px;-webkit-box-decoration-break:clone;box-decoration-break:clone">${escapeHtml(text)}</span>`;
}

function tagPill(brand: Brand, tag: string, size = 40): string {
  return `<div style="display:inline-block;margin-bottom:26px;padding:12px 26px;border-radius:999px;background:${brand.accent};color:${brand.background};font-size:${size}px;font-weight:900;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(tag)}</div>`;
}

/** Big hook in the first seconds: white boxes with dark type, and "PARTE N" in a novela. */
function hookBody(brand: Brand, hook: string, tag: string | null): string {
  return `<div class="slide"><div style="position:absolute;left:70px;right:70px;top:300px;text-align:center">
${tag ? tagPill(brand, tag) : ""}
<p data-fit="44" style="max-height:560px;overflow:hidden;font-size:84px;line-height:1.42">${boxed(hook, { box: brand.text, ink: brand.background })}</p></div></div>`;
}

/** One subtitle chunk, lower third, in the brand's orange box. */
function subtitleBody(brand: Brand, text: string): string {
  return `<div class="slide"><div style="position:absolute;left:70px;right:70px;bottom:560px;display:flex;justify-content:center">
<p data-fit="40" style="max-height:280px;overflow:hidden;text-align:center;font-size:66px;line-height:1.42">${boxed(text, { box: brand.accent, ink: brand.background })}</p></div></div>`;
}

/** Header kept on top of the whole video: what it is about, for anyone who lands in the middle. */
function titleBody(brand: Brand, title: string): string {
  return `<div class="slide"><div style="position:absolute;left:70px;right:70px;top:120px;display:flex;justify-content:center">
<div data-fit="30" style="max-height:170px;overflow:hidden;padding:20px 34px;border-radius:22px;background:${brand.background}d9;border-left:10px solid ${brand.accent};font-size:46px;line-height:1.12;font-weight:900;text-align:center">${escapeHtml(title)}</div></div></div>`;
}

/** Call to action badge over the end of the last scene (no static end card: the video loops). */
function ctaBadgeBody(brand: Brand, cta: string): string {
  return `<div class="slide"><div style="position:absolute;left:70px;right:70px;top:340px;display:flex;justify-content:center">
<div data-fit="30" style="max-height:220px;overflow:hidden;padding:28px 40px;border-radius:999px;background:${brand.accent};color:${brand.background};font-size:46px;line-height:1.15;font-weight:900;text-align:center">${escapeHtml(cta)}</div></div></div>`;
}

/** Brand background used when a scene has no clip and no character portrait. */
function fallbackBody(brand: Brand): string {
  return `<div class="slide"><div class="glow"></div><div class="grid"></div>${topBar(brand, null)}${footer(brand, false)}</div>`;
}

export interface ReelPages {
  hook: RenderPage;
  title: RenderPage;
  /** Subtitle chunks of each scene, in order. */
  subtitles: RenderPage[][];
  cta: RenderPage;
  fallback: RenderPage;
}

export interface ReelText {
  hook: string;
  /** "Parte 3" in a novela episode, otherwise null. */
  tag: string | null;
  title: string;
  chunks: readonly (readonly string[])[];
  /** Badge over the end of the last scene. */
  ending: string;
}

export function reelPages(brand: Brand, text: ReelText, outDir: string): ReelPages {
  const png = (name: string, body: string): RenderPage => ({ html: page(brand, STORY, body, true), file: path.join(outDir, name), ...STORY, transparent: true });
  return {
    hook: png("hook.png", hookBody(brand, text.hook, text.tag)),
    title: png("title.png", titleBody(brand, text.tag ? `${text.tag} · ${text.title}` : text.title)),
    subtitles: text.chunks.map((scene, sceneIndex) => scene.map((chunk, index) => png(`sub-${sceneIndex + 1}-${index + 1}.png`, subtitleBody(brand, chunk)))),
    cta: png("cta.png", ctaBadgeBody(brand, text.ending)),
    fallback: { html: page(brand, STORY, fallbackBody(brand)), file: path.join(outDir, "fallback.jpg"), ...STORY },
  };
}

/**
 * The Reel's cover (thumbnail): a frame of the video darkened, the hook in big boxed type in the
 * middle (inside the 4:5 and 1:1 crops of the profile grid) and, in a novela, the part number.
 */
export function reelCoverPage(brand: Brand, cover: { hook: string; tag: string | null; series: string | null; background: string | null }, file: string): RenderPage {
  const image = imageData(cover.background);
  const bg = image
    ? `<div style="position:absolute;inset:0;background:url('${image}') center/cover"></div><div style="position:absolute;inset:0;background:linear-gradient(180deg,${brand.background}b3 0%,${brand.background}59 35%,${brand.background}59 65%,${brand.background}d9 100%)"></div>`
    : `<div class="glow"></div><div class="grid"></div>`;
  const body = `<div class="slide">${bg}
<div style="position:absolute;left:70px;right:70px;top:480px;height:960px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center">
${cover.tag ? tagPill(brand, cover.tag, 48) : ""}
<p data-fit="52" style="max-height:700px;overflow:hidden;font-size:104px;line-height:1.42">${boxed(cover.hook, { box: brand.text, ink: brand.background })}</p>
${cover.series ? `<p style="margin-top:30px;font-size:38px;font-weight:800;color:${brand.accent};letter-spacing:.04em">${escapeHtml(cover.series)}</p>` : ""}
</div>${footer(brand, false)}</div>`;
  return { html: page(brand, STORY, body), file, ...STORY };
}

/** Renders the pages in one invisible Chrome and writes each file. */
export async function renderPages(env: Env, pages: readonly RenderPage[]): Promise<string[]> {
  const executablePath = findWebBrowser(env);
  if (!executablePath) throw new WebBrowserUnavailableError("Chrome not found to draw the posts; set WEB_BROWSER_PATH");
  const args = ["--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--font-render-hinting=none"];
  if (process.platform === "linux") args.push("--no-sandbox", "--disable-dev-shm-usage");
  const browser = await chromium.launch({ executablePath, headless: true, args });
  try {
    const written: string[] = [];
    for (const item of pages) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, deviceScaleFactor: 1 });
      const tab = await context.newPage();
      await tab.setContent(item.html, { waitUntil: "load" });
      await tab.evaluate(() => document.fonts.ready.then(() => true));
      await tab.waitForFunction(() => document.body.dataset.ready === "1", undefined, { timeout: 10_000 }).catch(() => undefined);
      await tab.screenshot({
        path: item.file,
        type: item.transparent ? "png" : "jpeg",
        ...(item.transparent ? { omitBackground: true } : { quality: 92 }),
        clip: { x: 0, y: 0, width: item.width, height: item.height },
      });
      await context.close();
      written.push(item.file);
    }
    return written;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
