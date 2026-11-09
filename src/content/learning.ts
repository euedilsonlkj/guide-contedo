import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { contentPosts, type ContentPost, type PostMetrics } from "@/db/schema";
import type { HookType, Pillar, ReelFormat } from "./schedule";

/**
 * What the published posts taught: which pillars and hooks got views and sends. The planner
 * gives more room to pillars that perform and shows the AI the best and worst hooks, so the
 * account drifts towards what its audience actually watches and shares.
 */

/** Score of one post: views first, with sends and saves counting extra (they weigh the most). */
export function postScore(metrics: PostMetrics): number {
  const views = metrics.views ?? metrics.reach ?? 0;
  return views + 25 * (metrics.shares ?? 0) + 10 * (metrics.saved ?? 0) + 2 * (metrics.interactions ?? 0);
}

export function measuredPosts(db: Executor, account: string, limit = 60): Array<ContentPost & { metrics: PostMetrics }> {
  return db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.account, account), eq(contentPosts.status, "published"), isNotNull(contentPosts.metrics)))
    .orderBy(desc(contentPosts.publishedAt))
    .limit(limit)
    .all() as Array<ContentPost & { metrics: PostMetrics }>;
}

/**
 * Pillar weights adjusted by results: a pillar with at least 2 measured posts gets its weight
 * multiplied by how it does against the average (between 0.6x and 1.8x), so no pillar dies out.
 */
export function learnedPillars(pillars: readonly Pillar[], posts: ReadonlyArray<{ pillar: string; metrics: PostMetrics }>): Pillar[] {
  if (posts.length < 4) return [...pillars];
  const average = posts.reduce((sum, post) => sum + postScore(post.metrics), 0) / posts.length || 1;
  return pillars.map((pillar) => {
    const own = posts.filter((post) => post.pillar === pillar.key);
    if (own.length < 2) return pillar;
    const mean = own.reduce((sum, post) => sum + postScore(post.metrics), 0) / own.length;
    const factor = Math.min(1.8, Math.max(0.6, mean / average));
    return { ...pillar, weight: Math.round(pillar.weight * factor * 100) / 100 };
  });
}

/** Options (hook kinds, Reel formats) weighted by results, the same way as the pillars. */
export function learnedWeights<T extends { key: string; weight: number }>(options: readonly T[], posts: ReadonlyArray<{ metrics: PostMetrics }>, keyOf: (post: never) => string | null): T[] {
  if (posts.length < 4) return [...options];
  const key = keyOf as (post: { metrics: PostMetrics }) => string | null;
  const average = posts.reduce((sum, post) => sum + postScore(post.metrics), 0) / posts.length || 1;
  return options.map((option) => {
    const own = posts.filter((post) => key(post) === option.key);
    if (own.length < 2) return option;
    const mean = own.reduce((sum, post) => sum + postScore(post.metrics), 0) / own.length;
    return { ...option, weight: Math.round(option.weight * Math.min(1.8, Math.max(0.6, mean / average)) * 100) / 100 };
  });
}

export function learnedHookTypes(hookTypes: readonly HookType[], posts: ReadonlyArray<{ hookType: string | null; metrics: PostMetrics }>): HookType[] {
  return learnedWeights(hookTypes, posts, (post: { hookType: string | null }) => post.hookType);
}

/** Reel formats weighted by how their Reels did (only Reels count). */
export function learnedFormats(formats: readonly ReelFormat[], posts: ReadonlyArray<{ kind: string; format: string | null; metrics: PostMetrics }>): ReelFormat[] {
  return learnedWeights(formats, posts.filter((post) => post.kind === "reel"), (post: { format: string | null }) => post.format);
}

/** Lines for the planner prompt: the hooks that worked and the ones that did not. */
export function performanceBrief(posts: ReadonlyArray<ContentPost & { metrics: PostMetrics }>): string {
  if (posts.length < 3) return "";
  const ranked = [...posts].sort((a, b) => postScore(b.metrics) - postScore(a.metrics));
  const line = (post: ContentPost & { metrics: PostMetrics }) =>
    `- ${post.kind} [${post.pillar}${post.hookType ? `, hook ${post.hookType}` : ""}${post.format ? `, format ${post.format}` : ""}] "${post.hook ?? post.topic}": ${post.metrics.views ?? post.metrics.reach ?? 0} views, ${post.metrics.shares ?? 0} sends, ${post.metrics.saved ?? 0} saves`;
  const top = ranked.slice(0, 3).map(line).join("\n");
  const bottom = ranked.slice(-3).reverse().map(line).join("\n");
  return `WHAT WORKED BEST on this account (make more like these: same kind of tension, situation and promise, never the same words):\n${top}\n\nWHAT WORKED WORST (avoid this kind of hook and angle):\n${bottom}`;
}
