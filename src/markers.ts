// Sessions from Bee button markers. A start and an end make a session with
// exactly that span, from the Bee conversations that overlap it. Missing
// halves: a start with no end closes at the end of the last conversation
// in a run of back-to-back conversations from the start (at most the
// series' maxSessionMinutes); an end with no start opens at the start of
// the first conversation in the run that leads up to it.
import type { BeeConversation } from "./bee/cli.js";
import type { Candidate } from "./detect.js";
import { scheduleReason } from "./detect.js";
import { hasSchedule, OTHER_ID, type Series } from "./series.js";
import type { Marker, SessionTag } from "./store/types.js";
import { localParts, MINUTE, toMinutes } from "./time.js";

// Conversations this close together count as one run.
export const CHAIN_GAP = 15 * MINUTE;
// How early before its slot an unnamed start still counts as that slot.
const SLOT_EARLY = 30 * MINUTE;

const ms = (iso: string) => Date.parse(iso);

function inSlot(s: Series, at: number): boolean {
  if (!hasSchedule(s)) return false;
  const p = localParts(at, s.timezone);
  if (p.weekday !== s.weekday) return false;
  return p.minutes >= toMinutes(s.windowStart) - SLOT_EARLY / MINUTE && p.minutes <= toMinutes(s.windowEnd);
}

// The series for a marked session, and how sure we are.
function placeMarked(
  named: string | undefined,
  unclear: boolean,
  at: number,
  series: Series[],
): { seriesId: string; confidence: SessionTag["confidence"]; status: SessionTag["status"]; why: string } {
  if (named && series.some((s) => s.id === named)) {
    return { seriesId: named, confidence: "certain", status: "auto", why: "" };
  }
  const real = series.filter((s) => s.id !== OTHER_ID);
  const prefix = unclear ? "the name matched more than one series" : "no series named";
  if (real.length === 1 && !unclear) return { seriesId: real[0].id, confidence: "high", status: "auto", why: "" };
  const slot = real.find((s) => inSlot(s, at));
  if (slot) return { seriesId: slot.id, confidence: "low", status: "pending", why: `${prefix}; in the ${scheduleReason(slot)}` };
  return { seriesId: OTHER_ID, confidence: "low", status: "pending", why: `${prefix}; filed under Other` };
}

const byStart = (a: BeeConversation, b: BeeConversation) => a.start_time - b.start_time;

// Back-to-back conversations from `at` onward, up to `limit`.
function runAfter(conversations: BeeConversation[], at: number, limit: number): BeeConversation[] {
  const sorted = conversations.filter((c) => c.end_time > at && c.start_time < limit).sort(byStart);
  const run: BeeConversation[] = [];
  for (const c of sorted) {
    const prevEnd = run.length ? Math.max(...run.map((r) => r.end_time)) : at;
    if (c.start_time - prevEnd > CHAIN_GAP) break;
    run.push(c);
  }
  return run;
}

// Back-to-back conversations leading up to `at`, back to `limit`.
function runBefore(conversations: BeeConversation[], at: number, limit: number): BeeConversation[] {
  const sorted = conversations.filter((c) => c.start_time < at && c.end_time > limit).sort((a, b) => b.end_time - a.end_time);
  const run: BeeConversation[] = [];
  for (const c of sorted) {
    const nextStart = run.length ? Math.min(...run.map((r) => r.start_time)) : at;
    if (nextStart - c.end_time > CHAIN_GAP) break;
    run.push(c);
  }
  return run.sort(byStart);
}

function overlapping(conversations: BeeConversation[], from: number, to: number, minOverlapMinutes: number) {
  const need = Math.max(0.5 * MINUTE, Math.min(minOverlapMinutes * MINUTE, (to - from) / 2));
  return conversations
    .filter((c) => Math.min(c.end_time, to) - Math.max(c.start_time, from) >= need)
    .sort(byStart);
}

export function markerCandidates(markers: Marker[], conversations: BeeConversation[], series: Series[]): Candidate[] {
  const byId = new Map(series.map((s) => [s.id, s]));
  const sorted = [...markers].sort((a, b) => ms(a.at) - ms(b.at));
  const pairs: { start?: Marker; end?: Marker; until?: number }[] = [];
  let open: Marker | undefined;
  for (const m of sorted) {
    if (m.kind === "start") {
      if (open) pairs.push({ start: open, until: ms(m.at) });
      open = m;
    } else if (open) {
      pairs.push({ start: open, end: m });
      open = undefined;
    } else {
      pairs.push({ end: m });
    }
  }
  if (open) pairs.push({ start: open });

  const out: Candidate[] = [];
  for (const { start, end, until } of pairs) {
    const at = ms((start ?? end)!.at);
    const named = start?.seriesId ?? end?.seriesId;
    const unclear = Boolean(start?.unclear || end?.unclear);
    const place = placeMarked(named, unclear, at, series);
    const s = byId.get(place.seriesId);
    const maxMs = (s?.maxSessionMinutes ?? 120) * MINUTE;
    const minOverlap = s?.minOverlapMinutes ?? 10;

    let from: number;
    let to: number;
    let parts: BeeConversation[];
    let how: string;
    if (start && end) {
      from = ms(start.at);
      to = ms(end.at);
      parts = overlapping(conversations, from, to, minOverlap);
      how = "Marked start and end";
    } else if (start) {
      from = ms(start.at);
      const limit = Math.min(from + maxMs, until ?? Infinity);
      parts = runAfter(conversations, from, limit);
      if (!parts.length) continue; // nothing recorded yet
      to = Math.min(Math.max(...parts.map((p) => p.end_time)), limit);
      how = "Marked start; end from the last conversation";
    } else {
      to = ms(end!.at);
      parts = runBefore(conversations, to, to - maxMs);
      if (!parts.length) continue;
      from = Math.max(parts[0].start_time, to - maxMs);
      how = "Marked end; start from the first conversation";
    }
    if (to <= from) continue;
    out.push({
      seriesId: place.seriesId,
      session: { parts, start: from, end: to },
      span: { from, to },
      minDurationMinutes: 0,
      tag: {
        source: "marker",
        confidence: place.confidence === "certain" && !(start && end) ? "high" : place.confidence,
        status: place.status,
        reason: place.why ? `${how}; ${place.why}` : how,
      },
    });
  }
  return out;
}
