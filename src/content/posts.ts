import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { raiseAlert, recordEvent } from "@/core/journal";
import { contentPosts, geminiRuns, jobs, PHOTO_LABELS, type ContentMedia, type ContentPost, type Job, type PhotoBrief, type PhotoLabel } from "@/db/schema";
import { getSetting, setSetting } from "@/core/settings";
import { BrowserUnavailableError, generateWithGemini, GeminiStateError, type GeminiMedia } from "@/integrations/gemini/web";
import { synthesizeSpeech } from "@/integrations/openai/speech";
import { fetchInsights, hasMetaCredentials, MetaApiError, MetaNotConfiguredError, publishCarousel, publishReel } from "@/integrations/instagram/publish";
import type { ContentConfig as BusinessConfig } from "@/lib/config";
import type { Env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { DAY_MS, HOUR_MS, localClock, MINUTE_MS } from "@/lib/time";
import { enqueueJob, type JobKind } from "@/core/queue";
import { ContentRejectedError, finalCaption, formatOf, MAX_PHOTOS, planTopics, writePhotoPost, writePostScript, type CarouselScript, type EpisodeSummary, type PhotoCarouselScript, type PhotoReelScript, type RecentPost, type ReelScript } from "./ai";
import { learnedFormats, learnedHookTypes, learnedPillars, measuredPosts, performanceBrief } from "./learning";
import { absoluteFromRoot, mediaPath, ownerPhotos, postDir, publicBaseUrl, relativeToRoot, seriesDir, seriesPortrait } from "./files";
import { carouselPages, photoCarouselPages, reelCoverPage, reelPages, renderPages, subtitleChunks } from "./render";
import { assignFormats, assignHookTypes, assignPillars, upcomingSlots, zonedInstant, type ContentConfig, type Pillar } from "./schedule";
import { buildStoryReel, extractFrame, mediaDuration, prepareNarration, sceneSeconds, subtitleTimings, type StoryScene, type TimedOverlay } from "./video";

/**
 * The content arm, job by job: plan the coming days, write each post, ask Gemini for the
 * cover photo or the Reel clips, draw the final files and publish at the scheduled time.
 * Each step moves the post one status ahead; the planner (planner.ts) decides what runs next.
 */

export type ContentOutcome = { status: "done" | "skipped" | "failed"; detail: string } | { status: "deferred"; detail: string; retryAt: Date };

const later = (ms: number) => new Date(Date.now() + ms);
const done = (detail: string): ContentOutcome => ({ status: "done", detail });

/** Gemini attempts per image or clip before the post goes on without it. */
export const GEMINI_ATTEMPTS = 2;
const IMAGE_TIMEOUT_MS = 4 * MINUTE_MS;
const VIDEO_TIMEOUT_MS = 9 * MINUTE_MS;

export function contentOf(config: BusinessConfig): ContentConfig | null {
  return config.enabled ? config : null;
}

export function pillarOf(content: ContentConfig, key: string): Pillar | undefined {
  return content.pillars.find((pillar) => pillar.key === key);
}

export function getPost(db: Executor, id: number): ContentPost | undefined {
  return db.select().from(contentPosts).where(eq(contentPosts.id, id)).get();
}

export function updatePost(db: Executor, id: number, values: Partial<typeof contentPosts.$inferInsert>): void {
  db.update(contentPosts).set(values).where(eq(contentPosts.id, id)).run();
}

export function contentPaused(db: Executor): boolean {
  return getSetting(db, "content_paused").paused;
}

export function setContentPaused(db: Executor, paused: boolean): void {
  setSetting(db, "content_paused", { paused, at: new Date().toISOString() });
  recordEvent(db, paused ? "content_paused" : "content_resumed");
}

/** Hook kinds of the recent and planned posts, oldest first. */
function recentHookTypes(db: Executor, account: string, limit = 20): Array<string | null> {
  return db
    .select({ hookType: contentPosts.hookType })
    .from(contentPosts)
    .where(and(eq(contentPosts.account, account), sql`${contentPosts.status} != 'skipped'`))
    .orderBy(desc(contentPosts.scheduledAt))
    .limit(limit)
    .all()
    .reverse()
    .map((row) => row.hookType);
}

/** Reel formats of the recent and planned Reels, oldest first. */
function recentFormats(db: Executor, account: string, limit = 14): Array<string | null> {
  return db
    .select({ format: contentPosts.format })
    .from(contentPosts)
    .where(and(eq(contentPosts.account, account), eq(contentPosts.kind, "reel"), sql`${contentPosts.status} != 'skipped'`))
    .orderBy(desc(contentPosts.scheduledAt))
    .limit(limit)
    .all()
    .reverse()
    .map((row) => row.format);
}

/** Highest episode number of the series given so far (skipped ones keep their number). */
function lastEpisode(db: Executor, account: string): number {
  return db.select({ value: sql<number | null>`max(${contentPosts.episode})` }).from(contentPosts).where(eq(contentPosts.account, account)).get()?.value ?? 0;
}

/** What happened in the episodes before this one, for the writer to follow on (the last 6). */
export function previousEpisodes(db: Executor, account: string, episode: number): EpisodeSummary[] {
  return db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.account, account), isNotNull(contentPosts.episode), sql`${contentPosts.episode} < ${episode}`, isNotNull(contentPosts.script), sql`${contentPosts.status} != 'skipped'`))
    .orderBy(desc(contentPosts.episode))
    .limit(6)
    .all()
    .reverse()
    .map((post) => {
      const script = post.script as unknown as Partial<ReelScript>;
      return { episode: post.episode as number, title: script.title ?? post.topic, summary: script.summary ?? post.topic };
    });
}

/** Recent and planned posts of the account, for the AI to never repeat a topic. */
export function recentPosts(db: Executor, account: string, limit = 40): RecentPost[] {
  return db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.account, account), sql`${contentPosts.status} != 'skipped'`))
    .orderBy(desc(contentPosts.scheduledAt))
    .limit(limit)
    .all()
    .reverse()
    .map((post) => ({ date: post.scheduledAt.toISOString().slice(0, 10), kind: post.kind, pillar: post.pillar, topic: post.topic, hook: post.hook }));
}

function jobPostId(job: Job): number {
  return Number(job.payload.postId);
}

const JOB_TYPE_OF: Record<"contentWrite" | "contentRender" | "contentPublish" | "contentInsights" | "geminiImage" | "geminiVideo", string> = {
  contentInsights: "content_insights",
  contentWrite: "content_write",
  contentRender: "content_render",
  contentPublish: "content_publish",
  geminiImage: "gemini_image",
  geminiVideo: "gemini_video",
};

export function hasOpenContentJob(db: Executor, types: readonly string[], postId?: number): boolean {
  const conditions = [inArray(jobs.type, [...types]), inArray(jobs.status, ["pending", "running"])];
  if (postId !== undefined) conditions.push(sql`json_extract(${jobs.payload}, '$.postId') = ${postId}`);
  return Boolean(db.select({ id: jobs.id }).from(jobs).where(and(...conditions)).get());
}

/** Jobs of this kind for the post that ran out of attempts (dead) in the last day. */
export function deadJobs(db: Executor, type: string, postId: number, now = new Date()): Job[] {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, type), eq(jobs.status, "dead"), gte(jobs.finishedAt, new Date(now.getTime() - DAY_MS)), sql`json_extract(${jobs.payload}, '$.postId') = ${postId}`))
    .all();
}

export function enqueueContentOnce(db: Executor, kind: keyof typeof JOB_TYPE_OF, postId: number, extra: Record<string, unknown> = {}): boolean {
  if (hasOpenContentJob(db, [JOB_TYPE_OF[kind]], postId)) return false;
  enqueueJob(db, { kind: kind as JobKind, payload: { postId, ...extra } });
  return true;
}

// ---------------------------------------------------------------- plan

/** Creates the posts of every slot in the planning window that has none yet. */
export async function runContentPlan(db: Executor, env: Env, config: BusinessConfig, now = new Date()): Promise<ContentOutcome> {
  const content = contentOf(config);
  if (!content) return { status: "skipped", detail: "content disabled" };
  const slots = upcomingSlots(content, env.TIME_ZONE, now, content.planDaysAhead);
  if (slots.length === 0) return done("no slots in the window");
  const existing = new Set(
    db
      .select({ kind: contentPosts.kind, at: contentPosts.scheduledAt })
      .from(contentPosts)
      .where(and(eq(contentPosts.account, content.account), gte(contentPosts.scheduledAt, new Date(now.getTime() - HOUR_MS))))
      .all()
      .map((row) => `${row.kind}@${row.at.getTime()}`),
  );
  const missing = slots.filter((slot) => !existing.has(`${slot.kind}@${slot.at.getTime()}`));
  if (missing.length === 0) return done("week already planned");
  const recent = recentPosts(db, content.account);
  const measured = measuredPosts(db, content.account);
  const pillars = assignPillars(
    learnedPillars(content.pillars, measured),
    missing,
    recent.map((post) => post.pillar),
  );
  const hookTypes = assignHookTypes(
    learnedHookTypes(content.hookTypes, measured),
    missing,
    recentHookTypes(db, content.account),
  );
  const formats = assignFormats(learnedFormats(content.reelFormats, measured), missing, recentFormats(db, content.account));
  let episode = lastEpisode(db, content.account);
  const withPillars = missing.map((slot, index) => {
    const format = content.reelFormats.find((item) => item.key === formats[index]);
    return { ...slot, pillar: pillars[index], hookType: hookTypes[index], format: formats[index], episode: format?.episode ? (episode += 1) : null };
  });
  const topics = await planTopics(db, env, content, withPillars, recent, performanceBrief(measured));
  let created = 0;
  withPillars.forEach((slot, index) => {
    const topic = topics[index];
    const row = db
      .insert(contentPosts)
      .values({ account: content.account, kind: slot.kind, pillar: slot.pillar, hookType: slot.hookType, format: slot.format, episode: slot.episode, scheduledAt: slot.at, topic: topic.topic, angle: topic.angle, hook: topic.hook })
      .onConflictDoNothing()
      .returning({ id: contentPosts.id })
      .get();
    if (row) created += 1;
  });
  recordEvent(db, "content_planned", { created, slots: missing.length });
  return done(`planned ${created} posts`);
}

// ---------------------------------------------------------------- write

/** The job photo of content/fotos used the fewest times as a cover so far (ties: by name). */
function leastUsedPhoto(db: Executor, env: Env, account: string): string | null {
  const photos = ownerPhotos(env).map((file) => relativeToRoot(env, file));
  if (photos.length === 0) return null;
  const used = new Map(photos.map((photo) => [photo, 0]));
  for (const row of db.select({ media: contentPosts.media }).from(contentPosts).where(eq(contentPosts.account, account)).all()) {
    for (const file of [row.media?.image, row.media?.photo]) if (file && used.has(file)) used.set(file, (used.get(file) ?? 0) + 1);
  }
  return [...used.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0];
}

function choosePhoto(env: Env, post: ContentPost): string | null {
  const photos = ownerPhotos(env);
  if (photos.length === 0) return null;
  return relativeToRoot(env, photos[post.id % photos.length]);
}

export async function runContentWrite(db: Executor, env: Env, config: BusinessConfig, job: Job): Promise<ContentOutcome> {
  const content = contentOf(config);
  const post = getPost(db, jobPostId(job));
  if (!content || !post) return { status: "skipped", detail: "no content config or post" };
  if (post.status !== "planned") return { status: "skipped", detail: `post is ${post.status}` };
  if (post.origin === "photos") return writeFromPhotos(db, env, content, post);
  const pillar = pillarOf(content, post.pillar);
  if (!pillar) {
    updatePost(db, post.id, { status: "failed", error: `pilar "${post.pillar}" não existe mais no config` });
    return { status: "failed", detail: "unknown pillar" };
  }
  const recent = recentPosts(db, content.account).filter((item) => item.topic !== post.topic);
  try {
    const episodes = post.episode ? previousEpisodes(db, content.account, post.episode) : [];
    const written = await writePostScript(db, env, content, post, pillar, recent, episodes);
    const media: ContentMedia = { ...post.media };
    if (written.kind === "carousel" && pillar.usesOwnerPhoto) media.photo = choosePhoto(env, post);
    else if (written.kind === "carousel" && content.brand.coverFromPhotos) {
      const photo = leastUsedPhoto(db, env, content.account);
      if (photo) media.image = photo;
    }
    if (written.kind === "reel") {
      media.clips = written.script.scenes.map(() => null);
      const portrait = seriesPortrait(env);
      media.character = portrait ? relativeToRoot(env, portrait) : null;
    }
    updatePost(db, post.id, {
      status: "written",
      script: written.script as unknown as Record<string, unknown>,
      hook: written.script.hook,
      caption: finalCaption(written.script.caption, written.script.hashtags),
      media,
      error: null,
    });
    recordEvent(db, "content_written", { postId: post.id, kind: post.kind });
    return done("written");
  } catch (error) {
    if (error instanceof ContentRejectedError) {
      updatePost(db, post.id, { status: "failed", error: `texto recusado pelas regras: ${error.violations.join("; ")}`.slice(0, 500) });
      raiseAlert(db, "warning", `content_rejected:${post.id}`, `Post de ${post.scheduledAt.toLocaleDateString("pt-BR")} parou: a IA não conseguiu escrever dentro das regras. Veja em Conteúdo.`);
      return { status: "failed", detail: "rejected" };
    }
    throw error;
  }
}

// ---------------------------------------------------------------- gemini

/** Next piece of Gemini media the post still needs, or null. */
export function nextGeminiNeed(post: ContentPost, pillar: Pillar | undefined): { kind: GeminiMedia; position: number } | null {
  if (post.status !== "written") return null;
  // Posts made from the operator's photos need nothing from Gemini.
  if (post.origin === "photos") return null;
  const media = post.media;
  if (post.kind === "carousel") {
    if (pillar?.usesOwnerPhoto && media.photo) return null;
    if (media.image || media.imageSkipped) return null;
    return { kind: "image", position: 0 };
  }
  // The character's portrait comes first: every scene is made from it, so the person never changes.
  if (!media.character && !media.characterSkipped) return { kind: "image", position: 0 };
  const clips = media.clips ?? [];
  const givenUp = new Set(media.clipsGivenUp ?? []);
  const index = clips.findIndex((clip, position) => !clip && !givenUp.has(position));
  return index === -1 ? null : { kind: "video", position: index };
}

export function geminiPrompt(post: ContentPost, content: ContentConfig, kind: GeminiMedia, position: number): string {
  if (kind === "image" && post.kind === "carousel") {
    const script = post.script as unknown as CarouselScript;
    return `${script.imagePrompt.trim()} Style: ${content.imageStyle} Vertical portrait 4:5 format. Absolutely no text, letters, numbers, logos or watermarks in the image.`;
  }
  const script = post.script as unknown as ReelScript;
  const look = (script.character?.look ?? content.series.character.look).trim();
  if (kind === "image") {
    return `Realistic vertical portrait of ${content.series.character.name}, ${content.series.character.role}, at work. The person: ${look} Natural light, natural expression, the whole upper body visible, looking slightly off camera. Style: ${content.imageStyle} Vertical 9:16. No text, letters, logos or watermarks.`;
  }
  const scene = script.scenes[position];
  return `${scene.videoPrompt.trim()} The person is the same one from the reference image: ${look} Style: ${content.imageStyle} Vertical 9:16 video, realistic, one continuous shot with a dynamic camera. No text, no captions, no logos, nobody talking, only ambient sound.`;
}

export function geminiUsedToday(db: Executor, kind: GeminiMedia, dateKey: string, account?: string): number {
  const conditions = [eq(geminiRuns.kind, kind), eq(geminiRuns.dateKey, dateKey), inArray(geminiRuns.status, ["running", "done"])];
  if (account) conditions.push(eq(geminiRuns.account, account));
  return db.select({ count: sql<number>`count(*)` }).from(geminiRuns).where(and(...conditions)).get()?.count ?? 0;
}

export interface GeminiAccount {
  key: string;
  cdpUrl: string;
}

/** The Gemini accounts, each in its own Chrome (account 1 on GEMINI_CDP_URL, the next ports after it). */
export function geminiAccounts(env: Env): GeminiAccount[] {
  if (env.GEMINI_CDP_URLS && env.GEMINI_CDP_URLS.length > 0) return env.GEMINI_CDP_URLS.map((cdpUrl, index) => ({ key: String(index + 1), cdpUrl }));
  const base = new URL(env.GEMINI_CDP_URL);
  const port = Number(base.port || 9236);
  return Array.from({ length: env.GEMINI_ACCOUNTS }, (_, index) => {
    const url = new URL(base.toString());
    url.port = String(port + index);
    return { key: String(index + 1), cdpUrl: url.toString().replace(/\/$/, "") };
  });
}

type Block = { video: string | null; image: string | null; down: string | null };
const NO_BLOCK: Block = { video: null, image: null, down: null };

function blockOf(db: Executor, account: string): Block {
  return { ...NO_BLOCK, ...getSetting(db, "gemini_blocks")[account] };
}

function setBlock(db: Executor, account: string, change: Partial<Block>): void {
  const all = getSetting(db, "gemini_blocks");
  setSetting(db, "gemini_blocks", { ...all, [account]: { ...NO_BLOCK, ...all[account], ...change } });
}

const ahead = (value: string | null, now: Date) => (value && Date.parse(value) > now.getTime() ? new Date(value) : null);

/** Until when this account said "limit reached" for this kind, if still ahead. */
export function geminiBlockedUntil(db: Executor, kind: GeminiMedia, account: string, now = new Date()): Date | null {
  return ahead(blockOf(db, account)[kind], now);
}

/** Until when the account is left aside (Chrome closed or logged out), if still ahead. */
export function geminiDownUntil(db: Executor, account: string, now = new Date()): Date | null {
  return ahead(blockOf(db, account).down, now);
}

/**
 * Accounts that can make this kind of media now: not over Gemini's limit, under the daily
 * count of the config, and not left aside. In order, so account 1 is used up first.
 */
export function usableGeminiAccounts(db: Executor, env: Env, content: ContentConfig, kind: GeminiMedia, now = new Date()): GeminiAccount[] {
  const today = localClock(now, env.TIME_ZONE).dateKey;
  const limit = kind === "video" ? content.maxVideosPerDay : content.maxImagesPerDay;
  return geminiAccounts(env).filter(
    (account) => !geminiBlockedUntil(db, kind, account.key, now) && !geminiDownUntil(db, account.key, now) && geminiUsedToday(db, kind, today, account.key) < limit,
  );
}

export function geminiFailures(db: Executor, postId: number, kind: GeminiMedia, position: number): number {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(geminiRuns)
      .where(and(eq(geminiRuns.postId, postId), eq(geminiRuns.kind, kind), eq(geminiRuns.position, position), eq(geminiRuns.status, "failed")))
      .get()?.count ?? 0
  );
}

function nextLocalMidnight(now: Date, timeZone: string): Date {
  const tomorrow = localClock(new Date(now.getTime() + DAY_MS), timeZone).dateKey;
  return zonedInstant(tomorrow, "00:15", timeZone);
}

function giveUp(db: Executor, post: ContentPost, kind: GeminiMedia, position: number): void {
  const media: ContentMedia = { ...post.media };
  if (kind === "image" && post.kind === "reel") media.characterSkipped = true;
  else if (kind === "image") media.imageSkipped = true;
  else media.clipsGivenUp = [...new Set([...(media.clipsGivenUp ?? []), position])];
  updatePost(db, post.id, { media });
  recordEvent(db, "gemini_gave_up", { postId: post.id, kind, position });
}

/** A written Reel without the portrait picks up the series portrait once it exists. */
export function attachSeriesPortrait(db: Executor, env: Env, post: ContentPost): ContentPost {
  if (post.kind !== "reel" || post.media.character) return post;
  const portrait = seriesPortrait(env);
  if (!portrait) return post;
  const media: ContentMedia = { ...post.media, character: relativeToRoot(env, portrait), characterSkipped: false };
  updatePost(db, post.id, { media });
  return { ...post, media };
}

export async function runGemini(db: Executor, env: Env, config: BusinessConfig, job: Job, kind: GeminiMedia): Promise<ContentOutcome> {
  const content = contentOf(config);
  const post = getPost(db, jobPostId(job));
  const position = Number(job.payload.position ?? 0);
  if (!content || !post) return { status: "skipped", detail: "no content config or post" };
  if (post.status !== "written") return { status: "skipped", detail: `post is ${post.status}` };
  const need = nextGeminiNeed(attachSeriesPortrait(db, env, post), pillarOf(content, post.pillar));
  if (!need || need.kind !== kind || need.position !== position) return { status: "skipped", detail: "already has it" };
  const accounts = usableGeminiAccounts(db, env, content, kind);
  // The planner asks again once an account is free; a job left waiting would only hold the queue.
  if (accounts.length === 0) return { status: "skipped", detail: "no gemini account available" };

  const prompt = geminiPrompt(post, content, kind, position);
  const dateKey = localClock(new Date(), env.TIME_ZONE).dateKey;
  const label = (account: GeminiAccount) => (geminiAccounts(env).length > 1 ? ` da conta ${account.key}` : "");
  const notes: string[] = [];

  for (const account of accounts) {
    const run = db.insert(geminiRuns).values({ postId: post.id, account: account.key, kind, position, prompt, status: "running", dateKey }).returning().get();
    const settle = (status: "done" | "failed" | "limit", values: { file?: string; error?: string } = {}) =>
      db.update(geminiRuns).set({ status, file: values.file ?? null, error: values.error?.slice(0, 300) ?? null }).where(eq(geminiRuns.id, run.id)).run();
    try {
      const file = await generateWithGemini({
        cdpUrl: account.cdpUrl,
        origin: env.GEMINI_ORIGIN,
        kind,
        prompt,
        downloadDir: postDir(env, post.id, "gemini"),
        baseName: kind === "image" ? (post.kind === "reel" ? "personagem" : "capa") : `cena-${position + 1}`,
        timeoutMs: kind === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS,
        referenceImage: kind === "video" ? existing(env, (getPost(db, post.id) ?? post).media.character) : null,
      });
      let relative = relativeToRoot(env, file);
      if (kind === "image" && post.kind === "reel") {
        // The portrait becomes the series' face: every next Reel reuses it.
        const series = seriesPortrait(env) ?? path.join(seriesDir(env), `personagem${path.extname(file) || ".png"}`);
        if (!existsSync(series)) copyFileSync(file, series);
        relative = relativeToRoot(env, series);
      }
      settle("done", { file: relative });
      const fresh = getPost(db, post.id) ?? post;
      const media: ContentMedia = { ...fresh.media };
      if (kind === "image" && post.kind === "reel") media.character = relative;
      else if (kind === "image") media.image = relative;
      else {
        const clips = [...(media.clips ?? [])];
        clips[position] = relative;
        media.clips = clips;
      }
      updatePost(db, post.id, { media });
      recordEvent(db, "gemini_done", { postId: post.id, account: account.key, kind, position });
      return done(`${kind} ${position + 1} saved (account ${account.key})`);
    } catch (error) {
      // Problems of the account or its Chrome, not of the prompt: the attempt does not count and the next account goes.
      if (error instanceof BrowserUnavailableError) {
        db.delete(geminiRuns).where(eq(geminiRuns.id, run.id)).run();
        setBlock(db, account.key, { down: later(10 * MINUTE_MS).toISOString() });
        raiseAlert(db, "warning", `gemini_chrome_closed:${account.key}`, `O Chrome do Gemini${label(account)} está fechado: abra o LIGAR-CONTEUDO de novo (ou o abrir-chrome-gemini${account.key === "1" ? "" : ` ${account.key}`}).`);
        notes.push(`account ${account.key} chrome closed`);
        continue;
      }
      if (error instanceof GeminiStateError && error.kind === "logged_out") {
        db.delete(geminiRuns).where(eq(geminiRuns.id, run.id)).run();
        setBlock(db, account.key, { down: later(30 * MINUTE_MS).toISOString() });
        raiseAlert(db, "warning", `gemini_logged_out:${account.key}`, `O Gemini saiu da conta no Chrome do Gemini${label(account)}: entre de novo na conta Google nessa janela.`);
        notes.push(`account ${account.key} logged out`);
        continue;
      }
      if (error instanceof GeminiStateError && error.kind === "limit") {
        settle("limit", { error: error.message });
        const until = nextLocalMidnight(new Date(), env.TIME_ZONE);
        setBlock(db, account.key, { [kind]: until.toISOString() });
        recordEvent(db, "gemini_limit", { account: account.key, kind, until: until.toISOString() });
        notes.push(`account ${account.key} ${kind} limit`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      settle("failed", { error: message });
      logger.warn("gemini attempt failed", { postId: post.id, account: account.key, kind, position, error: message });
      if (geminiFailures(db, post.id, kind, position) >= GEMINI_ATTEMPTS) giveUp(db, getPost(db, post.id) ?? post, kind, position);
      return done(`gemini ${kind} failed: ${message.slice(0, 120)}`);
    }
  }
  return done(`no account could make it: ${notes.join("; ")}`);
}

// ---------------------------------------------------------------- render

function existing(env: Env, relative: string | null | undefined): string | null {
  if (!relative) return null;
  const file = absoluteFromRoot(env, relative);
  return file && existsSync(file) ? file : null;
}

export async function runContentRender(db: Executor, env: Env, config: BusinessConfig, job: Job): Promise<ContentOutcome> {
  const content = contentOf(config);
  const post = getPost(db, jobPostId(job));
  if (!content || !post) return { status: "skipped", detail: "no content config or post" };
  if (post.status !== "media_ready") return { status: "skipped", detail: `post is ${post.status}` };
  const media: ContentMedia = { ...post.media };
  if (post.origin === "photos" && post.kind === "carousel") {
    const script = post.script as unknown as PhotoCarouselScript;
    const photos = (post.brief?.photos ?? []).map((photo) => existing(env, photo.file));
    const files = await renderPages(env, photoCarouselPages(content.brand, script, postDir(env, post.id, "slides"), photos));
    media.slides = files.map((file) => relativeToRoot(env, file));
  } else if (post.origin === "photos") {
    const script = photoReelAsStory(post.script as unknown as PhotoReelScript);
    media.narration = await narrate(db, env, content, post, script);
    const reel = await renderStoryReel(env, content, post, script, media);
    media.video = relativeToRoot(env, reel.video);
    media.cover = relativeToRoot(env, reel.cover);
  } else if (post.kind === "carousel") {
    const script = post.script as unknown as CarouselScript;
    const dir = postDir(env, post.id, "slides");
    const pages = carouselPages(content.brand, script, dir, { cover: existing(env, media.image), photo: existing(env, media.photo) });
    const files = await renderPages(env, pages);
    media.slides = files.map((file) => relativeToRoot(env, file));
  } else {
    const script = post.script as unknown as ReelScript;
    media.narration = await narrate(db, env, content, post, script);
    const reel = await renderStoryReel(env, content, post, script, media);
    media.video = relativeToRoot(env, reel.video);
    media.cover = relativeToRoot(env, reel.cover);
  }
  updatePost(db, post.id, { status: "ready", media, error: null });
  recordEvent(db, "content_rendered", { postId: post.id, kind: post.kind });
  return done("rendered");
}

/** Narration MP3 of each scene; scenes already narrated (and still on disk) are kept. */
async function narrate(db: Executor, env: Env, content: ContentConfig, post: ContentPost, script: ReelScript): Promise<string[]> {
  const dir = postDir(env, post.id, "voz");
  const files: string[] = [];
  for (let index = 0; index < script.scenes.length; index += 1) {
    const previous = existing(env, post.media.narration?.[index]);
    const file = previous && previous.endsWith(".m4a") ? previous : path.join(dir, `cena-${index + 1}.m4a`);
    if (file !== previous) {
      const raw = path.join(dir, `cena-${index + 1}.mp3`);
      if (!existsSync(raw)) await synthesizeSpeech(db, env, { ...content.narration, style: (post.origin === "photos" ? undefined : formatOf(content, post).voiceStyle) ?? content.narration.style, text: script.scenes[index].narration, file: raw });
      await prepareNarration(env, raw, file);
    }
    files.push(relativeToRoot(env, file));
  }
  return files;
}

/** What the badge at the end of the Reel says: the next part of the novela, or the call to action. */
export function reelEnding(content: ContentConfig, post: Pick<ContentPost, "format" | "episode">): string {
  const format = formatOf(content, post);
  if (format.episode && post.episode) return `Parte ${post.episode + 1} em breve. Segue ${content.brand.handle}`;
  return content.brand.ctaBadge || `Chama no Direct ${content.brand.handle}`;
}

/**
 * Hook (with "PARTE N" in a novela), timed boxed subtitles and the ending badge over each scene,
 * then ffmpeg joins it all with punch-in cuts. The cover (thumbnail) is drawn from the first scene.
 */
async function renderStoryReel(env: Env, content: ContentConfig, post: ContentPost, script: ReelScript, media: ContentMedia): Promise<{ video: string; cover: string }> {
  const dir = postDir(env, post.id, "render");
  const chunks = script.scenes.map((scene) => subtitleChunks(scene.narration, 4));
  const tag = post.episode && formatOf(content, post).episode ? `Parte ${post.episode}` : null;
  const pages = reelPages(content.brand, { hook: script.hook, tag, title: script.title ?? "", chunks, ending: reelEnding(content, post) }, dir);
  await renderPages(env, [pages.hook, ...(script.title ? [pages.title] : []), ...pages.subtitles.flat(), pages.cta, pages.fallback]);
  const portrait = existing(env, media.character) ?? pages.fallback.file;
  const scenes: StoryScene[] = [];
  for (let index = 0; index < script.scenes.length; index += 1) {
    const narration = absoluteFromRoot(env, media.narration?.[index] ?? "") as string;
    const seconds = await mediaDuration(env, narration);
    const length = sceneSeconds(seconds);
    const overlays: TimedOverlay[] = subtitleTimings(chunks[index], seconds).map((timing, chunk) => ({ file: pages.subtitles[index][chunk].file, ...timing }));
    const hookEnd = Math.min(2.2, length);
    if (script.title) overlays.unshift({ file: pages.title.file, start: index === 0 ? hookEnd : 0, end: length });
    if (index === 0) overlays.unshift({ file: pages.hook.file, start: 0, end: hookEnd });
    if (index === script.scenes.length - 1) overlays.push({ file: pages.cta.file, start: Math.max(0, length - 2.6), end: length });
    const still = existing(env, media.stills?.[index]) ?? portrait;
    scenes.push({ clip: existing(env, media.clips?.[index]), still, narration, narrationSeconds: seconds, overlays });
  }
  const video = await buildStoryReel(env, { scenes, workDir: dir, output: path.join(postDir(env, post.id), "reel.mp4") });

  // Cover: a frame of the first clip (or the portrait) with the hook in big type.
  const firstClip = existing(env, media.clips?.[0]);
  const frame = firstClip ? await extractFrame(env, firstClip, 1.2, path.join(dir, "cover-frame.jpg")).catch(() => null) : null;
  const coverPage = reelCoverPage(content.brand, { hook: script.hook, tag, series: tag ? content.series.name : null, background: frame ?? existing(env, media.stills?.[0]) ?? existing(env, media.character) }, path.join(postDir(env, post.id), "capa.jpg"));
  const [cover] = await renderPages(env, [coverPage]);
  return { video, cover };
}

// ---------------------------------------------------------------- publish

/** Checks that Meta will be able to download the files through the public address. */
async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runContentPublish(db: Executor, env: Env, config: BusinessConfig, job: Job): Promise<ContentOutcome> {
  const content = config;
  const post = getPost(db, jobPostId(job));
  if (!post) return { status: "skipped", detail: "no post" };
  if (post.status !== "ready") return { status: "skipped", detail: `post is ${post.status}` };
  if (!job.payload.force && (!content.autoPublish || post.scheduledAt.getTime() > Date.now())) return { status: "skipped", detail: "not due" };

  if (!hasMetaCredentials(env)) {
    const note = "falta o token da Meta (INSTAGRAM_TOKEN e INSTAGRAM_ACCOUNT_ID no .env)";
    updatePost(db, post.id, { error: note });
    raiseAlert(db, "warning", "content_meta_missing", `Os posts estão prontos mas não saem: ${note}.`);
    return { status: "deferred", detail: "meta_not_configured", retryAt: later(HOUR_MS) };
  }
  const base = publicBaseUrl(env);
  const files = post.kind === "carousel" ? (post.media.slides ?? []) : post.media.video ? [post.media.video] : [];
  if (files.length === 0) {
    updatePost(db, post.id, { status: "media_ready", error: "arquivos finais sumiram; desenhando de novo" });
    return { status: "skipped", detail: "no final files" };
  }
  const urls = base ? files.map((file) => `${base}${mediaPath(env, file)}`) : [];
  const coverUrl = base && post.kind === "reel" && existing(env, post.media.cover) ? `${base}${mediaPath(env, post.media.cover as string)}` : undefined;
  if (!base || !(await reachable(urls[0]))) {
    const note = base ? "o túnel não respondeu (a Meta baixa os arquivos por ele)" : "o túnel não está aberto (tunel-url.txt) e não há CONTENT_PUBLIC_BASE_URL";
    updatePost(db, post.id, { error: note });
    raiseAlert(db, "warning", "content_tunnel", `Post pronto esperando: ${note}. Abra o LIGAR-TUDO.`);
    return { status: "deferred", detail: "tunnel_unavailable", retryAt: later(10 * MINUTE_MS) };
  }

  let committed = false;
  updatePost(db, post.id, { status: "publishing", attempts: post.attempts + 1, error: null });
  const hooks = {
    beforePublish: (containerId: string) => {
      committed = true;
      updatePost(db, post.id, { containerId });
    },
  };
  try {
    const result = post.kind === "carousel" ? await publishCarousel(env, urls, post.caption ?? "", hooks) : await publishReel(env, urls[0], post.caption ?? "", hooks, coverUrl);
    updatePost(db, post.id, { status: "published", igMediaId: result.mediaId, permalink: result.permalink, publishedAt: new Date(), error: null });
    recordEvent(db, "content_published", { postId: post.id, kind: post.kind, mediaId: result.mediaId });
    return done(`published ${result.mediaId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (committed) {
      // media_publish was sent: it may have gone out. Never publish again blindly.
      updatePost(db, post.id, { status: "failed", error: `a publicação pode ter saído; confira no Instagram antes de tentar de novo (${message})`.slice(0, 500) });
      raiseAlert(db, "warning", `content_unknown:${post.id}`, "Um post pode ter sido publicado sem confirmação. Confira no Instagram e marque em Conteúdo.");
      return { status: "failed", detail: message };
    }
    if (error instanceof MetaNotConfiguredError || (error instanceof MetaApiError && !error.retryable) || post.attempts + 1 >= 4) {
      updatePost(db, post.id, { status: "failed", error: `Meta recusou: ${message}`.slice(0, 500) });
      raiseAlert(db, "warning", `content_publish_failed:${post.id}`, `A Meta recusou um post (${message.slice(0, 120)}). Veja em Conteúdo.`);
      return { status: "failed", detail: message };
    }
    updatePost(db, post.id, { status: "ready", error: `tentando de novo: ${message}`.slice(0, 500) });
    return { status: "deferred", detail: message.slice(0, 200), retryAt: later(15 * MINUTE_MS) };
  }
}

// ---------------------------------------------------------------- insights

/** Posts measured 2 days after going out, and again around day 7 (Reels keep growing). */
export const INSIGHTS_FIRST_AFTER_MS = 2 * DAY_MS;
export const INSIGHTS_AGAIN_AFTER_MS = 5 * DAY_MS;
export const INSIGHTS_STOP_AFTER_MS = 10 * DAY_MS;

/** The published post whose numbers are due, oldest need first. */
export function dueForInsights(db: Executor, account: string, now = new Date()): ContentPost | undefined {
  return db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.account, account), eq(contentPosts.status, "published"), isNotNull(contentPosts.igMediaId)))
    .orderBy(asc(contentPosts.publishedAt))
    .all()
    .find((post) => {
      const age = now.getTime() - (post.publishedAt?.getTime() ?? now.getTime());
      if (age < INSIGHTS_FIRST_AFTER_MS || age > INSIGHTS_STOP_AFTER_MS + DAY_MS) return false;
      if (!post.metricsAt) return true;
      return now.getTime() - post.metricsAt.getTime() >= INSIGHTS_AGAIN_AFTER_MS && post.metricsAt.getTime() - (post.publishedAt?.getTime() ?? 0) < INSIGHTS_STOP_AFTER_MS;
    });
}

export async function runContentInsights(db: Executor, env: Env, job: Job): Promise<ContentOutcome> {
  const post = getPost(db, jobPostId(job));
  if (!post?.igMediaId) return { status: "skipped", detail: "no published media" };
  if (!hasMetaCredentials(env)) return { status: "skipped", detail: "meta_not_configured" };
  try {
    const values = await fetchInsights(env, post.igMediaId);
    const metrics = { views: values.views ?? null, reach: values.reach ?? null, shares: values.shares ?? null, saved: values.saved ?? null, interactions: values.total_interactions ?? null };
    updatePost(db, post.id, { metrics, metricsAt: new Date() });
    recordEvent(db, "content_insights", { postId: post.id, ...metrics });
    return done("measured");
  } catch (error) {
    // Numbers are a bonus: a failure only means trying again later.
    updatePost(db, post.id, { metricsAt: new Date() });
    return { status: "skipped", detail: `insights failed: ${error instanceof Error ? error.message : error}`.slice(0, 200) };
  }
}

// ---------------------------------------------------------------- operator actions

/** Dead jobs of the post leave the way, so the planner does not stop it again right away. */
function clearDeadJobs(db: Executor, postId: number): void {
  db.update(jobs)
    .set({ status: "cancelled", lastError: "operator retried the post" })
    .where(and(eq(jobs.status, "dead"), sql`json_extract(${jobs.payload}, '$.postId') = ${postId}`))
    .run();
}

/** Puts a failed or stuck post back in the pipeline at the step it stopped. */
export function retryPost(db: Executor, id: number): void {
  const post = getPost(db, id);
  if (!post || post.status === "published" || post.status === "publishing") return;
  const status = !post.script ? "planned" : post.media.slides?.length || post.media.video ? "ready" : "written";
  clearDeadJobs(db, id);
  updatePost(db, id, { status, error: null, attempts: 0 });
  recordEvent(db, "content_retry", { postId: id, status });
}

/** Writes the post again from scratch (same topic and time). */
export function rewritePost(db: Executor, id: number): void {
  const post = getPost(db, id);
  if (!post || post.status === "published" || post.status === "publishing") return;
  clearDeadJobs(db, id);
  db.delete(geminiRuns).where(and(eq(geminiRuns.postId, id), inArray(geminiRuns.status, ["failed"]))).run();
  updatePost(db, id, { status: "planned", script: null, caption: null, media: {}, error: null, attempts: 0 });
  recordEvent(db, "content_rewrite", { postId: id });
}

export function skipPost(db: Executor, id: number): void {
  const post = getPost(db, id);
  if (!post || post.status === "published" || post.status === "publishing") return;
  updatePost(db, id, { status: "skipped", error: "pulado no painel" });
  recordEvent(db, "content_skipped", { postId: id, by: "operator" });
}

/** Marks a post the operator confirmed is on Instagram (after an unconfirmed publish). */
export function markPublished(db: Executor, id: number): void {
  const post = getPost(db, id);
  if (!post || post.status !== "failed") return;
  updatePost(db, id, { status: "published", publishedAt: post.publishedAt ?? new Date(), error: null });
  recordEvent(db, "content_marked_published", { postId: id });
}

/** Publishes a ready post now, regardless of its time or of autoPublish. */
export function publishNow(db: Executor, id: number): boolean {
  const post = getPost(db, id);
  if (!post || post.status !== "ready") return false;
  return enqueueContentOnce(db, "contentPublish", id, { force: true });
}

export function postsBetween(db: Executor, from: Date, to: Date): ContentPost[] {
  return db.select().from(contentPosts).where(and(gte(contentPosts.scheduledAt, from), lte(contentPosts.scheduledAt, to))).orderBy(asc(contentPosts.scheduledAt)).all();
}

// ---------------------------------------------------------------- posts from the operator's photos

/** A photo the operator sent from the panel. */
export interface SentPhoto {
  data: Buffer;
  label: PhotoLabel;
}

export interface PhotoPostRequest {
  type: string;
  note: string;
  kind: "carousel" | "reel";
  /** "next": next day with nothing scheduled; "date": the day and time given; "now": as soon as it is ready. */
  when: "next" | "date" | "now";
  date?: string;
  time?: string;
  photos: SentPhoto[];
}

/** A request the panel shows back to the operator in plain words. */
export class PanelInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelInputError";
  }
}

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/** JPEG, PNG or WebP by their first bytes; anything else is refused. */
export function imageExtension(data: Buffer): ".jpg" | ".png" | ".webp" | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ".jpg";
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (data.length > 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  return null;
}

/** Posts of the account that still count on the calendar (not skipped). */
function activePostsBetween(db: Executor, account: string, from: Date, to: Date): ContentPost[] {
  return db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.account, account), gte(contentPosts.scheduledAt, from), lte(contentPosts.scheduledAt, to), sql`${contentPosts.status} != 'skipped'`))
    .all();
}

/**
 * The next local day, from today, with nothing on the calendar, at the carousel time. Today only
 * counts while there are still 2 hours before that time (time to write and draw).
 */
export function nextFreeDay(db: Executor, content: ContentConfig, timeZone: string, now = new Date()): Date {
  const taken = new Set(activePostsBetween(db, content.account, new Date(now.getTime() - DAY_MS), new Date(now.getTime() + 120 * DAY_MS)).map((post) => localClock(post.scheduledAt, timeZone).dateKey));
  for (let offset = 0; offset < 120; offset += 1) {
    const dateKey = localClock(new Date(now.getTime() + offset * DAY_MS), timeZone).dateKey;
    const at = zonedInstant(dateKey, content.carouselTime, timeZone);
    if (at.getTime() - now.getTime() < 2 * HOUR_MS) continue;
    if (!taken.has(dateKey)) return at;
  }
  return zonedInstant(localClock(new Date(now.getTime() + DAY_MS), timeZone).dateKey, content.carouselTime, timeZone);
}

function slotTaken(db: Executor, account: string, kind: ContentPost["kind"], at: Date): ContentPost | undefined {
  return db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.account, account), eq(contentPosts.kind, kind), eq(contentPosts.scheduledAt, at)))
    .get();
}

const LOCKED: ContentPost["status"][] = ["published", "publishing"];

function requestedInstant(content: ContentConfig, timeZone: string, date: string | undefined, time: string | undefined, now: Date): Date {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PanelInputError("Escolha o dia.");
  const hhmm = time && /^\d{2}:\d{2}$/.test(time) ? time : content.carouselTime;
  const at = zonedInstant(date, hhmm, timeZone);
  if (Number.isNaN(at.getTime())) throw new PanelInputError("Dia ou horário inválido.");
  if (at.getTime() < now.getTime() - MINUTE_MS) throw new PanelInputError("Esse dia e horário já passaram. Escolha outro.");
  return at;
}

/**
 * Creates a post from the operator's photos. When the chosen time already has a planned post
 * of the same kind that did not go out, the photos take its place (the planned topic leaves).
 */
export function createPhotoPost(db: Executor, env: Env, content: ContentConfig, request: PhotoPostRequest, now = new Date()): ContentPost {
  const type = content.photoTypes.find((item) => item.key === request.type);
  if (!type) throw new PanelInputError("Escolha que conteúdo é esse.");
  if (request.kind !== "carousel" && request.kind !== "reel") throw new PanelInputError("Escolha carrossel ou Reel.");
  if (request.photos.length === 0) throw new PanelInputError("Coloque pelo menos uma foto.");
  if (request.photos.length > MAX_PHOTOS) throw new PanelInputError(`No máximo ${MAX_PHOTOS} fotos por post.`);
  if (request.kind === "reel" && request.photos.length < 2) throw new PanelInputError("O Reel precisa de pelo menos 2 fotos.");
  const extensions = request.photos.map((photo) => (photo.data.length <= MAX_PHOTO_BYTES ? imageExtension(photo.data) : null));
  if (extensions.some((ext) => !ext)) throw new PanelInputError("Uma das fotos não é JPG, PNG ou WebP (ou passou de 15 MB).");
  const note = request.note.trim().slice(0, 2000);

  const at = request.when === "now" ? new Date(now.getTime()) : request.when === "date" ? requestedInstant(content, env.TIME_ZONE, request.date, request.time, now) : nextFreeDay(db, content, env.TIME_ZONE, now);
  const topic = `${type.name}${note ? `: ${note.split(/\s+/).slice(0, 8).join(" ")}` : ""}`.slice(0, 120);
  const values = {
    account: content.account,
    kind: request.kind,
    pillar: "fotos",
    hookType: null,
    format: null,
    episode: null,
    origin: "photos" as const,
    status: "planned" as const,
    scheduledAt: at,
    topic,
    angle: null,
    hook: null,
    script: null,
    caption: null,
    media: {},
    error: null,
    attempts: 0,
    brief: { type: type.key, note, photos: [] } as PhotoBrief,
  };
  const taken = slotTaken(db, content.account, request.kind, at);
  let id: number;
  if (taken) {
    if (LOCKED.includes(taken.status) || taken.origin === "photos") throw new PanelInputError("Esse dia e horário já têm um post com fotos ou já publicado. Escolha outro horário.");
    clearDeadJobs(db, taken.id);
    updatePost(db, taken.id, { ...values, containerId: null, igMediaId: null, permalink: null });
    recordEvent(db, "content_replaced_by_photos", { postId: taken.id, topic: taken.topic });
    id = taken.id;
  } else {
    id = (db.insert(contentPosts).values(values).returning({ id: contentPosts.id }).get() as { id: number }).id;
  }
  const dir = postDir(env, id, "fotos");
  const photos = request.photos.map((photo, index) => {
    const file = path.join(dir, `foto-${index + 1}${extensions[index]}`);
    writeFileSync(file, photo.data);
    return { file: relativeToRoot(env, file), label: (PHOTO_LABELS as readonly string[]).includes(photo.label) ? photo.label : ("" as PhotoLabel) };
  });
  updatePost(db, id, { brief: { type: type.key, note, photos } });
  recordEvent(db, "content_photo_post", { postId: id, kind: request.kind, type: type.key, photos: photos.length });
  return getPost(db, id) as ContentPost;
}

function dataUrl(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${type};base64,${readFileSync(file).toString("base64")}`;
}

/** A photo Reel in the shape of a story Reel, so it is narrated and drawn the same way. */
export function photoReelAsStory(script: PhotoReelScript): ReelScript {
  return {
    hook: script.hook,
    title: script.title,
    scenes: script.scenes.map((scene) => ({ beat: `Foto ${scene.photo}`, videoPrompt: "", narration: scene.narration })),
    summary: script.topic,
    shareReason: "",
    caption: script.caption,
    hashtags: script.hashtags,
  };
}

async function writeFromPhotos(db: Executor, env: Env, content: ContentConfig, post: ContentPost): Promise<ContentOutcome> {
  const brief = post.brief;
  const type = content.photoTypes.find((item) => item.key === brief?.type) ?? content.photoTypes.at(-1);
  const files = (brief?.photos ?? []).map((photo) => existing(env, photo.file));
  if (!brief || !type || files.length === 0 || files.some((file) => !file)) {
    updatePost(db, post.id, { status: "failed", error: "as fotos deste post sumiram da pasta content; crie o post de novo" });
    return { status: "failed", detail: "photos missing" };
  }
  try {
    const recent = recentPosts(db, content.account).filter((item) => item.topic !== post.topic);
    const written = await writePhotoPost(db, env, content, post.kind, { type, note: brief.note, labels: brief.photos.map((photo) => photo.label), images: (files as string[]).map(dataUrl) }, recent);
    const media: ContentMedia = {};
    if (written.kind === "reel") media.stills = written.script.scenes.map((scene) => brief.photos[scene.photo - 1]?.file ?? brief.photos[0].file);
    updatePost(db, post.id, {
      status: "written",
      script: written.script as unknown as Record<string, unknown>,
      topic: written.script.topic.slice(0, 120) || post.topic,
      hook: written.script.hook,
      caption: finalCaption(written.script.caption, written.script.hashtags),
      media,
      error: null,
    });
    recordEvent(db, "content_written", { postId: post.id, kind: post.kind, origin: "photos" });
    return done("written from photos");
  } catch (error) {
    if (error instanceof ContentRejectedError) {
      updatePost(db, post.id, { status: "failed", error: `texto recusado pelas regras: ${error.violations.join("; ")}`.slice(0, 500) });
      raiseAlert(db, "warning", `content_rejected:${post.id}`, "Um post com suas fotos parou: a IA não conseguiu escrever dentro das regras. Use Refazer ou mude o texto sobre a obra.");
      return { status: "failed", detail: "rejected" };
    }
    throw error;
  }
}

/**
 * Moves a post to another day and time. When that time already has a post of the same kind that
 * did not go out, the two swap places.
 */
export function movePost(db: Executor, env: Env, content: ContentConfig, id: number, date: string | undefined, time: string | undefined, now = new Date()): void {
  const post = getPost(db, id);
  if (!post) throw new PanelInputError("Post não encontrado.");
  if (LOCKED.includes(post.status)) throw new PanelInputError("Esse post já foi publicado.");
  const at = requestedInstant(content, env.TIME_ZONE, date, time ?? TIME_OF(post.scheduledAt, env.TIME_ZONE), now);
  if (at.getTime() === post.scheduledAt.getTime()) return;
  const other = slotTaken(db, post.account, post.kind, at);
  if (other && LOCKED.includes(other.status)) throw new PanelInputError("Esse horário já tem um post publicado. Escolha outro.");
  const from = post.scheduledAt;
  if (other) updatePost(db, other.id, { scheduledAt: new Date(-other.id) });
  updatePost(db, post.id, { scheduledAt: at });
  if (other) updatePost(db, other.id, { scheduledAt: from });
  recordEvent(db, "content_moved", { postId: id, from: from.toISOString(), to: at.toISOString(), swappedWith: other?.id ?? null });
}

function TIME_OF(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}
