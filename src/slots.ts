// A series' slots: the weekly slot on its weekday, and dated sessions. On a
// date with any dated entry the weekly slot doesn't apply; the dated entries
// replace it, and `skip: true` means no slot that day. Several dated
// sessions on one day are separate slots. Dates are calendar dates in the
// series' timezone, so DST days work.
import { hasSchedule, type Series } from "./series.js";
import { localParts, toMinutes, zonedTime } from "./time.js";

export interface Slot {
  start: number; // ms
  end: number;
  date: string; // YYYY-MM-DD, local
  startTime: string; // HH:MM, local
  endTime: string;
  source: "weekly" | "dated";
}

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const partsOf = (date: string) => date.split("-").map(Number) as [number, number, number];
export const weekdayOf = (date: string) => {
  const [y, m, d] = partsOf(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

// The local calendar date `days` after `date`.
export function addDays(date: string, days: number): string {
  const [y, m, d] = partsOf(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export const localDate = (ms: number, timeZone: string) => {
  const p = localParts(ms, timeZone);
  return isoDate(p.year, p.month, p.day);
};

// The instant a local date and time happen in timeZone.
export const instant = (date: string, hhmm: string, timeZone: string) => {
  const [y, m, d] = partsOf(date);
  return zonedTime(y, m, d, toMinutes(hhmm), timeZone);
};

// The series' slots on one local date, earliest first.
export function slotsOn(series: Series, date: string): Slot[] {
  const slot = (startTime: string, endTime: string, source: Slot["source"]): Slot => ({
    start: instant(date, startTime, series.timezone),
    end: instant(date, endTime, series.timezone),
    date,
    startTime,
    endTime,
    source,
  });
  const dated = series.dated.filter((e) => e.date === date);
  if (dated.length) {
    return dated.flatMap((e) => ("skip" in e ? [] : [slot(e.start, e.end, "dated")])).sort((a, b) => a.start - b.start);
  }
  if (hasSchedule(series) && weekdayOf(date) === series.weekday) return [slot(series.windowStart, series.windowEnd, "weekly")];
  return [];
}

// Every slot that overlaps [fromMs, toMs), earliest first.
export function slotsBetween(series: Series, fromMs: number, toMs: number): Slot[] {
  const last = addDays(localDate(toMs, series.timezone), 1);
  const out: Slot[] = [];
  for (let date = addDays(localDate(fromMs, series.timezone), -1); date <= last; date = addDays(date, 1)) {
    out.push(...slotsOn(series, date).filter((s) => s.end > fromMs && s.start < toMs));
  }
  return out;
}

// The latest dated entry's date, or null.
export const lastDatedDate = (series: Series) => series.dated.reduce<string | null>((max, e) => (max && max > e.date ? max : e.date), null);
