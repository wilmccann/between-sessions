// Local-time helpers for series timezones, and the next session computed
// from a series' weekly schedule (never stored).
import { hasSchedule, type Series } from "./series.js";

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

// The next scheduled session that hasn't ended yet, or null when the series
// has no schedule.
export function nextSession(series: Series, now = Date.now()): { start: number; end: number } | null {
  if (!hasSchedule(series)) return null;
  const startMin = toMinutes(series.windowStart);
  const endMin = toMinutes(series.windowEnd);
  const today = localParts(now, series.timezone);
  // Walk calendar dates, not 24-hour steps, so DST days aren't skipped.
  for (let d = 0; d <= 7; d++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + d));
    if (date.getUTCDay() !== series.weekday) continue;
    const [y, m, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const start = zonedTime(y, m, day, startMin, series.timezone);
    const end = zonedTime(y, m, day, endMin, series.timezone);
    if (end > now) return { start, end };
  }
  return null;
}
