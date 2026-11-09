export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export interface LocalClock {
  dateKey: string;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localClock(at: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

export interface HourRange {
  startMinutes: number;
  endMinutes: number;
}

export function parseHourRange(range: string): HourRange {
  const [start, end] = range.split("-");
  const toMinutes = (value: string) => {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  };
  return { startMinutes: toMinutes(start), endMinutes: toMinutes(end) };
}

export function isWithinRange(at: Date, range: HourRange, timeZone: string): boolean {
  const clock = localClock(at, timeZone);
  const minutes = clock.hour * 60 + clock.minute;
  return minutes >= range.startMinutes && minutes < range.endMinutes;
}

/** Next instant (minute resolution) at or after `from` that falls inside `range`. */
export function nextInstantWithin(from: Date, range: HourRange, timeZone: string): Date {
  if (isWithinRange(from, range, timeZone)) return from;
  const cursor = new Date(Math.ceil(from.getTime() / MINUTE_MS) * MINUTE_MS);
  for (let step = 0; step < 2 * 24 * 60; step += 5) {
    const candidate = new Date(cursor.getTime() + step * MINUTE_MS);
    if (isWithinRange(candidate, range, timeZone)) return candidate;
  }
  return new Date(from.getTime() + DAY_MS);
}

export function randomBetween(min: number, max: number, random: () => number = Math.random): number {
  return Math.round(min + (max - min) * random());
}
