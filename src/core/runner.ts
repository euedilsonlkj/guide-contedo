import type { Db } from "@/db/client";
import type { Job } from "@/db/schema";
import { planContentWork } from "@/content/planner";
import { runContentInsights, runContentPlan, runContentPublish, runContentRender, runContentWrite, runGemini, type ContentOutcome } from "@/content/posts";
import { AiUnavailableError, BudgetExceededError } from "@/integrations/openai/client";
import type { ContentConfig } from "@/lib/config";
import type { Env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { HOUR_MS } from "@/lib/time";
import { raiseAlert, recordEvent } from "./journal";
import { claimNextJob, completeJob, deferJob, failJob, type JobType, type Lane } from "./queue";

export interface WorkerContext {
  db: Db;
  env: Env;
  config: ContentConfig;
}

export async function dispatch(context: WorkerContext, job: Job): Promise<ContentOutcome> {
  const { db, env, config } = context;
  switch (job.type as JobType) {
    case "content_plan":
      return runContentPlan(db, env, config);
    case "content_write":
      return runContentWrite(db, env, config, job);
    case "content_render":
      return runContentRender(db, env, config, job);
    case "content_publish":
      return runContentPublish(db, env, config, job);
    case "content_insights":
      return runContentInsights(db, env, job);
    case "gemini_image":
      return runGemini(db, env, config, job, "image");
    case "gemini_video":
      return runGemini(db, env, config, job, "video");
  }
  return { status: "skipped", detail: `unknown job type ${job.type}` };
}

export async function runJob(context: WorkerContext, job: Job): Promise<void> {
  const { db } = context;
  try {
    const outcome = await dispatch(context, job);
    if (outcome.status === "deferred") deferJob(db, job.id, outcome.retryAt, outcome.detail);
    else completeJob(db, job.id, outcome.status === "done" ? null : outcome.detail.slice(0, 300));
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (error instanceof AiUnavailableError) {
      raiseAlert(db, "warning", "missing_openai_key", "Falta a OPENAI_API_KEY no .env: o conteúdo espera até ela ser colocada.");
      deferJob(db, job.id, new Date(Date.now() + HOUR_MS), message);
      return;
    }
    if (error instanceof BudgetExceededError) {
      deferJob(db, job.id, new Date(Date.now() + 6 * HOUR_MS), message);
      return;
    }
    logger.error("job failed", { jobId: job.id, type: job.type, error: message });
    recordEvent(db, "job_attempt_failed", { jobId: job.id, type: job.type, error: message.slice(0, 300) });
    failJob(db, job, message);
  }
}

/** The planner every 30 seconds, and one loop per lane (AI/drawing/publishing, and Gemini). */
export class Worker {
  private stopping = false;
  private readonly loops: Promise<void>[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly context: WorkerContext) {}

  start(pollMs = 1000, planEveryMs = 30_000): void {
    const tick = () => {
      try {
        const result = planContentWork(this.context.db, this.context.env, this.context.config);
        if (result !== "idle") logger.info("planner", { result });
      } catch (error) {
        logger.error("planner failed", { error });
      }
    };
    tick();
    this.timer = setInterval(tick, planEveryMs);
    for (const lane of ["content", "gemini"] as Lane[]) this.loops.push(this.loop(lane, pollMs));
  }

  private async loop(lane: Lane, pollMs: number): Promise<void> {
    while (!this.stopping) {
      let job: Job | undefined;
      try {
        job = claimNextJob(this.context.db, lane);
      } catch (error) {
        logger.error("claim failed", { lane, error });
      }
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      await runJob(this.context, job);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.race([Promise.all(this.loops), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  }
}
