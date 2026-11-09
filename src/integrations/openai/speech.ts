import { writeFileSync } from "node:fs";
import type { Executor } from "@/db/client";
import { aiCalls } from "@/db/schema";
import type { Env } from "@/lib/env";
import { assertBudget, getClient } from "./client";

export interface SpeechRequest {
  text: string;
  voice: string;
  model: string;
  /** How to speak (accent, tone, pace). */
  style: string;
  pricePerMinuteUsd: number;
  file: string;
}

/** Spoken Portuguese at roughly 2.6 words per second, for the cost estimate. */
function estimatedMinutes(text: string): number {
  return text.trim().split(/\s+/).length / 2.6 / 60;
}

/** Narration of one Reel scene as an MP3 file, with its cost recorded like any AI call. */
export async function synthesizeSpeech(db: Executor, env: Env, request: SpeechRequest): Promise<string> {
  const openai = getClient(env);
  const cost = estimatedMinutes(request.text) * request.pricePerMinuteUsd;
  assertBudget(db, env, cost * 2);
  try {
    const response = await openai.audio.speech.create({
      model: request.model,
      voice: request.voice as never,
      input: request.text,
      instructions: request.style,
      response_format: "mp3",
    });
    writeFileSync(request.file, Buffer.from(await response.arrayBuffer()));
    db.insert(aiCalls).values({ purpose: "reel_narration", model: request.model, costUsd: cost, ok: true }).run();
    return request.file;
  } catch (error) {
    db.insert(aiCalls)
      .values({ purpose: "reel_narration", model: request.model, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) })
      .run();
    throw error;
  }
}
