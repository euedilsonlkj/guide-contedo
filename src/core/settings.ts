import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "@/db/client";
import { settings } from "@/db/schema";

export const SETTING_SCHEMAS = {
  /** Paused by the operator in the panel. */
  content_paused: z.object({ paused: z.boolean(), at: z.string().nullable() }),
  /**
   * Per Gemini account: until when it said the daily video (or image) limit was reached, and
   * until when it is left aside because its Chrome was closed or logged out.
   */
  gemini_blocks: z.record(z.string(), z.object({ video: z.string().nullable(), image: z.string().nullable(), down: z.string().nullable() })),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;

export const SETTING_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  content_paused: { paused: false, at: null },
  gemini_blocks: {},
};

export function getSetting<K extends SettingKey>(db: Executor, key: K): SettingValue<K> {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return SETTING_DEFAULTS[key];
  const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
  return parsed.success ? (parsed.data as SettingValue<K>) : SETTING_DEFAULTS[key];
}

export function setSetting<K extends SettingKey>(db: Executor, key: K, value: SettingValue<K>): void {
  const valid = SETTING_SCHEMAS[key].parse(value);
  db.insert(settings)
    .values({ key, value: valid })
    .onConflictDoUpdate({ target: settings.key, set: { value: valid, updatedAt: new Date() } })
    .run();
}
