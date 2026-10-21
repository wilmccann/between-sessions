// Matches Bee conversations to a Series and gathers the insights Bee
// generated in the hours after each session.
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

// Sessions newest first. If several conversations match on one day, the
// longest one wins.
export function matchSessions(conversations: BeeConversation[], series: Series): BeeConversation[] {
  const start = toMinutes(series.windowStart);
  const end = toMinutes(series.windowEnd);
  const byDay = new Map<string, BeeConversation>();
  for (const c of conversations) {
    const { weekday, minutes } = localParts(c.start_time, series.timezone);
    const duration = (c.end_time - c.start_time) / 60_000;
    if (weekday !== series.weekday || minutes < start || minutes > end) continue;
    if (duration < series.minDurationMinutes) continue;
    const day = new Date(c.start_time).toLocaleDateString("en-CA", { timeZone: series.timezone });
    const prev = byDay.get(day);
    if (!prev || duration > (prev.end_time - prev.start_time) / 60_000) byDay.set(day, c);
  }
  return [...byDay.values()].sort((a, b) => b.start_time - a.start_time);
}

export function insightsAfter(session: BeeConversation, insights: BeeInsight[], hours: number): BeeInsight[] {
  const until = session.end_time + hours * HOUR;
  return insights
    .filter((i) => i.generated_at > session.end_time && i.generated_at <= until)
    .sort((a, b) => a.generated_at - b.generated_at);
}

export interface LastSession {
  series: string;
  startedAt: string;
  startedAtLocal: string;
  durationMinutes: number;
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
    startedAt: new Date(session.start_time).toISOString(),
    startedAtLocal: formatLocal(session.start_time, series.timezone),
    durationMinutes: Math.round((session.end_time - session.start_time) / 60_000),
    shortSummary: session.short_summary,
    summary: session.summary,
    insights: insightsAfter(session, insights, series.insightWindowHours).map((i) => ({
      title: i.title,
      description: i.description,
      generatedAt: new Date(i.generated_at).toISOString(),
    })),
    source: "bee-cli",
  };
}
