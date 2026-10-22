// Turns a Bee snapshot into the sessions to store. Every candidate carries a
// tag; candidates are placed strongest evidence first, and each Bee
// conversation ends up in at most one session:
//   you (a confirmation or retag) > a Bee button marker > the schedule window.
// A stronger candidate takes over a weaker stored session that holds the same
// conversations (its takeaways move along), so a window-detected and a marked
// session are never both stored.
import type { BeeConversation } from "./bee/cli.js";
import { hasSchedule, type Series } from "./series.js";
import { partsInSpan, scheduleSpans, windowSession, type Session, type Span } from "./sessions.js";
import { weekdayOf, type Slot } from "./slots.js";
import type { Claim, SessionRef, SessionTag } from "./store/types.js";

export interface Candidate {
  seriesId: string;
  session: Session;
  tag: SessionTag;
  // The span the parts were taken from, and how much overlap a window
  // session needs; used when some parts go to a stronger session.
  span: Span;
  minDurationMinutes: number;
}

export interface Placed {
  candidate: Candidate;
  replaces: SessionRef[];
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "Tue 17:00 to 18:00 slot" for the weekly slot; "Thu 18:00 to 18:10 dated
// slot" for a dated one.
export function scheduleReason(series: Series, slot?: Slot): string {
  if (slot?.source === "dated") return `${WEEKDAY_NAMES[weekdayOf(slot.date)]} ${slot.startTime} to ${slot.endTime} dated slot`;
  return hasSchedule(series) ? `${WEEKDAY_NAMES[series.weekday]} ${series.windowStart} to ${series.windowEnd} slot` : "";
}

// The first of the series' captureKeywords that Bee's summaries mention.
export function keywordIn(parts: BeeConversation[], series: Series): string | undefined {
  const text = parts.map((p) => `${p.short_summary ?? ""} ${p.summary ?? ""}`).join(" ");
  return series.captureKeywords.find((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text));
}

// Window sessions. With a series keyword in Bee's summary the guess is
// high and filed; a slot with no keyword (the coaching slot in an off week)
// is low and waits for review. A series with no captureKeywords has nothing
// to check, so its slot alone is filed, as before tags existed.
export function windowCandidates(conversations: BeeConversation[], series: Series): Candidate[] {
  const out: Candidate[] = [];
  for (const { slot: where, ...span } of scheduleSpans(conversations, series)) {
    const session = windowSession(partsInSpan(conversations, span, series.minOverlapMinutes), span, series.minDurationMinutes);
    if (!session) continue;
    const slot = scheduleReason(series, where);
    const keyword = keywordIn(session.parts, series);
    const tag: SessionTag = keyword
      ? { source: "schedule", confidence: "high", status: "auto", reason: `${slot}, and "${keyword}" in Bee's summary` }
      : series.captureKeywords.length
        ? { source: "schedule", confidence: "low", status: "pending", reason: `${slot} only` }
        : { source: "schedule", confidence: "high", status: "auto", reason: slot };
    out.push({ seriesId: series.id, session, span, minDurationMinutes: series.minDurationMinutes, tag });
  }
  return out;
}

// A long conversation outside any slot that mentions a series keyword
// ("acme" in a 45-minute conversation): low, waits for review.
export const KEYWORD_MIN_MINUTES = 30;

export function keywordCandidates(conversations: BeeConversation[], series: Series): Candidate[] {
  if (!series.captureKeywords.length) return [];
  return conversations
    .filter((c) => c.end_time - c.start_time >= KEYWORD_MIN_MINUTES * 60_000)
    .flatMap((c) => {
      const keyword = keywordIn([c], series);
      if (!keyword) return [];
      const minutes = Math.round((c.end_time - c.start_time) / 60_000);
      return [
        {
          seriesId: series.id,
          session: { parts: [c], start: c.start_time, end: c.end_time },
          span: { from: c.start_time, to: c.end_time },
          minDurationMinutes: 0,
          tag: { source: "keyword", confidence: "low", status: "pending", reason: `"${keyword}" in Bee's summary, ${minutes} minutes` },
        } satisfies Candidate,
      ];
    });
}

// Sessions you confirmed or retagged: rebuilt from their claims each run,
// so their summaries keep being versioned. They beat every guess.
export function claimCandidates(conversations: BeeConversation[], claims: Map<number, Claim>): Candidate[] {
  const groups = new Map<string, { seriesId: string; start: string; parts: BeeConversation[] }>();
  for (const c of conversations) {
    const claim = claims.get(c.id);
    if (!claim || claim.status !== "confirmed" || !claim.seriesId) continue;
    const key = `${claim.seriesId}|${claim.sessionStart}`;
    const g = groups.get(key) ?? { seriesId: claim.seriesId, start: claim.sessionStart, parts: [] };
    g.parts.push(c);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ seriesId, start, parts }) => {
    parts.sort((a, b) => a.start_time - b.start_time);
    const from = Math.min(Date.parse(start), parts[0].start_time);
    const to = Math.max(...parts.map((p) => p.end_time));
    return {
      seriesId,
      session: { parts, start: Date.parse(start), end: to },
      span: { from, to },
      minDurationMinutes: 0,
      tag: { source: "you", confidence: "certain", status: "confirmed", reason: "You confirmed it" },
    };
  });
}

export const priority = (t: { source: SessionTag["source"]; status: SessionTag["status"] }) =>
  t.status === "confirmed" || t.source === "you" ? 4 : t.source === "marker" ? 3 : 1;

const startIso = (c: Candidate) => new Date(c.session.start).toISOString();

// Rebuilds a candidate from the parts it kept, or null if too little is left.
function rebuild(c: Candidate, parts: BeeConversation[]): Candidate | null {
  if (parts.length === c.session.parts.length) return c;
  if (!parts.length) return null;
  if (c.tag.source !== "schedule") return { ...c, session: { ...c.session, parts } };
  const session = windowSession(parts, c.span, c.minDurationMinutes);
  return session ? { ...c, session } : null;
}

export function placeSessions(candidates: Candidate[], stored: Map<number, Claim>): Placed[] {
  const ordered = [...candidates].sort(
    (a, b) => priority(b.tag) - priority(a.tag) || a.session.start - b.session.start,
  );
  const thisRun = new Map<number, Candidate>();
  const placed: Placed[] = [];
  for (const c of ordered) {
    const mine = priority(c.tag);
    const kept = c.session.parts.filter((p) => {
      if (thisRun.has(p.id)) return false; // a stronger or earlier session this run has it
      const claim = stored.get(p.id);
      if (!claim) return true;
      if (claim.status === "rejected") return mine >= 3; // "not a session", unless you mark it
      if (claim.seriesId === c.seriesId && claim.sessionStart === startIso(c)) return true; // already ours
      // A window session whose start moved (Bee split or merged a part)
      // replaces its earlier self; otherwise only stronger evidence wins.
      const drifted = claim.source === "schedule" && c.tag.source === "schedule" && claim.seriesId === c.seriesId;
      return mine > priority(claim) || drifted;
    });
    const rebuilt = rebuild(c, kept);
    if (!rebuilt) continue;
    // Every other stored session holding a kept part is taken over.
    const start = startIso(rebuilt);
    const replaces = new Map<string, SessionRef>();
    for (const p of rebuilt.session.parts) {
      const claim = stored.get(p.id);
      if (!claim || claim.status === "rejected") continue;
      if (claim.seriesId === rebuilt.seriesId && claim.sessionStart === start) continue;
      replaces.set(`${claim.seriesId}|${claim.sessionStart}`, { seriesId: claim.seriesId, start: claim.sessionStart });
    }
    for (const p of rebuilt.session.parts) thisRun.set(p.id, rebuilt);
    placed.push({ candidate: rebuilt, replaces: [...replaces.values()] });
  }
  return placed.sort((a, b) => a.candidate.session.start - b.candidate.session.start);
}
