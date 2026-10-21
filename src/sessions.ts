// Matches Bee conversations to a Series and gathers the first batch of
// insights Bee generated after each session.
import { listConversations, listInsights, type BeeConversation, type BeeInsight } from "./bee/cli.js";
import type { Series } from "./series.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR = 3_600_000;
const LOOKBACK_DAYS = 21;

function localParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: WEEKDAYS.indexOf(get("weekday")),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function formatLocal(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(ms);
}

// Bee can split one session into several conversations, so a session is
// every conversation that overlaps the series window by at least
// minOverlapMinutes, merged in order. Sessions newest first.
export interface Session {
  parts: BeeConversation[];
  start: number;
  end: number;
}

export function matchSessions(conversations: BeeConversation[], series: Series): Session[] {
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

export interface LastSession {
  series: string;
  startedAt: string;
  startedAtLocal: string;
  durationMinutes: number;
  parts: number;
  shortSummary: string;
  summary: string;
  insights: { title: string; description: string; generatedAt: string }[];
  source: "bee-cli";
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

export function getLastSession(series: Series, { conversations, insights }: Snapshot): LastSession | null {
  const [session] = matchSessions(conversations, series);
  if (!session) return null;
  return {
    series: series.name,
    startedAt: new Date(session.start).toISOString(),
    startedAtLocal: formatLocal(session.start, series.timezone),
    durationMinutes: Math.round((session.end - session.start) / 60_000),
    parts: session.parts.length,
    shortSummary: session.parts.map((p) => p.short_summary).join(" / "),
    summary: session.parts.map((p) => p.summary).join("\n\n---\n\n"),
    insights: insightsAfter(session, insights, series.insightWindowHours).map((i) => ({
      title: i.title,
      description: i.description,
      generatedAt: new Date(i.generated_at).toISOString(),
    })),
    source: "bee-cli",
  };
}
