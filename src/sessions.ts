// Matches Bee conversations to a Series and gathers the first batch of
// insights Bee generated after each session.
import { listConversations, listInsights, type BeeConversation, type BeeInsight } from "./bee/cli.js";
import { hasSchedule, type Series } from "./series.js";
import type { SessionInput } from "./store/types.js";
import { formatLocal, HOUR, localParts, toMinutes } from "./time.js";

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

export function matchSessions(conversations: BeeConversation[], series: Series): Session[] {
  if (!hasSchedule(series)) return [];
  const windowStart = toMinutes(series.windowStart);
  const windowEnd = toMinutes(series.windowEnd);
  const byDay = new Map<string, { parts: BeeConversation[]; overlap: number }>();
  for (const c of conversations) {
    const { weekday, minutes } = localParts(c.start_time, series.timezone);
    if (weekday !== series.weekday) continue;
    const endMinutes = minutes + (c.end_time - c.start_time) / 60_000;
    const overlap = Math.min(endMinutes, windowEnd) - Math.max(minutes, windowStart);
    if (overlap < series.minOverlapMinutes) continue;
    const day = new Date(c.start_time).toLocaleDateString("en-CA", { timeZone: series.timezone });
    const entry = byDay.get(day) ?? { parts: [], overlap: 0 };
    entry.parts.push(c);
    entry.overlap += overlap;
    byDay.set(day, entry);
  }
  return [...byDay.values()]
    .filter((d) => d.overlap >= series.minDurationMinutes)
    .map(({ parts }) => {
      parts.sort((a, b) => a.start_time - b.start_time);
      return { parts, start: parts[0].start_time, end: Math.max(...parts.map((p) => p.end_time)) };
    })
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
}

export async function collectSnapshot(now = Date.now()): Promise<Snapshot> {
  const since = now - LOOKBACK_DAYS * 24 * HOUR;
  const [conversations, insights] = await Promise.all([listConversations(since), listInsights(since)]);
  return { collectedAt: new Date(now).toISOString(), conversations, insights };
}

// What the store keeps for one session: the parts' summaries and the first
// insight batch after it.
export function sessionInput(session: Session, insights: BeeInsight[], series: Series): SessionInput {
  return {
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
