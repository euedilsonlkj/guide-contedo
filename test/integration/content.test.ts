import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { alerts, contentPosts, geminiRuns, jobs, type ContentPost } from "@/db/schema";
import { getSetting, setSetting } from "@/core/settings";
import { absoluteFromRoot, verifyMediaToken } from "@/content/files";
import { planContentWork } from "@/content/planner";
import { attachSeriesPortrait, createPhotoPost, getPost, movePost, nextFreeDay, PanelInputError, runContentPlan, runContentWrite, updatePost, type SentPhoto } from "@/content/posts";
import { localClock } from "@/lib/time";
import { zonedInstant } from "@/content/schedule";
import { claimNextJob, type Lane } from "@/core/queue";
import { runJob, type WorkerContext } from "@/core/runner";
import { launchTestChrome, type TestChrome } from "../fakes/chrome";
import { startFakeGemini, type FakeGemini } from "../fakes/fake-gemini-web";
import { startFakeOpenAI, type FakeOpenAI } from "../fakes/fake-openai";
import { createTestDb, testContext } from "../helpers";

const ACCOUNT_ID = "17840000000000000";

/** Meta's publishing endpoints, plus the public media route the tunnel would serve. */
interface FakeMeta {
  origin: string;
  graphUrl: string;
  containers: Array<{ id: string; params: Record<string, string> }>;
  published: string[];
  downloaded: string[];
  close: () => Promise<void>;
}

async function startFakeMeta(contentDir: () => string): Promise<FakeMeta> {
  const containers: FakeMeta["containers"] = [];
  const published: string[] = [];
  const downloaded: string[] = [];
  const key = "a".repeat(64);
  let origin = "";
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      // Public media route (what the panel serves through the tunnel).
      const media = /^\/api\/content\/media\/([0-9a-f]+)\/(.+)$/.exec(url.pathname);
      if (media) {
        const relative = media[2].split("/").map(decodeURIComponent).join("/");
        if (!verifyMediaToken({ STATE_ENCRYPTION_KEY: key }, relative, media[1])) return res.writeHead(404).end();
        const file = absoluteFromRoot({ CONTENT_DIR: contentDir() }, relative);
        if (!file || !existsSync(file)) return res.writeHead(404).end();
        if (req.method === "GET") downloaded.push(relative);
        return res.writeHead(200).end(req.method === "HEAD" ? undefined : readFileSync(file));
      }
      if (req.headers.authorization !== "Bearer token-test") return json(401, { error: { message: "bad token", code: 190 } });
      const params = Object.fromEntries(new URLSearchParams(raw));
      if (req.method === "POST" && url.pathname.endsWith(`/${ACCOUNT_ID}/media`)) {
        // Meta downloads the file before the container is ready.
        const fileUrl = params.image_url ?? params.video_url;
        if (fileUrl && !(await fetch(fileUrl)).ok) return json(400, { error: { message: "media download failed", code: 9004 } });
        const id = `c${containers.length + 1}`;
        containers.push({ id, params });
        return json(200, { id });
      }
      if (req.method === "POST" && url.pathname.endsWith(`/${ACCOUNT_ID}/media_publish`)) {
        published.push(params.creation_id);
        return json(200, { id: `m${published.length}` });
      }
      if (req.method === "GET" && /\/c\d+$/.test(url.pathname)) return json(200, { status_code: "FINISHED" });
      if (req.method === "GET" && /\/m\d+\/insights$/.test(url.pathname)) {
        const metric = url.searchParams.get("metric") ?? "";
        const values: Record<string, number> = { views: 4200, reach: 3100, shares: 37, saved: 52, total_interactions: 310 };
        return json(200, { data: metric.split(",").map((name) => ({ name, values: [{ value: values[name] ?? 0 }] })) });
      }
      if (req.method === "GET" && /\/m\d+$/.test(url.pathname)) return json(200, { permalink: `https://www.instagram.com/p/${url.pathname.split("/").pop()}/` });
      return json(404, { error: { message: "unknown", code: 100 } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, graphUrl: `${origin}/v25.0`, containers, published, downloaded, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

let chrome: TestChrome;
let gemini: FakeGemini;
let openai: FakeOpenAI;
let meta: FakeMeta;
let mediaDir: string;
let contentDir: string;

beforeAll(async () => {
  mediaDir = mkdtempSync(path.join(os.tmpdir(), "gemini-media-"));
  const image = path.join(mediaDir, "image.png");
  const video = path.join(mediaDir, "clip.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x553311:s=800x1000", "-frames:v", "1", image]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=720x1280:r=24:d=3", "-f", "lavfi", "-i", "sine=f=330:d=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
  const speech = path.join(mediaDir, "voz.mp3");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=220:d=4", "-c:a", "libmp3lame", speech]);
  [gemini, openai, meta] = await Promise.all([startFakeGemini({ image, video }), startFakeOpenAI(speech), startFakeMeta(() => contentDir)]);
  chrome = await launchTestChrome();
}, 90_000);

afterAll(async () => {
  await chrome?.close();
  await Promise.all([gemini?.close(), openai?.close(), meta?.close()]);
  rmSync(mediaDir, { recursive: true, force: true });
});

beforeEach(() => {
  contentDir = mkdtempSync(path.join(os.tmpdir(), "content-"));
});

function context(db: Db, overrides: Record<string, string | undefined> = {}): WorkerContext {
  return testContext(db, {
    OPENAI_BASE_URL: openai.baseUrl,
    GEMINI_CDP_URL: chrome.cdpUrl,
    GEMINI_ORIGIN: gemini.origin,
    CONTENT_DIR: contentDir,
    CONTENT_PUBLIC_BASE_URL: meta.origin,
    INSTAGRAM_GRAPH_BASE_URL: meta.graphUrl,
    FFMPEG_PATH: "ffmpeg",
    ...overrides,
  });
}

/** Runs every due job of a lane, like the worker loop. */
async function drain(ctx: WorkerContext, lane: Lane): Promise<number> {
  let count = 0;
  for (;;) {
    const job = claimNextJob(ctx.db, lane);
    if (!job) return count;
    await runJob(ctx, job);
    count += 1;
  }
}

/** Planner tick at `now`, then the jobs it queued. */
async function step(ctx: WorkerContext, now: Date): Promise<string> {
  const result = planContentWork(ctx.db, ctx.env, ctx.config, now);
  // The week was planned by the test itself; a shifted "now" must not plan extra posts here.
  ctx.db.update(jobs).set({ status: "cancelled" }).where(and(eq(jobs.type, "content_plan"), eq(jobs.status, "pending"))).run();
  await drain(ctx, "content");
  await drain(ctx, "gemini");
  return result;
}

/** Tomorrow at 06:00 local: a 7-day window from there holds every weekday once, whatever the time the tests run. */
function earlyTomorrow(timeZone: string): Date {
  return zonedInstant(localClock(new Date(Date.now() + 24 * 3600_000), timeZone).dateKey, "06:00", timeZone);
}

function posts(db: Db, kind?: ContentPost["kind"]): ContentPost[] {
  const rows = db.select().from(contentPosts).orderBy(asc(contentPosts.scheduledAt)).all();
  return kind ? rows.filter((post) => post.kind === kind) : rows;
}

/** Keeps only this post active, so the planner ticks act on it alone. */
function only(db: Db, id: number): void {
  for (const post of posts(db)) if (post.id !== id) updatePost(db, post.id, { status: "skipped" });
}

describe("content arm", () => {
  it("plans the coming week with varied pillars and never plans a slot twice", async () => {
    const ctx = context(createTestDb());
    const now = earlyTomorrow(ctx.env.TIME_ZONE);
    await runContentPlan(ctx.db, ctx.env, ctx.config, now);
    const week = posts(ctx.db);
    expect(week.length).toBe(6);
    expect(week.filter((post) => post.kind === "carousel")).toHaveLength(3);
    for (let i = 1; i < week.length; i += 1) expect(week[i].pillar).not.toBe(week[i - 1].pillar);
    for (const post of week) expect(post.kind === "carousel" ? ["passos", "frase"] : ["passos", "dia"]).toContain(post.pillar);
    expect(new Set(week.map((post) => post.topic)).size).toBe(6);
    // Every post opens with a kind of viral hook, rotated, and the AI is told which one.
    for (const post of week) expect(post.hookType).toBeTruthy();
    for (let i = 1; i < week.length; i += 1) expect(week[i].hookType).not.toBe(week[i - 1].hookType);
    expect(openai.requests.filter((request) => request.schema === "content_plan").at(-1)?.input).toContain('| hook type ');
    // Reels rotate viral formats; the novela episodes are numbered in order.
    const reels = week.filter((post) => post.kind === "reel");
    for (const post of reels) expect(["novela", "errado"]).toContain(post.format);
    for (const post of week.filter((item) => item.kind === "carousel")) expect(post.format).toBeNull();
    expect(reels.filter((post) => post.format === "novela").map((post) => post.episode)).toEqual([1, 2]);
    const again = await runContentPlan(ctx.db, ctx.env, ctx.config, now);
    expect(again.detail).toBe("week already planned");
    expect(posts(ctx.db)).toHaveLength(6);
  });

  it("takes a carousel from topic to Instagram: write, Gemini cover, slides, publish", async () => {
    const ctx = context(createTestDb());
    await runContentPlan(ctx.db, ctx.env, ctx.config);
    const post = posts(ctx.db, "carousel").find((item) => item.pillar === "passos") as ContentPost;
    only(ctx.db, post.id);
    const before = new Date(post.scheduledAt.getTime() - 24 * 3600_000);

    await step(ctx, before);
    expect(getPost(ctx.db, post.id)?.status).toBe("written");
    await step(ctx, before);
    const withImage = getPost(ctx.db, post.id) as ContentPost;
    expect(withImage.media.image).toMatch(/gemini\/capa\.png$/);
    expect(gemini.prompts.at(-1)).toMatchObject({ tool: "image" });
    expect(gemini.prompts.at(-1)?.prompt).toContain("no text");

    await step(ctx, before); // media_ready
    await step(ctx, before); // render
    const ready = getPost(ctx.db, post.id) as ContentPost;
    expect(ready.status).toBe("ready");
    expect(ready.media.slides).toHaveLength(5);
    for (const slide of ready.media.slides ?? []) expect(existsSync(absoluteFromRoot(ctx.env, slide) as string)).toBe(true);

    // Not before its time.
    await step(ctx, before);
    expect(getPost(ctx.db, post.id)?.status).toBe("ready");

    updatePost(ctx.db, post.id, { scheduledAt: new Date(Date.now() - 60_000) });
    await step(ctx, new Date());
    const done = getPost(ctx.db, post.id) as ContentPost;
    expect(done.status).toBe("published");
    expect(done.permalink).toMatch(/instagram\.com\/p\//);
    const carousel = meta.containers.find((container) => container.params.media_type === "CAROUSEL");
    expect(carousel?.params.children.split(",")).toHaveLength(5);
    expect(carousel?.params.caption).toContain("\n\n#esquadrias #vendas");
    expect(meta.downloaded.filter((file) => file.startsWith(`posts/${post.id}/slides/`))).toHaveLength(5);
  });

  it("makes a short Reel: the series character, scenes within Gemini's limit, voice, subtitles and cover", async () => {
    // Two Gemini accounts (both in the test Chrome).
    const ctx = context(createTestDb(), { GEMINI_CDP_URLS: `${chrome.cdpUrl},${chrome.cdpUrl}` });
    await runContentPlan(ctx.db, ctx.env, ctx.config);
    const post = posts(ctx.db, "reel").find((item) => item.format === "novela") as ContentPost;
    expect(post.episode).toBe(1);
    only(ctx.db, post.id);
    const before = new Date(post.scheduledAt.getTime() - 24 * 3600_000);
    await step(ctx, before);
    const written = getPost(ctx.db, post.id) as ContentPost;
    expect(written.media.clips).toEqual([null, null]);
    expect(openai.requests.filter((request) => request.schema === "reel").at(-1)?.instructions).toContain("PARTE 1");
    expect(written.caption).toBeTruthy();
    // An editor reviewed the first draft and the writer rewrote it with the notes.
    const reels = openai.requests.filter((request) => request.schema === "reel");
    expect(reels.at(-1)?.input).toContain("scene 3 shows no result");
    expect(openai.requests.filter((request) => request.schema === "reel_review").length).toBeGreaterThanOrEqual(2);

    // The series portrait comes first, once: it is kept for every next Reel.
    await step(ctx, before);
    expect(getPost(ctx.db, post.id)?.media.character).toBe("serie/personagem.png");
    expect(gemini.prompts.at(-1)).toMatchObject({ tool: "image", attached: false });
    expect(gemini.prompts.at(-1)?.prompt).toContain("navy polo shirt");

    // Account 1 says the daily limit is over: the same scene goes to account 2 right away.
    gemini.limitNext();
    await step(ctx, before);
    expect(getSetting(ctx.db, "gemini_blocks")["1"]?.video).not.toBeNull();
    expect(getPost(ctx.db, post.id)?.media.clips?.[0]).toMatch(/cena-1\.mp4$/);
    expect(ctx.db.select().from(geminiRuns).where(eq(geminiRuns.status, "done")).all().at(-1)?.account).toBe("2");

    // Account 2 is over too: nothing more is asked until tomorrow.
    gemini.limitNext();
    await step(ctx, before);
    expect(getSetting(ctx.db, "gemini_blocks")["2"]?.video).not.toBeNull();
    const asked = gemini.prompts.length;
    await step(ctx, before);
    expect(gemini.prompts.length).toBe(asked);
    setSetting(ctx.db, "gemini_blocks", {});
    // Every scene is made from the same portrait.
    expect(gemini.prompts.at(-1)).toMatchObject({ tool: "video", attached: true });

    // Scene 2 refused twice: the Reel goes on with a slow zoom on the portrait in its place.
    gemini.refuseNext();
    await step(ctx, before);
    gemini.refuseNext();
    await step(ctx, before);
    expect(getPost(ctx.db, post.id)?.media.clipsGivenUp).toEqual([1]);
    expect(ctx.db.select().from(geminiRuns).where(and(eq(geminiRuns.postId, post.id), eq(geminiRuns.status, "failed"))).all()).toHaveLength(2);

    await step(ctx, before); // media_ready
    await step(ctx, before); // narrate and render
    const ready = getPost(ctx.db, post.id) as ContentPost;
    expect(ready.status).toBe("ready");
    expect(ready.media.narration).toHaveLength(2);
    expect(existsSync(absoluteFromRoot(ctx.env, ready.media.cover as string) as string)).toBe(true);
    expect(openai.speech.slice(-2).map((item) => item.voice)).toEqual(["ash", "ash"]);
    expect(openai.speech.at(-2)?.input).toContain("Marcos");
    const video = absoluteFromRoot(ctx.env, ready.media.video as string) as string;
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "csv=p=0", video]).toString();
    expect(probe).toContain("h264,1080,1920");
    expect(probe).toContain("aac");
    // Two scenes cut to the voice (4 s sped up 1.08x, plus a short tail), no static end card.
    const duration = Number(probe.trim().split("\n").at(-1));
    expect(duration).toBeGreaterThan(6.5);
    expect(duration).toBeLessThan(9);

    updatePost(ctx.db, post.id, { scheduledAt: new Date(Date.now() - 60_000) });
    await step(ctx, new Date());
    expect(getPost(ctx.db, post.id)?.status).toBe("published");
    expect(meta.containers.at(-1)?.params).toMatchObject({ media_type: "REELS", share_to_feed: "true" });
    expect(meta.containers.at(-1)?.params.cover_url).toContain(`posts/${post.id}/capa.jpg`);

    // The next Reel reuses the portrait: Gemini is not asked for it again.
    const second = posts(ctx.db, "reel").find((item) => item.id !== post.id) as ContentPost;
    updatePost(ctx.db, second.id, { status: "written", script: written.script, media: { clips: [null, null] } });
    expect(attachSeriesPortrait(ctx.db, ctx.env, getPost(ctx.db, second.id) as ContentPost).media.character).toBe("serie/personagem.png");
  }, 240_000);

  it("never draws a Reel without its clips, even past its time", async () => {
    const ctx = context(createTestDb());
    await runContentPlan(ctx.db, ctx.env, ctx.config);
    const post = posts(ctx.db, "reel")[0];
    only(ctx.db, post.id);
    // Rewritten by the operator after its time had already passed.
    updatePost(ctx.db, post.id, { scheduledAt: new Date(Date.now() - 3600_000) });
    await step(ctx, new Date());
    expect(getPost(ctx.db, post.id)?.status).toBe("written");
    planContentWork(ctx.db, ctx.env, ctx.config);
    expect(getPost(ctx.db, post.id)?.status).toBe("written");
    expect(ctx.db.select().from(jobs).where(and(eq(jobs.type, "gemini_image"), eq(jobs.status, "pending"))).all()).toHaveLength(1);

    // Gemini refused every scene: the Reel stops for the operator instead of going out as a photo.
    updatePost(ctx.db, post.id, { media: { ...getPost(ctx.db, post.id)?.media, character: "serie/personagem.png", clips: [null, null], clipsGivenUp: [0, 1] } });
    planContentWork(ctx.db, ctx.env, ctx.config);
    expect(getPost(ctx.db, post.id)?.status).toBe("failed");
  });

  it("measures published posts and plans the next ones from what worked", async () => {
    const ctx = context(createTestDb());
    const published = ctx.db
      .insert(contentPosts)
      .values({ account: "principal", kind: "reel", pillar: "dia", scheduledAt: new Date(Date.now() - 3 * 86_400_000), publishedAt: new Date(Date.now() - 3 * 86_400_000), status: "published", topic: "Cliente sumiu", hook: "Ele perdeu a obra em 3 dias", igMediaId: "m42" })
      .returning()
      .get();
    planContentWork(ctx.db, ctx.env, ctx.config);
    ctx.db.update(jobs).set({ status: "cancelled" }).where(and(eq(jobs.type, "content_plan"), eq(jobs.status, "pending"))).run();
    await drain(ctx, "content");
    expect(getPost(ctx.db, published.id)?.metrics).toEqual({ views: 4200, reach: 3100, shares: 37, saved: 52, interactions: 310 });
    // Not measured again right away.
    planContentWork(ctx.db, ctx.env, ctx.config);
    expect(ctx.db.select().from(jobs).where(and(eq(jobs.type, "content_insights"), eq(jobs.status, "pending"))).all()).toHaveLength(0);

    for (const [hook, views] of [["Gancho fraco", 120], ["Outro gancho", 900]] as const) {
      ctx.db
        .insert(contentPosts)
        .values({ account: "principal", kind: "carousel", pillar: "passos", scheduledAt: new Date(Date.now() - 5 * 86_400_000 - views), status: "published", topic: hook, hook, publishedAt: new Date(Date.now() - 5 * 86_400_000), metrics: { views, reach: views, shares: 0, saved: 1, interactions: 5 }, metricsAt: new Date() })
        .run();
    }
    await runContentPlan(ctx.db, ctx.env, ctx.config);
    const plan = openai.requests.filter((request) => request.schema === "content_plan").at(-1);
    expect(plan?.input).toContain("WHAT WORKED BEST");
    expect(plan?.input.indexOf("Ele perdeu a obra em 3 dias")).toBeLessThan(plan?.input.indexOf("WHAT WORKED WORST") ?? 0);
  });

  it("rewrites a draft that breaks the rules and never stores a long dash", async () => {
    const ctx = context(createTestDb());
    const post = ctx.db
      .insert(contentPosts)
      .values({ account: "principal", kind: "carousel", pillar: "passos", scheduledAt: new Date(Date.now() + 3600_000), topic: "DASH orçamento", hook: "x" })
      .returning()
      .get();
    const outcome = await runContentWrite(ctx.db, ctx.env, ctx.config, { payload: { postId: post.id } } as never);
    expect(outcome.status).toBe("done");
    const written = getPost(ctx.db, post.id) as ContentPost;
    expect(JSON.stringify(written.script)).not.toMatch(/[—–]/);
    expect(openai.requests.filter((request) => request.schema === "carousel" && request.input.includes("rejected"))).toHaveLength(1);
  });

  it("waits with an alert when the account has no Meta token, and skips posts whose day passed", async () => {
    const ctx = context(createTestDb(), { INSTAGRAM_TOKEN: "" });
    await runContentPlan(ctx.db, ctx.env, ctx.config);
    const post = posts(ctx.db, "carousel")[0];
    only(ctx.db, post.id);
    updatePost(ctx.db, post.id, { status: "ready", media: { slides: ["posts/1/slides/01.jpg"] }, script: {}, scheduledAt: new Date(Date.now() - 60_000) });
    await step(ctx, new Date());
    expect(getPost(ctx.db, post.id)?.status).toBe("ready");
    expect(getPost(ctx.db, post.id)?.error).toContain("token da Meta");
    expect(ctx.db.select().from(alerts).all().some((alert) => alert.code === "content_meta_missing")).toBe(true);
    expect(ctx.db.select().from(jobs).where(eq(jobs.type, "content_publish")).get()?.status).toBe("pending");

    planContentWork(ctx.db, ctx.env, ctx.config, new Date(Date.now() + 11 * 3600_000));
    expect(getPost(ctx.db, post.id)?.status).toBe("skipped");
  });

  /** Three small JPEGs standing for the operator's photos (before, after, detail). */
  function ownPhotos(): SentPhoto[] {
    return (["antes", "depois", "detalhe"] as const).map((label, index) => {
      const file = path.join(mediaDir, `foto-${index}.jpg`);
      if (!existsSync(file)) execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x${["224466", "446622", "662244"][index]}:s=600x750`, "-frames:v", "1", file]);
      return { data: readFileSync(file), label };
    });
  }

  it("makes a carousel from the operator's photos: the AI sees them, the slides use them, it goes out", async () => {
    const ctx = context(createTestDb());
    const asked = gemini.prompts.length;
    const post = createPhotoPost(ctx.db, ctx.env, ctx.config, { type: "antes_depois", note: "Varanda com guarda-corpo de vidro na torre.", kind: "carousel", when: "now", photos: ownPhotos() });
    expect(post.origin).toBe("photos");
    expect(post.brief?.photos.map((photo) => photo.label)).toEqual(["antes", "depois", "detalhe"]);

    await step(ctx, new Date()); // written right away, whatever the time
    const written = getPost(ctx.db, post.id) as ContentPost;
    expect(written.status).toBe("written");
    expect(written.topic).toBe("Antes e depois da varanda");
    const request = openai.requests.filter((item) => item.schema === "photo_carousel").at(-1);
    expect(request?.images).toBe(3);
    expect(request?.instructions).toContain("Foto 1 (antes)");
    expect(request?.instructions).toContain("Varanda com guarda-corpo de vidro na torre.");

    await step(ctx, new Date()); // media_ready, no Gemini
    await step(ctx, new Date()); // render
    const ready = getPost(ctx.db, post.id) as ContentPost;
    expect(ready.status).toBe("ready");
    expect(ready.media.slides).toHaveLength(5);
    expect(gemini.prompts.length).toBe(asked);

    await step(ctx, new Date());
    expect(getPost(ctx.db, post.id)?.status).toBe("published");
  }, 120_000);

  it("makes a narrated Reel from the photos even with the Reels of the plan turned off", async () => {
    const ctx = context(createTestDb());
    const tomorrow = localClock(new Date(Date.now() + 24 * 3600_000), ctx.env.TIME_ZONE).dateKey;
    const post = createPhotoPost(ctx.db, ctx.env, { ...ctx.config, reelDays: [] }, { type: "obra_entregue", note: "", kind: "reel", when: "date", date: tomorrow, photos: ownPhotos() });
    const config = { ...ctx.config, reelDays: [] };
    const run = async () => {
      planContentWork(ctx.db, ctx.env, config, new Date());
      await drain(ctx, "content");
    };
    await run(); // write
    expect(getPost(ctx.db, post.id)?.media.stills).toHaveLength(3);
    await run(); // media_ready
    await run(); // narrate and draw
    const ready = getPost(ctx.db, post.id) as ContentPost;
    expect(ready.status).toBe("ready");
    expect(existsSync(absoluteFromRoot(ctx.env, ready.media.video as string) as string)).toBe(true);
    expect(existsSync(absoluteFromRoot(ctx.env, ready.media.cover as string) as string)).toBe(true);
  }, 180_000);

  it("puts photos in a planned slot, swaps posts when moving one, and finds the next free day", async () => {
    const ctx = context(createTestDb());
    await runContentPlan(ctx.db, ctx.env, ctx.config, earlyTomorrow(ctx.env.TIME_ZONE));
    const [first, second] = posts(ctx.db, "carousel");
    const day = (post: ContentPost) => localClock(post.scheduledAt, ctx.env.TIME_ZONE).dateKey;

    const photo = createPhotoPost(ctx.db, ctx.env, ctx.config, { type: "obra_entregue", note: "Sala com porta de correr.", kind: "carousel", when: "date", date: day(first), time: ctx.config.carouselTime, photos: ownPhotos() });
    expect(photo.id).toBe(first.id);
    expect(photo.origin).toBe("photos");
    expect(posts(ctx.db, "carousel")).toHaveLength(3);
    expect(() => createPhotoPost(ctx.db, ctx.env, ctx.config, { type: "obra_entregue", note: "", kind: "carousel", when: "date", date: day(first), time: ctx.config.carouselTime, photos: ownPhotos() })).toThrow(PanelInputError);

    movePost(ctx.db, ctx.env, ctx.config, second.id, day(first), ctx.config.carouselTime);
    expect(getPost(ctx.db, second.id)?.scheduledAt.getTime()).toBe(first.scheduledAt.getTime());
    expect(getPost(ctx.db, photo.id)?.scheduledAt.getTime()).toBe(second.scheduledAt.getTime());

    updatePost(ctx.db, second.id, { status: "published" });
    expect(() => movePost(ctx.db, ctx.env, ctx.config, photo.id, day(first), ctx.config.carouselTime)).toThrow(PanelInputError);
    expect(() => movePost(ctx.db, ctx.env, ctx.config, photo.id, "2020-01-01", "10:00")).toThrow(PanelInputError);

    const free = nextFreeDay(ctx.db, ctx.config, ctx.env.TIME_ZONE);
    const taken = new Set(posts(ctx.db).filter((post) => post.status !== "skipped").map(day));
    expect(taken.has(localClock(free, ctx.env.TIME_ZONE).dateKey)).toBe(false);
    expect(free.getTime()).toBeGreaterThan(Date.now());
  });
});
