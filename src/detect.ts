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

export function scheduleReason(series: Series): string {
  return hasSchedule(series) ? `${WEEKDAY_NAMES[series.weekday]} ${series.windowStart} to ${series.windowEnd} slot` : "";
}

export function windowCandidates(conversations: BeeConversation[], series: Series): Candidate[] {
  const out: Candidate[] = [];
  for (const span of scheduleSpans(conversations, series)) {
    const session = windowSession(partsInSpan(conversations, span, series.minOverlapMinutes), span, series.minDurationMinutes);
    if (!session) continue;
    out.push({
      seriesId: series.id,
      session,
      span,
      minDurationMinutes: series.minDurationMinutes,
      tag: { source: "schedule", confidence: "high", status: "auto", reason: scheduleReason(series) },
    });
  }
  return out;
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
