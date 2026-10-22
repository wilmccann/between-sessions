// How sessions and briefs look in tool answers.
import type { Series } from "../series.js";
import { formatLocal } from "../sessions.js";
import { openAgenda } from "../store/agenda.js";
import type { SessionStore, SessionVersion } from "../store/types.js";
import { minutes } from "./tool.js";

export function describeSession(series: Series, v: SessionVersion) {
  return {
    series: series.name,
    startedAt: v.start,
    startedAtLocal: formatLocal(Date.parse(v.start), series.timezone),
    durationMinutes: minutes(v.start, v.end),
    parts: v.parts.map((p) => ({
      startedAtLocal: formatLocal(Date.parse(p.start), series.timezone),
      durationMinutes: minutes(p.start, p.end),
      shortSummary: p.shortSummary,
    })),
    shortSummary: v.parts.map((p) => p.shortSummary).join(" / "),
    summary: v.parts.map((p) => p.summary).join("\n\n---\n\n"),
    insights: v.insights.map(({ title, description, generatedAt }) => ({ title, description, generatedAt })),
    versions: v.versions,
    collectedAt: v.collectedAt,
    source: "bee-cli" as const,
  };
}

export type SessionView = ReturnType<typeof describeSession>;

// What get_prep_brief returns: the Bedrock brief when the collector wrote one,
// otherwise the same fields assembled from the store.
export interface PrepBriefView {
  series: string;
  lastSessionLocal: string | null;
  shortSummary: string | null;
  note: string | null;
  bullets: string[];
  insightTitles: string[];
  openAgenda: string[];
  takeaways: string[];
  source: "bedrock" | "assembled";
}

export async function prepBrief(store: SessionStore, series: Series): Promise<PrepBriefView> {
  const latest = await store.getLatestSession(series.id);
  const [agenda, takeaways, brief] = await Promise.all([
    store.listAgenda(series.id),
    latest ? store.listTakeaways(series.id, latest.start) : Promise.resolve([]),
    latest ? store.getPrepBrief(series.id, latest.start) : Promise.resolve(null),
  ]);
  const insights = latest?.insights ?? [];
  const relevant = brief?.relevantInsightIds.length
    ? insights.filter((i) => brief.relevantInsightIds.includes(i.id))
    : insights;
  return {
    series: series.name,
    lastSessionLocal: latest ? formatLocal(Date.parse(latest.start), series.timezone) : null,
    shortSummary: latest ? latest.parts.map((p) => p.shortSummary).join(" / ") : null,
    note: brief?.note ?? null,
    bullets: brief?.bullets ?? [],
    insightTitles: relevant.map((i) => i.title),
    openAgenda: openAgenda(agenda, latest).map((a) => a.text),
    takeaways: takeaways.map((t) => t.text),
    source: brief ? "bedrock" : "assembled",
  };
}
