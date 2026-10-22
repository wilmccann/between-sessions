// Local-time helpers for series timezones, and the next session computed
// from a series' slots (never stored).
import { hasSchedule, type Series } from "./series.js";
import { instant, lastDatedDate, slotsBetween } from "./slots.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function localParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
    minutes: hour * 60 + Number(get("minute")),
    seconds: Number(get("second")),
  };
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function formatLocal(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "full", timeStyle: "short" }).format(ms);
}

// "Tue 17:00": short enough to speak.
export function formatShort(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

// The instant of a local wall-clock time in timeZone.
export function zonedTime(year: number, month: number, day: number, minutes: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  const offsetAt = (ms: number) => {
    const p = localParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60, p.seconds) - ms;
  };
  const guess = wall - offsetAt(wall);
  return wall - offsetAt(guess);
}

// The next slot (weekly or dated) that hasn't ended yet, or null when the
// series has none coming. Looks a week past the last dated entry, so a
// skipped week still finds the slot after it.
export function nextSession(series: Series, now = Date.now()): { start: number; end: number } | null {
  if (!hasSchedule(series) && !series.dated.length) return null;
  const last = lastDatedDate(series);
  const horizon = Math.max(now, last ? instant(last, "00:00", series.timezone) : now) + 8 * DAY;
  const next = slotsBetween(series, now, horizon).find((s) => s.end > now);
  return next ? { start: next.start, end: next.end } : null;
}
