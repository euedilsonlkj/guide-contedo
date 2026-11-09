import { gte, sql } from "drizzle-orm";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import type { Executor } from "@/db/client";
import { aiCalls } from "@/db/schema";
import { raiseAlert } from "@/core/journal";
import type { Env } from "@/lib/env";

export class BudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(`OpenAI monthly budget reached: ${spent.toFixed(4)} of ${budget} USD`);
    this.name = "BudgetExceededError";
  }
}

export class AiUnavailableError extends Error {
  constructor(public readonly reason: "missing_api_key") {
    super(`AI unavailable: ${reason}`);
    this.name = "AiUnavailableError";
  }
}

export class AiOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiOutputError";
  }
}

export interface StructuredRequest<S extends z.ZodType> {
  purpose: string;
  schema: S;
  schemaName: string;
  instructions: string;
  input: string;
  maxOutputTokens?: number;
}

const CHARS_PER_TOKEN = 3.5;
let client: OpenAI | undefined;
let clientKey: string | undefined;

export function getClient(env: Env): OpenAI {
  if (!env.OPENAI_API_KEY) throw new AiUnavailableError("missing_api_key");
  if (!client || clientKey !== `${env.OPENAI_API_KEY}|${env.OPENAI_BASE_URL}`) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, maxRetries: 1, timeout: 120_000 });
    clientKey = `${env.OPENAI_API_KEY}|${env.OPENAI_BASE_URL}`;
  }
  return client;
}

export function costUsd(env: Env, inputTokens: number, outputTokens: number): number {
  return (inputTokens * env.OPENAI_PRICE_PER_MTOK.input + outputTokens * env.OPENAI_PRICE_PER_MTOK.output) / 1_000_000;
}

export function monthToDateSpend(db: Executor, now = new Date()): number {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return db.select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)` }).from(aiCalls).where(gte(aiCalls.createdAt, start)).get()?.total ?? 0;
}

/** Stops before a call that would cross the monthly ceiling. */
export function assertBudget(db: Executor, env: Env, worstCaseUsd: number): void {
  const spent = monthToDateSpend(db);
  if (spent + worstCaseUsd >= env.OPENAI_MONTHLY_BUDGET_USD) {
    raiseAlert(db, "warning", "openai_budget", `O teto mensal da OpenAI (US$ ${env.OPENAI_MONTHLY_BUDGET_USD}) foi atingido: a IA volta no mês que vem ou suba OPENAI_MONTHLY_BUDGET_USD no .env.`);
    throw new BudgetExceededError(spent, env.OPENAI_MONTHLY_BUDGET_USD);
  }
}

/** One call with structured output; stops before a call that could cross the monthly ceiling. */
export async function generateStructured<S extends z.ZodType>(db: Executor, env: Env, request: StructuredRequest<S>): Promise<z.infer<S>> {
  const openai = getClient(env);
  const maxOutputTokens = Math.max(2000, request.maxOutputTokens ?? 4000);
  assertBudget(db, env, costUsd(env, Math.ceil((request.instructions.length + request.input.length) / CHARS_PER_TOKEN), maxOutputTokens));
  try {
    const response = await openai.responses.parse({
      model: env.OPENAI_MODEL,
      instructions: request.instructions,
      input: request.input,
      max_output_tokens: maxOutputTokens,
      text: { format: zodTextFormat(request.schema, request.schemaName) },
    });
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const ok = response.output_parsed !== null;
    db.insert(aiCalls)
      .values({ purpose: request.purpose, model: env.OPENAI_MODEL, inputTokens, outputTokens, costUsd: costUsd(env, inputTokens, outputTokens), ok, error: ok ? null : "empty_output" })
      .run();
    if (!ok) throw new AiOutputError(`no parsed output for ${request.purpose}`);
    return response.output_parsed as z.infer<S>;
  } catch (error) {
    if (error instanceof AiOutputError) throw error;
    db.insert(aiCalls)
      .values({ purpose: request.purpose, model: env.OPENAI_MODEL, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) })
      .run();
    throw error;
  }
}
