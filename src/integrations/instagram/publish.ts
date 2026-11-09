import { z } from "zod";
import type { Env } from "@/lib/env";

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

export class MetaNotConfiguredError extends Error {
  constructor() {
    super("Meta API not configured: INSTAGRAM_TOKEN and INSTAGRAM_ACCOUNT_ID");
    this.name = "MetaNotConfiguredError";
  }
}

/**
 * Content publishing with the Instagram API (Instagram Login, graph.instagram.com): a media
 * container per image or video, a carousel container, wait until Meta finished processing,
 * then media_publish. The token needs the instagram_business_content_publish permission.
 * Meta downloads every file from a public URL (the tunnel), so the files must stay reachable
 * until the container is FINISHED.
 */

const idSchema = z.object({ id: z.string() });
const statusSchema = z.object({ status_code: z.string().optional(), status: z.string().optional() });
const permalinkSchema = z.object({ permalink: z.string().optional() });
const errorSchema = z.object({ error: z.object({ message: z.string(), code: z.number().optional() }) });

interface Creds {
  token: string;
  accountId: string;
  baseUrl: string;
}

async function request(creds: Creds, method: "GET" | "POST", pathname: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${creds.baseUrl}/${pathname}`);
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(60_000) };
  if (method === "GET") for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  else {
    init.body = new URLSearchParams(params);
    (init.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded";
  }
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new MetaApiError(`network: ${error instanceof Error ? error.message : error}`, 0, null, true);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (response.ok) return body;
  const parsed = errorSchema.safeParse(body);
  throw new MetaApiError(parsed.success ? parsed.data.error.message : `HTTP ${response.status}`, response.status, parsed.success ? (parsed.data.error.code ?? null) : null, response.status >= 500 || response.status === 429);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until Meta finished downloading and processing a container. */
export async function waitForContainer(creds: Creds, containerId: string, timeoutMs: number, pollMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = statusSchema.parse(await request(creds, "GET", containerId, { fields: "status_code,status" }));
    const code = body.status_code ?? "";
    if (code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR" || code === "EXPIRED") throw new MetaApiError(`container ${code}: ${body.status ?? ""}`.trim(), 400, null, false);
    if (Date.now() > deadline) throw new MetaApiError(`container still ${code || "IN_PROGRESS"} after ${Math.round(timeoutMs / 1000)}s`, 0, null, true);
    await sleep(pollMs);
  }
}

export interface PublishResult {
  containerId: string;
  mediaId: string;
  permalink: string | null;
}

export interface PublishHooks {
  /** Called with the final container right before media_publish (stored to avoid a double post). */
  beforePublish: (containerId: string) => void;
  pollMs?: number;
}

async function finish(creds: Creds, containerId: string, hooks: PublishHooks): Promise<PublishResult> {
  hooks.beforePublish(containerId);
  const published = idSchema.parse(await request(creds, "POST", `${creds.accountId}/media_publish`, { creation_id: containerId }));
  const link = await request(creds, "GET", published.id, { fields: "permalink" })
    .then((body) => permalinkSchema.parse(body).permalink ?? null)
    .catch(() => null);
  return { containerId, mediaId: published.id, permalink: link };
}

export const INSTAGRAM_GRAPH = "https://graph.instagram.com/v25.0";
export const FACEBOOK_GRAPH = "https://graph.facebook.com/v25.0";

/** The Graph API host that accepts this token (an explicit address in .env wins). */
export function graphBaseUrl(token: string, explicit?: string): string {
  if (explicit) return explicit;
  return token.startsWith("EAA") ? FACEBOOK_GRAPH : INSTAGRAM_GRAPH;
}

export function hasMetaCredentials(env: Env): boolean {
  return Boolean(env.INSTAGRAM_TOKEN && env.INSTAGRAM_ACCOUNT_ID);
}

export function publishCredentials(env: Env): Creds {
  if (!env.INSTAGRAM_TOKEN || !env.INSTAGRAM_ACCOUNT_ID) throw new MetaNotConfiguredError();
  return { token: env.INSTAGRAM_TOKEN, accountId: env.INSTAGRAM_ACCOUNT_ID, baseUrl: graphBaseUrl(env.INSTAGRAM_TOKEN, env.INSTAGRAM_GRAPH_BASE_URL) };
}

export async function publishCarousel(env: Env, imageUrls: readonly string[], caption: string, hooks: PublishHooks): Promise<PublishResult> {
  const creds = publishCredentials(env);
  const pollMs = hooks.pollMs ?? 5000;
  if (imageUrls.length === 1) {
    const single = idSchema.parse(await request(creds, "POST", `${creds.accountId}/media`, { image_url: imageUrls[0], caption }));
    await waitForContainer(creds, single.id, 120_000, pollMs);
    return finish(creds, single.id, hooks);
  }
  const children: string[] = [];
  for (const url of imageUrls) {
    const child = idSchema.parse(await request(creds, "POST", `${creds.accountId}/media`, { image_url: url, is_carousel_item: "true" }));
    children.push(child.id);
  }
  for (const child of children) await waitForContainer(creds, child, 120_000, pollMs);
  const carousel = idSchema.parse(await request(creds, "POST", `${creds.accountId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption }));
  await waitForContainer(creds, carousel.id, 120_000, pollMs);
  return finish(creds, carousel.id, hooks);
}

/** `coverUrl`: JPEG shown as the Reel's thumbnail in the feed and on the profile grid. */
export async function publishReel(env: Env, videoUrl: string, caption: string, hooks: PublishHooks, coverUrl?: string): Promise<PublishResult> {
  const creds = publishCredentials(env);
  const params: Record<string, string> = { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: "true" };
  if (coverUrl) params.cover_url = coverUrl;
  const reel = idSchema.parse(await request(creds, "POST", `${creds.accountId}/media`, params));
  await waitForContainer(creds, reel.id, 10 * 60_000, hooks.pollMs ?? 10_000);
  return finish(creds, reel.id, hooks);
}

const insightsSchema = z.object({
  data: z.array(z.object({ name: z.string(), values: z.array(z.object({ value: z.number() })).optional(), total_value: z.object({ value: z.number() }).optional() })),
});

/** Lifetime numbers of a published post. Metrics Meta does not offer for this media are left out. */
export async function fetchInsights(env: Env, mediaId: string): Promise<Record<string, number>> {
  const creds = publishCredentials(env);
  const attempts = [["views", "reach", "shares", "saved", "total_interactions"], ["reach", "shares", "saved", "total_interactions"], ["reach", "saved"]];
  let lastError: unknown;
  for (const metrics of attempts) {
    try {
      const body = insightsSchema.parse(await request(creds, "GET", `${mediaId}/insights`, { metric: metrics.join(",") }));
      const result: Record<string, number> = {};
      for (const item of body.data) result[item.name] = item.total_value?.value ?? item.values?.[0]?.value ?? 0;
      return result;
    } catch (error) {
      lastError = error;
      // An unsupported metric is a 400; anything else is a real failure.
      if (!(error instanceof MetaApiError) || error.status !== 400) throw error;
    }
  }
  throw lastError;
}
