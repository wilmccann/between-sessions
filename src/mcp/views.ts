// How sessions and briefs look in tool answers.
import { digestSentence } from "../digest.js";
import { OTHER_ID, type Series } from "../series.js";
import { formatLocal } from "../sessions.js";
import { openAgenda } from "../store/agenda.js";
import { buttonReceipt } from "../receipts.js";
import { reviewLine } from "../review.js";
import type { AgendaItem, Debrief, SessionStore, SessionVersion } from "../store/types.js";
import { formatShort, nextSession } from "../time.js";
import { minutes } from "./tool.js";

// How a session was found: marked with the Bee button, or inferred from the
// schedule, and whether it's waiting for your review.
export const foundBy = (v: SessionVersion) => ({
  source: v.tag?.source ?? "schedule",
  status: v.tag?.status ?? "auto",
  reason: v.tag?.reason ?? "",
});

const agendaText = (a: AgendaItem) => (a.source === "bee" ? `${a.text} (from Bee)` : a.text);

export function describeSession(series: Series, v: SessionVersion, debriefs: Debrief[] = []) {
  return {
    series: series.name,
    startedAt: v.start,
    startedAtLocal: formatLocal(Date.parse(v.start), series.timezone),
    durationMinutes: minutes(v.start, v.end),
    foundBy: foundBy(v),
    debriefs: debriefs.map((d) => d.text),
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
  // What the Bee button filed lately, or null.
  fromBee: string | null;
  // "1 session to review", or null.
  review: string | null;
  // The digest in one paragraph; null for Other or before the first digest.
  sinceLastSession: string | null;
  lastSessionLocal: string | null;
  shortSummary: string | null;
  note: string | null;
  bullets: string[];
  insightTitles: string[];
  openAgenda: string[];
  takeaways: string[];
  debriefs: string[];
  // From the series' schedule; "not scheduled" when it has none.
  nextSession: string;
  nextSessionAt: string | null;
  source: "bedrock" | "assembled";
}

export function nextSessionView(series: Series, now = Date.now()) {
  const next = nextSession(series, now);
  return {
    nextSession: next ? formatShort(next.start, series.timezone) : "not scheduled",
    nextSessionAt: next ? new Date(next.start).toISOString() : null,
  };
}

export async function prepBrief(store: SessionStore, series: Series, now = Date.now()): Promise<PrepBriefView> {
  const latest = await store.getLatestSession(series.id);
  const [agenda, takeaways, debriefs, brief, records, allSeries, digest, queue] = await Promise.all([
    store.listAgenda(series.id),
    latest ? store.listTakeaways(series.id, latest.start) : Promise.resolve([]),
    latest ? store.listDebriefs(series.id, latest.start) : Promise.resolve([]),
    latest ? store.getPrepBrief(series.id, latest.start) : Promise.resolve(null),
    store.listJournalRecords(),
    store.listSeries(),
    series.id === OTHER_ID ? Promise.resolve(null) : store.getDigest(series.id),
    store.listReviewItems(),
  ]);
  const insights = latest?.insights ?? [];
  const relevant = brief?.relevantInsightIds.length
    ? insights.filter((i) => brief.relevantInsightIds.includes(i.id))
    : insights;
  return {
    series: series.name,
    fromBee: buttonReceipt(records, allSeries, now),
    review: reviewLine(queue, now),
    sinceLastSession: digest?.since ? digestSentence(digest, now) : null,
    lastSessionLocal: latest ? formatLocal(Date.parse(latest.start), series.timezone) : null,
    shortSummary: latest ? latest.parts.map((p) => p.shortSummary).join(" / ") : null,
    note: brief?.note ?? null,
    bullets: brief?.bullets ?? [],
    insightTitles: relevant.map((i) => i.title),
    openAgenda: openAgenda(agenda, latest).map(agendaText),
    takeaways: takeaways.map((t) => t.text),
    debriefs: debriefs.map((d) => d.text),
    ...nextSessionView(series, now),
    source: brief ? "bedrock" : "assembled",
  };
}
