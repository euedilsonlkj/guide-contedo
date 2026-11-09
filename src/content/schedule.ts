import type { ContentConfig } from "@/lib/config";
import { DAY_MS, localClock } from "@/lib/time";

export type { ContentConfig };
export type Pillar = ContentConfig["pillars"][number];
export type HookType = ContentConfig["hookTypes"][number];
export type ReelFormat = ContentConfig["reelFormats"][number];
export type PostKind = "carousel" | "reel";

export interface Slot {
  kind: PostKind;
  at: Date;
  /** Local day, YYYY-MM-DD. */
  dateKey: string;
}

/** Offset (ms) of `timeZone` from UTC at the instant `at`. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant of a local date and time ("2026-11-09", "18:30") in `timeZone`. */
export function zonedInstant(dateKey: string, hhmm: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - zoneOffsetMs(new Date(naive), timeZone);
  // A second pass settles the rare case of a daylight-saving change between the two guesses.
  guess = naive - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** Every post slot from `from` (inclusive) for `days` local days, in time order. */
export function upcomingSlots(content: ContentConfig, timeZone: string, from: Date, days: number): Slot[] {
  const slots: Slot[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const clock = localClock(new Date(from.getTime() + offset * DAY_MS), timeZone);
    const plan: Array<[PostKind, number[], string]> = [
      ["carousel", content.carouselDays, content.carouselTime],
      ["reel", content.reelDays, content.reelTime],
    ];
    for (const [kind, weekdays, time] of plan) {
      if (!weekdays.includes(clock.weekday)) continue;
      const at = zonedInstant(clock.dateKey, time, timeZone);
      // Today's slot that already passed is not planned anymore.
      if (at.getTime() < from.getTime()) continue;
      slots.push({ kind, at, dateKey: clock.dateKey });
    }
  }
  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Picks the pillar of each new slot so the feed keeps changing: the pillar used least often
 * (relative to its weight) in the recent posts wins, and the same pillar never comes twice
 * in a row. `recent` is the pillar of each recent post, oldest first.
 */
export function assignPillars(pillars: readonly Pillar[], slots: readonly Slot[], recent: readonly string[], window = 12): string[] {
  const history = [...recent];
  const result: string[] = [];
  for (const slot of slots) {
    const eligible = pillars.filter((pillar) => pillar.kinds.includes(slot.kind) && pillar.weight > 0);
    if (eligible.length === 0) throw new Error(`no pillar accepts ${slot.kind}`);
    const last = history.at(-1);
    const window_ = history.slice(-window);
    const ranked = eligible
      .map((pillar, index) => ({
        key: pillar.key,
        index,
        load: window_.filter((key) => key === pillar.key).length / pillar.weight,
        // How long ago it was used (bigger is better); never used counts as the longest.
        since: (() => {
          const position = history.lastIndexOf(pillar.key);
          return position === -1 ? Number.MAX_SAFE_INTEGER : history.length - position;
        })(),
      }))
      .filter((item) => eligible.length === 1 || item.key !== last)
      .sort((a, b) => a.load - b.load || b.since - a.since || a.index - b.index);
    const chosen = ranked[0].key;
    result.push(chosen);
    history.push(chosen);
  }
  return result;
}

/**
 * Rotation of weighted options (hook kinds, Reel formats): each new item gets the option used
 * least (relative to its weight) in the recent window, never the same twice in a row.
 * `recent` is the key of each recent post, oldest first (null when it had none).
 */
export function rotate(options: ReadonlyArray<{ key: string; weight: number }>, count: number, recent: ReadonlyArray<string | null>, window = 14): string[] {
  const history = recent.filter((key): key is string => Boolean(key));
  const result: string[] = [];
  const usable = options.filter((option) => option.weight > 0);
  const pool = usable.length > 0 ? usable : [...options];
  for (let item = 0; item < count; item += 1) {
    const last = history.at(-1);
    const recentWindow = history.slice(-window);
    const ranked = pool
      .map((option, index) => ({
        key: option.key,
        index,
        load: recentWindow.filter((key) => key === option.key).length / Math.max(option.weight, 0.01),
        since: (() => {
          const position = history.lastIndexOf(option.key);
          return position === -1 ? Number.MAX_SAFE_INTEGER : history.length - position;
        })(),
      }))
      .filter((option) => pool.length === 1 || option.key !== last)
      .sort((a, b) => a.load - b.load || b.since - a.since || a.index - b.index);
    result.push(ranked[0].key);
    history.push(ranked[0].key);
  }
  return result;
}

/** Hook kind of each new slot (see `rotate`). */
export function assignHookTypes(hookTypes: readonly HookType[], slots: readonly Slot[], recent: ReadonlyArray<string | null>, window = 14): string[] {
  return rotate(hookTypes, slots.length, recent, window);
}

/** Reel format of each new slot (carousels get null). */
export function assignFormats(formats: readonly ReelFormat[], slots: readonly Slot[], recent: ReadonlyArray<string | null>, window = 10): Array<string | null> {
  const reels = rotate(formats, slots.filter((slot) => slot.kind === "reel").length, recent, window);
  return slots.map((slot) => (slot.kind === "reel" ? (reels.shift() ?? null) : null));
}
