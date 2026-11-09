import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { jobs, type Job } from "@/db/schema";
import { MINUTE_MS } from "@/lib/time";
import { recordEvent } from "./journal";

export const JOB_TYPES = {
  contentPlan: { type: "content_plan", lane: "content" },
  contentWrite: { type: "content_write", lane: "content" },
  contentRender: { type: "content_render", lane: "content" },
  contentPublish: { type: "content_publish", lane: "content" },
  contentInsights: { type: "content_insights", lane: "content" },
  geminiImage: { type: "gemini_image", lane: "gemini" },
  geminiVideo: { type: "gemini_video", lane: "gemini" },
} as const;

export type JobKind = keyof typeof JOB_TYPES;
export type JobType = (typeof JOB_TYPES)[JobKind]["type"];
export type Lane = Job["lane"];

export interface EnqueueInput {
  kind: JobKind;
  payload?: Record<string, unknown>;
  runAt?: Date;
  idempotencyKey?: string;
  maxAttempts?: number;
}

/** Inserts a job. With an idempotency key, a second enqueue of the same work is a no-op. */
export function enqueueJob(db: Executor, input: EnqueueInput): Job | undefined {
  const spec = JOB_TYPES[input.kind];
  return db
    .insert(jobs)
    .values({ type: spec.type, lane: spec.lane, payload: input.payload ?? {}, runAt: input.runAt ?? new Date(), idempotencyKey: input.idempotencyKey ?? null, maxAttempts: input.maxAttempts ?? 3 })
    .onConflictDoNothing()
    .returning()
    .get();
}

/** Claims the next due job of a lane (one job at a time per lane). */
export function claimNextJob(db: Executor, lane: Lane, now = new Date()): Job | undefined {
  return db.transaction((tx) => {
    const busy = tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.lane, lane), eq(jobs.status, "running"))).get();
    if (busy) return undefined;
    const next = tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), eq(jobs.lane, lane), lte(jobs.runAt, now)))
      .orderBy(asc(jobs.runAt), asc(jobs.id))
      .limit(1)
      .get();
    if (!next) return undefined;
    return tx
      .update(jobs)
      .set({ status: "running", attempts: sql`${jobs.attempts} + 1` })
      .where(and(eq(jobs.id, next.id), eq(jobs.status, "pending")))
      .returning()
      .get();
  });
}

export function completeJob(db: Executor, jobId: number, note: string | null = null): void {
  db.update(jobs).set({ status: "done", finishedAt: new Date(), lastError: note }).where(eq(jobs.id, jobId)).run();
}

/** Puts a running job back without spending an attempt. */
export function deferJob(db: Executor, jobId: number, runAt: Date, reason: string): void {
  db.update(jobs)
    .set({ status: "pending", runAt, lastError: reason, attempts: sql`max(${jobs.attempts} - 1, 0)` })
    .where(eq(jobs.id, jobId))
    .run();
}

/** Retries with backoff; an exhausted job is dead (the planner then stops its post for the operator). */
export function failJob(db: Executor, job: Job, error: string, now = new Date()): "retry" | "dead" {
  if (job.attempts >= job.maxAttempts) {
    db.update(jobs).set({ status: "dead", lastError: error, finishedAt: now }).where(eq(jobs.id, job.id)).run();
    recordEvent(db, "job_dead", { jobId: job.id, type: job.type, error });
    return "dead";
  }
  const backoff = Math.min(60, 2 ** job.attempts) * MINUTE_MS;
  db.update(jobs)
    .set({ status: "pending", lastError: error, runAt: new Date(now.getTime() + backoff) })
    .where(eq(jobs.id, job.id))
    .run();
  return "retry";
}

/** After a restart, jobs left running go back to the queue without spending the attempt. */
export function recoverRunningJobs(db: Executor): number {
  return db
    .update(jobs)
    .set({ status: "pending", lastError: "recovered after restart", attempts: sql`max(${jobs.attempts} - 1, 0)` })
    .where(eq(jobs.status, "running"))
    .returning({ id: jobs.id })
    .all().length;
}
