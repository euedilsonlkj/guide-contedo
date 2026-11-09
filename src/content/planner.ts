import { and, asc, eq, inArray } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { raiseAlert, recordEvent } from "@/core/journal";
import { contentPosts, type ContentPost } from "@/db/schema";
import type { ContentConfig as BusinessConfig } from "@/lib/config";
import type { Env } from "@/lib/env";
import { HOUR_MS, localClock } from "@/lib/time";
import { enqueueJob } from "@/core/queue";
import {
  attachSeriesPortrait,
  contentOf,
  contentPaused,
  deadJobs,
  dueForInsights,
  enqueueContentOnce,
  hasOpenContentJob,
  nextGeminiNeed,
  pillarOf,
  updatePost,
  usableGeminiAccounts,
} from "./posts";
import { upcomingSlots } from "./schedule";

/** How early each step may start, counted back from the post's time. */
export const WRITE_AHEAD_MS = 108 * HOUR_MS;
export const IMAGE_AHEAD_MS = 96 * HOUR_MS;
/** Reels go out every day with 2 to 4 clips each: clips are asked up to 4 days ahead, within the daily limits. */
export const VIDEO_AHEAD_MS = 96 * HOUR_MS;
/** From this close to the time, the post is drawn with whatever media it has. */
export const CAROUSEL_RENDER_DEADLINE_MS = 1 * HOUR_MS;
export const REEL_RENDER_DEADLINE_MS = 2 * HOUR_MS;

/** A Reel may go out with at most one scene missing (that one becomes a zoom on the portrait). */
export function clipsEnough(clips: ReadonlyArray<string | null>): boolean {
  const made = clips.filter(Boolean).length;
  return clips.length > 0 && made >= Math.max(1, clips.length - 1);
}

const ACTIVE: ContentPost["status"][] = ["planned", "written", "media_ready", "ready"];

/** A post whose job died is stopped for the operator instead of being retried forever. */
function stopIfDead(db: Executor, post: ContentPost, type: string, label: string): boolean {
  const dead = deadJobs(db, type, post.id);
  if (dead.length === 0) return false;
  updatePost(db, post.id, { status: "failed", error: `${label}: ${dead[0].lastError ?? "erro"}`.slice(0, 500) });
  raiseAlert(db, "warning", `content_failed:${post.id}`, `Um post parou em "${label}". Veja em Conteúdo e use "Tentar de novo".`);
  return true;
}

/**
 * One tick of the content arm. Every step is a job; this only decides which ones are due:
 * plan the coming days, write, ask Gemini (one request at a time, within the daily limits),
 * draw the final files and publish on time. Returns what it did, for the logs.
 */
export function planContentWork(db: Executor, env: Env, config: BusinessConfig, now = new Date()): string {
  const content = contentOf(config);
  if (!content) return "disabled";
  if (contentPaused(db)) return "paused";
  const actions: string[] = [];

  // 1. Every slot of the coming days has a post.
  if (!hasOpenContentJob(db, ["content_plan"])) {
    const slots = upcomingSlots(content, env.TIME_ZONE, now, content.planDaysAhead);
    const planned = new Set(
      db
        .select({ kind: contentPosts.kind, at: contentPosts.scheduledAt })
        .from(contentPosts)
        .where(eq(contentPosts.account, content.account))
        .all()
        .map((row) => `${row.kind}@${row.at.getTime()}`),
    );
    if (slots.some((slot) => !planned.has(`${slot.kind}@${slot.at.getTime()}`))) {
      enqueueJob(db, { kind: "contentPlan", idempotencyKey: `content_plan:${localClock(now, env.TIME_ZONE).dateKey}:${now.getUTCHours()}` });
      actions.push("plan");
    }
  }

  const posts = db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.account, content.account), inArray(contentPosts.status, ACTIVE)))
    .orderBy(asc(contentPosts.scheduledAt))
    .all();

  let geminiQueued = hasOpenContentJob(db, ["gemini_image", "gemini_video"]);

  for (const post of posts) {
    const untilTime = post.scheduledAt.getTime() - now.getTime();

    // 2. Missed its day (computer off): skipped, the next one follows.
    if (-untilTime > content.lateToleranceHours * HOUR_MS) {
      updatePost(db, post.id, { status: "skipped", error: "o horário passou com o sistema desligado" });
      recordEvent(db, "content_skipped", { postId: post.id, by: "system" });
      actions.push(`skip:${post.id}`);
      continue;
    }

    // Reels turned off (reelDays empty): the Reels already in the agenda leave it.
    if (post.kind === "reel" && content.reelDays.length === 0 && post.origin !== "photos") {
      updatePost(db, post.id, { status: "skipped", error: "Reels desligados no config (reelDays vazio)" });
      recordEvent(db, "content_skipped", { postId: post.id, by: "config" });
      actions.push(`skip:${post.id}`);
      continue;
    }

    if (post.status === "planned") {
      // Posts from the operator's photos are written right away, so the preview shows up in minutes.
      if ((post.origin === "photos" || untilTime <= WRITE_AHEAD_MS) && !stopIfDead(db, post, "content_write", "escrevendo") && enqueueContentOnce(db, "contentWrite", post.id)) actions.push(`write:${post.id}`);
      continue;
    }

    if (post.status === "written" && post.origin === "photos") {
      updatePost(db, post.id, { status: "media_ready" });
      actions.push(`media_ready:${post.id}`);
      continue;
    }

    if (post.status === "written") {
      const pillar = pillarOf(content, post.pillar);
      const current = attachSeriesPortrait(db, env, post);
      const need = nextGeminiNeed(current, pillar);
      if (post.kind === "reel") {
        // A Reel never goes out as a photo with zoom: it needs its clips (all but one at most).
        const clips = current.media.clips ?? [];
        const enough = clipsEnough(clips);
        if (!need && !enough) {
          updatePost(db, post.id, { status: "failed", error: "o Gemini não conseguiu fazer as cenas do vídeo (recusou duas vezes); use Refazer para escrever outro roteiro" });
          raiseAlert(db, "warning", `content_no_clips:${post.id}`, "Um Reel parou porque o Gemini não fez as cenas. Veja em Conteúdo e use Refazer.");
          actions.push(`no_clips:${post.id}`);
          continue;
        }
        if (!need || (enough && untilTime <= REEL_RENDER_DEADLINE_MS)) {
          updatePost(db, post.id, { status: "media_ready" });
          if (need) recordEvent(db, "content_without_media", { postId: post.id, kind: need.kind });
          actions.push(`media_ready:${post.id}`);
          continue;
        }
        // Missing clips near or past the time: keep asking Gemini; the Reel goes out a little
        // late (up to lateToleranceHours) instead of going out without video.
      } else if (!need || untilTime <= CAROUSEL_RENDER_DEADLINE_MS) {
        updatePost(db, post.id, { status: "media_ready" });
        if (need) recordEvent(db, "content_without_media", { postId: post.id, kind: need.kind });
        actions.push(`media_ready:${post.id}`);
        continue;
      }
      if (!need) continue;
      if (geminiQueued) continue;
      const ahead = need.kind === "video" ? VIDEO_AHEAD_MS : IMAGE_AHEAD_MS;
      if (untilTime > ahead || usableGeminiAccounts(db, env, content, need.kind, now).length === 0) continue;
      if (enqueueContentOnce(db, need.kind === "video" ? "geminiVideo" : "geminiImage", post.id, { position: need.position })) {
        geminiQueued = true;
        actions.push(`gemini_${need.kind}:${post.id}#${need.position + 1}`);
      }
      continue;
    }

    if (post.status === "media_ready") {
      if (!stopIfDead(db, post, "content_render", "desenhando") && enqueueContentOnce(db, "contentRender", post.id)) actions.push(`render:${post.id}`);
      continue;
    }

    if (post.status === "ready" && content.autoPublish && untilTime <= 0) {
      if (!stopIfDead(db, post, "content_publish", "publicando") && enqueueContentOnce(db, "contentPublish", post.id)) actions.push(`publish:${post.id}`);
    }
  }
  // 3. Numbers of the published posts, to learn what the audience watches and shares.
  if (!hasOpenContentJob(db, ["content_insights"])) {
    const due = dueForInsights(db, content.account, now);
    if (due && enqueueContentOnce(db, "contentInsights", due.id)) actions.push(`insights:${due.id}`);
  }
  return actions.length > 0 ? actions.join(",") : "idle";
}
