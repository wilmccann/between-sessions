// The Schedule page, served by the review page's server (same 127.0.0.1
// listener, Host check and token): edit series (the weekly slot, names,
// keywords, minimum lengths), add and remove dated sessions, and see every
// slot in a date range with the session filed in it. The collector reads
// these series from the store on every run. No summaries on this page.
// Inline HTML, CSS and JS only.
import { ZodError } from "zod";
import { refId } from "../review.js";
import { defaultTimezone, hasSchedule, newSeries, normalizeSeries, OTHER_ID, type DatedEntry, type Series } from "../series.js";
import { addDays, instant, localDate, slotsBetween, slotsOn, weekdayOf, type Slot } from "../slots.js";
import type { SessionStore } from "../store/types.js";
import { DAY, formatShort, toMinutes } from "../time.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const BACK_DAYS = 14; // Bee's history, and the calendar's earliest default start
const AHEAD_DAYS = 7;
const MAX_RANGE_DAYS = 3660; // only a guard against a mistyped year

export const PAST_WARNING =
  "The collector re-checks recent conversations, so this can re-file a past session (sessions you confirmed or marked are kept).";

export interface ScheduleReply {
  status: number;
  body: unknown;
}

class ScheduleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const lengthOf = (start: string, end: string) => toMinutes(end) - toMinutes(start);
const realDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
const realTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const weekly = (s: Series) => (hasSchedule(s) ? `${WEEKDAYS[s.weekday]} ${s.windowStart} to ${s.windowEnd}` : "none");

// "Thu, Oct 22"
export const dayLabel = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(Date.UTC(y, m - 1, d));
};

// The trap for short test slots: a slot shorter than the minimum length
// never files, and a minimum overlap over half the slot drops a late start.
export function slotWarnings(series: Series, lengths: number[]): string[] {
  const out = new Set<string>();
  for (const minutes of [...new Set(lengths)].sort((a, b) => a - b)) {
    const suggest = Math.max(1, Math.floor(minutes / 2));
    if (minutes < series.minDurationMinutes) {
      out.add(
        `This slot is ${minutes} min but the minimum length is ${series.minDurationMinutes} min, so nothing will be filed. Set the minimum length to ${suggest}.`,
      );
    }
    if (series.minOverlapMinutes > suggest) {
      out.add(
        `This slot is ${minutes} min and each conversation must overlap it by ${series.minOverlapMinutes} min, so one that starts late won't count. Set the minimum overlap to ${suggest}.`,
      );
    }
  }
  return [...out];
}

const slotLengths = (s: Series) => [
  ...(hasSchedule(s) ? [lengthOf(s.windowStart, s.windowEnd)] : []),
  ...s.dated.flatMap((e) => ("skip" in e ? [] : [lengthOf(e.start, e.end)])),
];

// Slots in Bee's history that have ended, and the rules that file them;
// when these change, the collector may re-file a past session.
function pastKey(s: Series | null, now: number): { key: string; any: boolean } {
  if (!s) return { key: "", any: false };
  const past = slotsBetween(s, now - BACK_DAYS * DAY, now).filter((x) => x.end <= now);
  return { key: JSON.stringify([past.map((x) => [x.start, x.end]), s.minDurationMinutes, s.minOverlapMinutes]), any: past.length > 0 };
}
const touchesPast = (before: Series | null, after: Series, now: number) => {
  const [a, b] = [pastKey(before, now), pastKey(after, now)];
  return a.key !== b.key && (a.any || b.any);
};

function readback(s: Series): string {
  const timed = s.dated.filter((e) => !("skip" in e)).length;
  const skips = s.dated.length - timed;
  return (
    `Saved ${s.name}: ${hasSchedule(s) ? `${weekly(s)} weekly` : "no weekly slot"}, ${plural(timed, "dated session")}` +
    `${skips ? `, ${plural(skips, "skipped day")}` : ""}, minimum length ${s.minDurationMinutes} min.`
  );
}

// --- State ------------------------------------------------------------------

export interface CalendarEntry {
  date: string;
  weekday: string;
  start: string; // HH:MM, local to the series
  end: string;
  minutes: number;
  seriesId: string;
  series: string;
  source: Slot["source"];
  timing: "past" | "planned";
  filed: { id: string; when: string; status: string; source: string } | null;
  warning: string | null;
}

export async function scheduleState(store: SessionStore, range: { from?: string; to?: string } = {}, now = Date.now()) {
  const series = await store.listSeries();
  const today = localDate(now, defaultTimezone(series));
  const sessionsOf = new Map(await Promise.all(series.map(async (s) => [s.id, await store.listSessions(s.id, Infinity)] as const)));
  // By default, from the first filed session (or two weeks back, if earlier).
  const firsts = series.flatMap((s) => sessionsOf.get(s.id)!.map((v) => localDate(Date.parse(v.start), s.timezone)));
  const from = range.from || [addDays(today, -BACK_DAYS), ...firsts].sort()[0];
  const to = range.to || addDays(today, AHEAD_DAYS);
  if (!realDate(from) || !realDate(to)) throw new ScheduleError(400, "Use dates as YYYY-MM-DD for from and to");
  if (to < from) throw new ScheduleError(400, "The range ends before it starts");
  if (addDays(from, MAX_RANGE_DAYS) < to) throw new ScheduleError(400, `Pick a range of at most ${MAX_RANGE_DAYS} days`);

  const calendar: CalendarEntry[] = [];
  for (const s of series) {
    const slots = slotsBetween(s, instant(from, "00:00", s.timezone), instant(addDays(to, 1), "00:00", s.timezone));
    if (!slots.length) continue;
    const sessions = sessionsOf.get(s.id)!;
    for (const slot of slots) {
      const v = sessions.find((x) => Date.parse(x.start) < slot.end && Date.parse(x.end) > slot.start);
      const minutes = lengthOf(slot.startTime, slot.endTime);
      calendar.push({
        date: slot.date,
        weekday: WEEKDAYS[weekdayOf(slot.date)],
        start: slot.startTime,
        end: slot.endTime,
        minutes,
        seriesId: s.id,
        series: s.name,
        source: slot.source,
        timing: slot.end <= now ? "past" : "planned",
        filed: v
          ? { id: refId(v), when: formatShort(Date.parse(v.start), s.timezone), status: v.tag?.status ?? "untagged", source: v.tag?.source ?? "schedule" }
          : null,
        warning: slotWarnings(s, [minutes]).find((w) => w.includes("nothing will be filed")) ?? null,
      });
    }
  }
  calendar.sort((a, b) => (a.date + a.start + a.series < b.date + b.start + b.series ? -1 : 1));
  return {
    from,
    to,
    today,
    timezone: defaultTimezone(series),
    series: series.map((s) => ({ ...s, weekly: weekly(s), warnings: slotWarnings(s, slotLengths(s)) })),
    calendar,
  };
}

// --- Edits ------------------------------------------------------------------

const text = (v: unknown, what: string) => {
  if (typeof v !== "string" || !v.trim()) throw new ScheduleError(400, `Send ${what}`);
  return v.trim();
};

async function seriesNamed(store: SessionStore, id: unknown): Promise<Series> {
  const s = await store.getSeries(text(id, "the series id"));
  if (!s) throw new ScheduleError(400, `No series "${id}"`);
  return s;
}

function checkSeries(s: Series): Series {
  if (!s.name.trim()) throw new ScheduleError(400, "Give the series a name");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone });
  } catch {
    throw new ScheduleError(400, `Unknown time zone "${s.timezone}"; use an IANA name like America/New_York`);
  }
  if (hasSchedule(s)) {
    for (const t of [s.windowStart, s.windowEnd]) if (!realTime(t)) throw new ScheduleError(400, `Use a 24-hour time as HH:MM, not "${t}"`);
    if (toMinutes(s.windowEnd) <= toMinutes(s.windowStart)) {
      throw new ScheduleError(400, `The weekly end (${s.windowEnd}) must be after the start (${s.windowStart})`);
    }
  }
  return s;
}

const withoutNulls = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

// Creates a series (no id: one is made from the name) or updates one (its
// id; ids can't change). null clears a field, such as the weekly slot.
export async function saveSeries(store: SessionStore, body: Record<string, unknown>, now = Date.now()) {
  const all = await store.listSeries();
  let before: Series | null = null;
  let base: Record<string, unknown>;
  if (body.id !== undefined && body.id !== null) {
    before = all.find((s) => s.id === body.id) ?? null;
    if (!before) throw new ScheduleError(400, `No series "${body.id}". A series' id can't be changed; leave id out to add a new series.`);
    base = { ...before };
  } else {
    const name = text(body.name, "a name for the new series");
    const timezone = typeof body.timezone === "string" && body.timezone ? body.timezone : defaultTimezone(all);
    base = { ...newSeries(name, all, timezone) };
  }
  const { id: _id, ...changes } = body;
  const merged = withoutNulls({ ...base, ...changes, id: base.id });
  const saved = checkSeries(normalizeSeries(merged));
  await store.putSeries(saved);
  const warnings = slotWarnings(saved, slotLengths(saved));
  if (touchesPast(before, saved, now)) warnings.push(PAST_WARNING);
  return { readback: readback(saved), warnings, series: saved };
}

const byDate = (a: DatedEntry, b: DatedEntry) =>
  a.date !== b.date ? (a.date < b.date ? -1 : 1) : ("skip" in a ? "" : a.start) < ("skip" in b ? "" : b.start) ? -1 : 1;

// Saves a series' new dated list; answers with the warnings for the slots
// on `date` that changed.
async function saveDated(store: SessionStore, before: Series, dated: DatedEntry[], date: string, now: number, lengths: number[]) {
  const after = checkSeries(normalizeSeries({ ...before, dated: dated.sort(byDate) }));
  await store.putSeries(after);
  const warnings = slotWarnings(after, lengths);
  if ([...slotsOn(before, date), ...slotsOn(after, date)].some((x) => x.end <= now)) warnings.push(PAST_WARNING);
  return { after, warnings };
}

// Adds a dated session, or a skip ("no slot this day"). A skip replaces the
// day's dated sessions; a session replaces a skip, or one with the same start.
export async function addDated(store: SessionStore, body: Record<string, unknown>, now = Date.now()) {
  const s = await seriesNamed(store, body.series);
  const date = text(body.date, "the date (YYYY-MM-DD)");
  if (body.skip === true) {
    const { after, warnings } = await saveDated(store, s, [...s.dated.filter((e) => e.date !== date), { date, skip: true }], date, now, []);
    return { readback: `${after.name} has no slot on ${dayLabel(date)}.`, warnings };
  }
  const start = text(body.start, "a start time (HH:MM)");
  const end = text(body.end, "an end time (HH:MM)");
  const kept = s.dated.filter((e) => e.date !== date || (!("skip" in e) && e.start !== start));
  const { after, warnings } = await saveDated(store, s, [...kept, { date, start, end }], date, now, [lengthOf(start, end)]);
  const count = after.dated.filter((e) => e.date === date && !("skip" in e)).length;
  return { readback: `Added a dated session to ${after.name}: ${dayLabel(date)}, ${start} to ${end} (${plural(count, "slot")} that day).`, warnings };
}

// Removes the dated session starting at `start` on `date`, or the day's skip
// when no start is given.
export async function removeDated(store: SessionStore, body: Record<string, unknown>, now = Date.now()) {
  const s = await seriesNamed(store, body.series);
  const date = text(body.date, "the date (YYYY-MM-DD)");
  const start = typeof body.start === "string" && body.start ? body.start : null;
  const match = (e: DatedEntry) => e.date === date && (start ? !("skip" in e) && e.start === start : "skip" in e);
  if (!s.dated.some(match)) {
    throw new ScheduleError(400, `${s.name} has no ${start ? `dated session at ${start}` : "skip"} on ${dayLabel(date)}`);
  }
  const { after, warnings } = await saveDated(store, s, s.dated.filter((e) => !match(e)), date, now, []);
  const left = slotsOn(after, date);
  const then = left.length ? `Slots that day: ${left.map((x) => `${x.startTime} to ${x.endTime} ${x.source}`).join(", ")}.` : "No slot that day.";
  return { readback: `Removed the ${start ? `${start} dated session` : "skip"} from ${after.name} on ${dayLabel(date)}. ${then}`, warnings };
}

// Why a series can't be deleted, or null when it can.
export async function deleteBlocker(store: SessionStore, id: string): Promise<string | null> {
  if (id === OTHER_ID) return "Other holds sessions you marked without a series, so it can't be deleted.";
  const [sessions, agenda, takeaways] = await Promise.all([store.listSessions(id, 10_000), store.listAgenda(id), store.listTakeaways(id)]);
  const held = [
    sessions.length ? plural(sessions.length, "session") : "",
    agenda.length ? plural(agenda.length, "agenda item") : "",
    takeaways.length ? plural(takeaways.length, "takeaway") : "",
  ].filter(Boolean);
  if (!held.length) return null;
  const list = held.length === 1 ? held[0] : `${held.slice(0, -1).join(", ")} and ${held.at(-1)}`;
  return `Has ${list}; move or mark them first.`;
}

export async function deleteSeries(store: SessionStore, body: Record<string, unknown>) {
  const s = await seriesNamed(store, body.id);
  const blocker = await deleteBlocker(store, s.id);
  if (blocker) throw new ScheduleError(409, blocker);
  await store.deleteSeries(s.id);
  return { readback: `Deleted ${s.name}.`, warnings: [] as string[] };
}

// --- Routes -----------------------------------------------------------------

const zodText = (err: ZodError) =>
  err.issues
    .map((i) => {
      if (i.code === "custom") return i.message;
      const key = [...i.path].reverse().find((p) => typeof p === "string");
      return key ? `${key}: ${i.message}` : i.message;
    })
    .join("; ");

type Edit = (store: SessionStore, body: Record<string, unknown>) => Promise<{ readback: string; warnings: string[] }>;
const EDITS: Record<string, Edit> = {
  "/api/schedule/series": async (store, body) => {
    const { readback, warnings } = await saveSeries(store, body);
    return { readback, warnings };
  },
  "/api/schedule/dated": (store, body) => addDated(store, body),
  "/api/schedule/dated/remove": (store, body) => removeDated(store, body),
  "/api/schedule/series/delete": (store, body) => deleteSeries(store, body),
};

// Handles GET /schedule and /api/schedule/*, or returns null for any other
// path. The caller has checked the Host and token; readJson enforces JSON.
export async function scheduleRoute(
  store: SessionStore,
  method: string,
  url: URL,
  readJson: () => Promise<Record<string, unknown>>,
): Promise<ScheduleReply | null> {
  const path = url.pathname;
  try {
    if (method === "GET" && path === "/schedule") return { status: 200, body: SCHEDULE_PAGE };
    if (method === "GET" && path === "/api/schedule") {
      const range = { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined };
      return { status: 200, body: await scheduleState(store, range) };
    }
    const edit = EDITS[path];
    if (method === "POST" && edit) return { status: 200, body: await edit(store, await readJson()) };
    return null;
  } catch (err) {
    if (err instanceof ScheduleError) return { status: err.status, body: { error: err.message } };
    if (err instanceof ZodError) return { status: 400, body: { error: zodText(err) } };
    throw err;
  }
}

export const SCHEDULE_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Between Sessions: schedule</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; font-size: 14px; }
  body { margin: 1.5rem; max-width: 72rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #8884; vertical-align: top; }
  th { font-weight: 600; }
  .muted { opacity: .65; }
  .warn { color: #b5651d; }
  .past { opacity: .7; }
  #readback { padding: .6rem .8rem; border: 1px solid #8886; border-radius: 6px; display: none; margin-bottom: 1rem; }
  #readback.error { border-color: #c33; }
  .box { display: flex; flex-wrap: wrap; gap: .4rem 1rem; align-items: end; padding: .6rem .8rem; border: 1px solid #8884; border-radius: 6px; margin-bottom: .5rem; }
  .box label { display: flex; flex-direction: column; font-size: .85em; gap: .15rem; }
  .box label.check { flex-direction: row; align-items: center; gap: .3rem; }
  code { font-size: .9em; }
  button, select, input { font: inherit; margin-right: .3rem; }
</style>
</head>
<body>
<h1>Between Sessions: schedule</h1>
<p><a id="nav-review">Review</a> <span class="muted">Local only (127.0.0.1). The collector reads these series every run.</span></p>
<div id="readback" role="status"></div>
<div id="app">Loading...</div>
<script>
"use strict";
const token = new URLSearchParams(location.search).get("token") || "";
document.getElementById("nav-review").setAttribute("href", "/?token=" + encodeURIComponent(token));
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
let state = null;
let range = { from: "", to: "" };
let editing = null; // null, "new", or a series id

async function api(path, body) {
  const init = body === undefined
    ? { headers: { "X-Review-Token": token } }
    : { method: "POST", headers: { "X-Review-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (k === "checked") e.checked = Boolean(v);
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c));
  return e;
}

function table(headers, rows) {
  if (!rows.length) return el("p", { class: "muted" }, "None.");
  return el("table", {}, el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map((r) => el("tr", { class: r.past ? "past" : "" }, r.cells.map((c) => el("td", {}, c))))));
}

function showReadback(text, warnings, isError) {
  const box = document.getElementById("readback");
  box.replaceChildren(el("div", {}, text), (warnings || []).map((w) => el("div", { class: "warn" }, w)));
  box.className = isError ? "error" : "";
  box.style.display = "block";
}

// On an error the forms keep what you typed.
async function edit(path, body) {
  let r;
  try { r = await api(path, body); }
  catch (err) { showReadback(err.message, [], true); return; }
  showReadback(r.readback, r.warnings, false);
  if (path === "/api/schedule/series") editing = null;
  await load();
}

// The same warnings the server gives, shown while you type.
const minutesOf = (t) => /^\\d{2}:\\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : NaN;
function slotWarnings(minutes, minLength, minOverlap) {
  if (!(minutes > 0)) return [];
  const suggest = Math.max(1, Math.floor(minutes / 2));
  const out = [];
  if (minutes < minLength) out.push("This slot is " + minutes + " min but the minimum length is " + minLength + " min, so nothing will be filed. Set the minimum length to " + suggest + ".");
  if (minOverlap > suggest) out.push("This slot is " + minutes + " min and each conversation must overlap it by " + minOverlap + " min, so one that starts late won't count. Set the minimum overlap to " + suggest + ".");
  return out;
}
const PAST = "The collector re-checks recent conversations, so this can re-file a past session (sessions you confirmed or marked are kept).";
const warnList = (ws) => el("div", {}, ws.map((w) => el("div", { class: "warn" }, w)));
const split = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

function field(label, input) { return el("label", {}, label, input); }

function editForm() {
  const s = editing === "new" ? null : state.series.find((x) => x.id === editing);
  const v = s || { name: "", timezone: state.timezone, spokenNames: [], captureKeywords: [], minDurationMinutes: 30, minOverlapMinutes: 10, dated: [] };
  const name = el("input", { type: "text", value: v.name });
  const tz = el("input", { type: "text", value: v.timezone, size: "20" });
  const day = el("select", {}, el("option", { value: "" }, "none"), WEEKDAYS.map((d, i) => el("option", { value: String(i) }, d)));
  day.value = v.weekday === undefined ? "" : String(v.weekday);
  const start = el("input", { type: "time", value: v.windowStart || "" });
  const end = el("input", { type: "time", value: v.windowEnd || "" });
  const spoken = el("input", { type: "text", value: v.spokenNames.join(", ") });
  const keywords = el("input", { type: "text", value: v.captureKeywords.join(", ") });
  const minLength = el("input", { type: "number", min: "1", value: String(v.minDurationMinutes), style: "width: 5em" });
  const minOverlap = el("input", { type: "number", min: "1", value: String(v.minOverlapMinutes), style: "width: 5em" });
  const warnings = el("div");
  const check = () => {
    const lengths = [];
    if (day.value !== "") lengths.push(minutesOf(end.value) - minutesOf(start.value));
    for (const e of v.dated) if (!e.skip) lengths.push(minutesOf(e.end) - minutesOf(e.start));
    const ws = [...new Set(lengths.flatMap((m) => slotWarnings(m, Number(minLength.value), Number(minOverlap.value))))];
    if (s && s.weekday !== undefined && (day.value !== String(s.weekday) || start.value !== s.windowStart || end.value !== s.windowEnd)) ws.push(PAST);
    warnings.replaceChildren(warnList(ws));
  };
  for (const i of [day, start, end, minLength, minOverlap]) i.addEventListener("input", check);
  check();
  const save = () => {
    const body = {
      name: name.value, timezone: tz.value.trim(),
      spokenNames: split(spoken.value), captureKeywords: split(keywords.value),
      minDurationMinutes: Number(minLength.value), minOverlapMinutes: Number(minOverlap.value),
    };
    if (day.value === "") Object.assign(body, { weekday: null, windowStart: null, windowEnd: null });
    else Object.assign(body, { weekday: Number(day.value), windowStart: start.value || null, windowEnd: end.value || null });
    if (s) body.id = s.id;
    edit("/api/schedule/series", body);
  };
  return el("div", {},
    el("h2", {}, s ? "Edit " + s.name : "Add series", s ? el("span", { class: "muted" }, " (id " + s.id + ")") : null),
    el("div", { class: "box" },
      field("Name", name), field("Time zone", tz), field("Weekday", day), field("Start", start), field("End", end),
      el("button", { onclick: () => { day.value = ""; start.value = ""; end.value = ""; check(); } }, "Clear weekly slot"),
      field("Spoken names (comma separated)", spoken), field("Keywords (comma separated)", keywords),
      field("Minimum length (min)", minLength), field("Minimum overlap (min)", minOverlap),
      el("button", { onclick: save }, "Save"),
      el("button", { onclick: () => { editing = null; render(); } }, "Cancel")),
    warnings);
}

function datedForm() {
  const real = state.series;
  if (!real.length) return el("p", { class: "muted" }, "Add a series first.");
  const series = el("select", {}, real.map((x) => el("option", { value: x.id }, x.name)));
  const date = el("input", { type: "date", value: state.today });
  const start = el("input", { type: "time" });
  const end = el("input", { type: "time" });
  const skip = el("input", { type: "checkbox" });
  const warnings = el("div");
  const check = () => {
    const s = real.find((x) => x.id === series.value);
    const ws = skip.checked ? [] : slotWarnings(minutesOf(end.value) - minutesOf(start.value), s.minDurationMinutes, s.minOverlapMinutes);
    const endAt = new Date(date.value + "T" + (skip.checked || !end.value ? "23:59" : end.value)).getTime();
    if (date.value && endAt <= Date.now()) ws.push(PAST);
    start.disabled = end.disabled = skip.checked;
    warnings.replaceChildren(warnList(ws));
  };
  for (const i of [series, date, start, end, skip]) i.addEventListener("input", check);
  check();
  const add = () => edit("/api/schedule/dated", skip.checked
    ? { series: series.value, date: date.value, skip: true }
    : { series: series.value, date: date.value, start: start.value, end: end.value });
  return el("div", {},
    el("div", { class: "box" },
      field("Series", series), field("Date", date), field("Start", start), field("End", end),
      el("label", { class: "check" }, skip, "Skip the weekly slot this day"),
      el("button", { onclick: add }, "Add")),
    warnings);
}

function datedRows() {
  return state.series.flatMap((s) => s.dated.map((e) => ({
    cells: [s.name, e.date, WEEKDAYS[new Date(e.date + "T12:00Z").getUTCDay()], e.skip ? "skip (no slot)" : e.start + " to " + e.end,
      el("button", { onclick: () => edit("/api/schedule/dated/remove", e.skip ? { series: s.id, date: e.date } : { series: s.id, date: e.date, start: e.start }) }, "Remove")],
  })));
}

function seriesRows() {
  return state.series.map((s) => ({
    cells: [s.name, el("code", {}, s.id), s.timezone, s.weekly, s.spokenNames.join(", "), s.captureKeywords.join(", "),
      s.minDurationMinutes + " min", s.dated.filter((e) => !e.skip).length,
      el("span", {},
        el("button", { onclick: () => { editing = s.id; render(); } }, "Edit"),
        s.id === "other" ? null : el("button", { onclick: () => { if (confirm("Delete " + s.name + "?")) edit("/api/schedule/series/delete", { id: s.id }); } }, "Delete"),
        warnList(s.warnings))],
  }));
}

function calendarControls() {
  const from = el("input", { type: "date", value: state.from });
  const to = el("input", { type: "date", value: state.to });
  return el("div", { class: "box" }, field("From", from), field("To", to),
    el("button", { onclick: () => { range = { from: from.value, to: to.value }; load(); } }, "Show"),
    el("button", { onclick: () => { range = { from: "", to: "" }; load(); } }, "Default range"));
}

function calendarRows() {
  return state.calendar.map((c) => ({
    past: c.timing === "past",
    cells: [c.date, c.weekday, [c.start + " to " + c.end + " (" + c.minutes + " min)", c.warning ? el("div", { class: "warn" }, c.warning) : null],
      c.series, c.source, c.timing,
      c.filed ? [el("code", {}, c.filed.id), el("div", { class: "muted" }, c.filed.when + ", " + c.filed.source + ", " + c.filed.status)] : el("span", { class: "muted" }, "none")],
  }));
}

function render() {
  // Nested arrays of nodes; replaceChildren would print them as text.
  document.getElementById("app").replaceChildren(...[
    el("h2", {}, "Series"),
    table(["Name", "Id", "Time zone", "Weekly slot", "Spoken names", "Keywords", "Minimum length", "Dated sessions", ""], seriesRows()),
    el("button", { onclick: () => { editing = "new"; render(); } }, "Add series"),
    editing ? editForm() : null,
    el("h2", {}, "Dated sessions"),
    el("p", { class: "muted" }, "On a date with a dated session, the weekly slot doesn't apply; a skip means no slot that day. Times are in the series' time zone."),
    datedForm(),
    table(["Series", "Date", "Day", "Time", ""], datedRows()),
    el("h2", {}, "Calendar"),
    calendarControls(),
    table(["Date", "Day", "Time", "Series", "Source", "Past or planned", "Filed session"], calendarRows()),
  ].flat(2).filter((x) => x !== null));
}

async function load() {
  const q = range.from || range.to ? "?from=" + encodeURIComponent(range.from) + "&to=" + encodeURIComponent(range.to) : "";
  try { state = await api("/api/schedule" + q); render(); }
  catch (err) { showReadback("Couldn't load: " + err.message, [], true); }
}
load();
</script>
</body>
</html>
`;
