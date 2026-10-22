// Matches Bee conversations to a Series and gathers the first batch of
// insights Bee generated after each session.
import {
  listConversations,
  listInsights,
  listJournals,
  listTodos,
  type BeeConversation,
  type BeeInsight,
  type BeeJournal,
  type BeeTodo,
} from "./bee/cli.js";
import { hasSchedule, type Series } from "./series.js";
import { localDate, slotsOn, type Slot } from "./slots.js";
import type { SessionInput, SessionTag } from "./store/types.js";
import { formatLocal, HOUR, MINUTE } from "./time.js";

const LOOKBACK_DAYS = 21;

export { formatLocal };

// Bee can split one session into several conversations, so a session is
// every conversation that overlaps the series window by at least
// minOverlapMinutes, merged in order. Sessions newest first.
export interface Session {
  parts: BeeConversation[];
  start: number;
  end: number;
}

export interface Span {
  from: number;
  to: number;
}

const overlapMs = (c: BeeConversation, span: Span) => Math.min(c.end_time, span.to) - Math.max(c.start_time, span.from);

// The conversations that overlap a span by at least minOverlapMinutes each,
// in order. Null when none do.
export function partsInSpan(conversations: BeeConversation[], span: Span, minOverlapMinutes: number): BeeConversation[] {
  return conversations
    .filter((c) => overlapMs(c, span) >= minOverlapMinutes * MINUTE)
    .sort((a, b) => a.start_time - b.start_time);
}

// A session found from a schedule window: the overlapping parts, if their
// overlap adds up to minDurationMinutes. It spans the parts themselves.
export function windowSession(parts: BeeConversation[], span: Span, minDurationMinutes: number): Session | null {
  const total = parts.reduce((sum, c) => sum + Math.max(0, overlapMs(c, span)), 0);
  if (!parts.length || total < minDurationMinutes * MINUTE) return null;
  return { parts, start: parts[0].start_time, end: Math.max(...parts.map((p) => p.end_time)) };
}

// A slot's span, with the slot it came from.
export interface SlotSpan extends Span {
  slot: Slot;
}

// One span per slot (weekly or dated) on each local date that has a
// conversation starting on it.
export function scheduleSpans(conversations: BeeConversation[], series: Series): SlotSpan[] {
  if (!hasSchedule(series) && !series.dated.length) return [];
  const dates = new Set(conversations.map((c) => localDate(c.start_time, series.timezone)));
  return [...dates].flatMap((date) => slotsOn(series, date).map((slot) => ({ from: slot.start, to: slot.end, slot })));
}

// Sessions from the series' slots, newest first. Each is a span on its own
// date, not "everything that day".
export function matchSessions(conversations: BeeConversation[], series: Series): Session[] {
  return scheduleSpans(conversations, series)
    .map((span) => windowSession(partsInSpan(conversations, span, series.minOverlapMinutes), span, series.minDurationMinutes))
    .filter((s): s is Session => s !== null)
    .sort((a, b) => b.start - a.start);
}

// Bee writes insights in a nightly batch over a rolling window of days, so
// later batches mostly restate earlier ones. Keep the first batch after the
// session, if it arrives within `hours`.
const BATCH_GAP = 30 * 60_000;

export function insightsAfter(session: Session, insights: BeeInsight[], hours: number): BeeInsight[] {
  const until = session.end + hours * HOUR;
  const after = insights
    .filter((i) => i.generated_at > session.end && i.generated_at <= until)
    .sort((a, b) => a.generated_at - b.generated_at);
  if (!after.length) return [];
  const first = after[0].generated_at;
  return after.filter((i) => i.generated_at - first < BATCH_GAP);
}

export interface Snapshot {
  collectedAt: string;
  conversations: BeeConversation[];
  insights: BeeInsight[];
  journals?: BeeJournal[];
  todos?: BeeTodo[];
}

export async function collectSnapshot(now = Date.now()): Promise<Snapshot> {
  const since = now - LOOKBACK_DAYS * 24 * HOUR;
  // Voice notes and todos feed the Bee button and the digest; if either
  // read fails, sessions are still collected.
  const optional = <T>(what: string, p: Promise<T[]>) =>
    p.catch((err: Error) => {
      console.warn(`bee ${what} list failed; continuing without it (${err.name})`);
      return undefined;
    });
  const [conversations, insights, journals, todos] = await Promise.all([
    listConversations(since),
    listInsights(since),
    optional("journals", listJournals(since)),
    optional("todos", listTodos(since)),
  ]);
  return { collectedAt: new Date(now).toISOString(), conversations, insights, journals, todos };
}

// What the store keeps for one session: the parts' summaries and the first
// insight batch after it.
export function sessionInput(session: Session, insights: BeeInsight[], series: Series, tag?: SessionTag): SessionInput {
  return {
    ...(tag && { tag }),
    start: new Date(session.start).toISOString(),
    end: new Date(session.end).toISOString(),
    parts: session.parts.map((p) => ({
      id: p.id,
      start: new Date(p.start_time).toISOString(),
      end: new Date(p.end_time).toISOString(),
      shortSummary: p.short_summary,
      summary: p.summary,
    })),
    insights: insightsAfter(session, insights, series.insightWindowHours).map((i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      generatedAt: new Date(i.generated_at).toISOString(),
    })),
  };
}
