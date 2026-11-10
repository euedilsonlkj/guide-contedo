import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/** Durable work queue: one lane for AI, drawing and publishing, one for Gemini in the browser. */
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    lane: text("lane", { enum: ["content", "gemini"] }).notNull(),
    payload: json<Record<string, unknown>>("payload").notNull().$defaultFn(() => ({})),
    status: text("status", { enum: ["pending", "running", "done", "dead", "cancelled"] }).notNull().default("pending"),
    runAt: timestamp("run_at").notNull().$defaultFn(() => new Date()),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key"),
    finishedAt: timestamp("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("jobs_idempotency_unique").on(t.idempotencyKey), index("jobs_claim_idx").on(t.status, t.lane, t.runAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  updatedAt: updatedAt(),
});

/** Things the operator should see in the panel (one open alert per code). */
export const alerts = sqliteTable(
  "alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull(),
    severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
    message: text("message").notNull(),
    acknowledgedAt: timestamp("acknowledged_at"),
    createdAt: createdAt(),
  },
  (t) => [index("alerts_open_idx").on(t.code, t.acknowledgedAt)],
);

/** What happened, for the logs and the panel. */
export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  payload: json<Record<string, unknown>>("payload").notNull(),
  createdAt: createdAt(),
});

/** Every OpenAI call, with its cost, for the monthly ceiling. */
export const aiCalls = sqliteTable("ai_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purpose: text("purpose").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  error: text("error"),
  createdAt: createdAt(),
});

export type Job = typeof jobs.$inferSelect;
export type Alert = typeof alerts.$inferSelect;

// ---------------------------------------------------------------- content (Instagram posts)

export const CONTENT_KINDS = ["carousel", "reel"] as const;
export const CONTENT_STATUSES = [
  /** Slot of the week with a topic chosen by the planner. */
  "planned",
  /** Script, caption and media prompts written. */
  "written",
  /** Gemini images and video clips downloaded; waiting for the render. */
  "media_ready",
  /** Final files (JPEG slides or MP4) built; waiting for the scheduled time. */
  "ready",
  "publishing",
  "published",
  /** Needs the operator (see error). */
  "failed",
  /** Not published (missed its day, or skipped by the operator). */
  "skipped",
] as const;

export interface PostMetrics {
  views: number | null;
  reach: number | null;
  shares: number | null;
  saved: number | null;
  interactions: number | null;
}

/** Where a post came from: the weekly plan, or the operator's own photos sent in the panel. */
export const CONTENT_ORIGINS = ["plan", "photos"] as const;
export type ContentOrigin = (typeof CONTENT_ORIGINS)[number];

/** Label the operator gives each photo of a photo post. */
export const PHOTO_LABELS = ["antes", "depois", "detalhe", ""] as const;
export type PhotoLabel = (typeof PHOTO_LABELS)[number];

/** What the operator sent for a post made from their photos. */
export interface PhotoBrief {
  /** Kind of content (config photoTypes), e.g. "antes_depois". */
  type: string;
  /** What the operator wrote about the job, in their own words: the only facts about it the post may state. */
  note: string;
  /** Photos in slide order, relative to CONTENT_DIR. */
  photos: Array<{ file: string; label: PhotoLabel }>;
}

/** Files of a post, relative to CONTENT_DIR. */
export interface ContentMedia {
  /** Gemini photo for the carousel cover. */
  image?: string | null;
  /** Gemini could not make the cover photo: the cover is drawn without it. */
  imageSkipped?: boolean;
  /** The operator's photo used by "frase" posts. */
  photo?: string | null;
  /** Reel: portrait of the series character (the same file for every Reel), sent as reference with every scene. */
  character?: string | null;
  characterSkipped?: boolean;
  /** Reel: narration audio of each scene. */
  narration?: string[];
  /** One Gemini clip per Reel scene (null while missing). */
  clips?: Array<string | null>;
  /** Scenes whose clip Gemini could not make: they become text cards. */
  clipsGivenUp?: number[];
  /** Final JPEG slides of a carousel. */
  slides?: string[];
  /** Reel made from the operator's photos: the photo shown in each scene (instead of Gemini clips). */
  stills?: string[];
  /** Final MP4 of a Reel. */
  video?: string;
  /** Reel cover (thumbnail) with the hook in big type, sent as cover_url. */
  cover?: string;
}

/** One post of the content calendar: a carousel or a Reel, at a fixed time. */
export const contentPosts = sqliteTable(
  "content_posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Sender key of the Instagram account that publishes it (config content.account). */
    account: text("account").notNull(),
    kind: text("kind", { enum: CONTENT_KINDS }).notNull(),
    pillar: text("pillar").notNull(),
    /** Kind of viral hook it opens with (config hookTypes). */
    hookType: text("hook_type"),
    /** Reel: viral format it follows (config reelFormats). */
    format: text("format"),
    /** Reel of the series: episode number (Parte N). */
    episode: integer("episode"),
    scheduledAt: timestamp("scheduled_at").notNull(),
    status: text("status", { enum: CONTENT_STATUSES }).notNull().default("planned"),
    /** "plan": chosen by the weekly plan; "photos": made from the operator's photos sent in the panel. */
    origin: text("origin", { enum: CONTENT_ORIGINS }).notNull().default("plan"),
    /** Photo post: the photos and what the operator said about them. */
    brief: json<PhotoBrief>("brief"),
    /**
     * How the post ends: null = the config's call to action, "" = no call to action, any other
     * text = the call to action the operator wrote for this post.
     */
    cta: text("cta"),
    topic: text("topic").notNull(),
    angle: text("angle"),
    hook: text("hook"),
    /** Carousel slides or Reel scenes, as written by the AI (features/content/write.ts). */
    script: json<Record<string, unknown>>("script"),
    caption: text("caption"),
    /** Generated and final files, relative to CONTENT_DIR. */
    media: json<ContentMedia>("media")
      .notNull()
      .$defaultFn(() => ({})),
    containerId: text("container_id"),
    igMediaId: text("ig_media_id"),
    permalink: text("permalink"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    publishedAt: timestamp("published_at"),
    /** Instagram numbers of the published post (views, reach, shares, saves, interactions). */
    metrics: json<PostMetrics>("metrics"),
    metricsAt: timestamp("metrics_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("content_posts_slot_unique").on(t.account, t.kind, t.scheduledAt), index("content_posts_status_idx").on(t.status, t.scheduledAt)],
);

/** Every image or video asked to Gemini in the browser; counts the daily limit. */
export const geminiRuns = sqliteTable(
  "gemini_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id").references(() => contentPosts.id),
    /** Which Gemini account (1, 2, ...) made it. */
    account: text("account").notNull().default("1"),
    kind: text("kind", { enum: ["image", "video"] }).notNull(),
    /** Position of the clip or image inside the post. */
    position: integer("position").notNull().default(0),
    prompt: text("prompt").notNull(),
    status: text("status", { enum: ["running", "done", "failed", "limit"] }).notNull(),
    file: text("file"),
    error: text("error"),
    /** Operator's local day (YYYY-MM-DD) for the daily limit. */
    dateKey: text("date_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("gemini_runs_day_idx").on(t.kind, t.dateKey)],
);

export type ContentPost = typeof contentPosts.$inferSelect;
export type ContentKind = (typeof CONTENT_KINDS)[number];
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export type GeminiRun = typeof geminiRuns.$inferSelect;
