// MCP tool definitions, shared by the local HTTP server and the Lambda. Tools
// only read and write the store; nothing here calls Bee or Bedrock, so every
// answer comes from precomputed data.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Series } from "../series.js";
import { formatLocal } from "../sessions.js";
import type { AgendaItem, SessionStore, SessionVersion } from "../store/types.js";

const minutes = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

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

async function resolveSeries(store: SessionStore, wanted?: string): Promise<Series | null> {
  if (!wanted) return (await store.listSeries())[0] ?? null;
  const byId = await store.getSeries(wanted);
  if (byId) return byId;
  const all = await store.listSeries();
  return all.find((s) => s.name.toLowerCase() === wanted.toLowerCase()) ?? null;
}

// Agenda items are for the next session, so an item is open until a session
// starts after it was added.
export function openAgenda(items: AgendaItem[], latest: SessionVersion | null): AgendaItem[] {
  return latest ? items.filter((i) => i.createdAt > latest.start) : items;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (value: unknown) => text(JSON.stringify(value, null, 2));
const error = (t: string) => ({ isError: true, ...text(t) });

const seriesArg = z
  .string()
  .optional()
  .describe("Which recurring series, by id or name. Leave it out for the default series.");

const noteText = z.string().trim().min(1).max(500);

export function createMcpServer(store: SessionStore): McpServer {
  const server = new McpServer({ name: "between-sessions", version: "0.3.0" });

  const withSeries = async (wanted: string | undefined) => {
    const series = await resolveSeries(store, wanted);
    return series
      ? { series }
      : { failure: error(wanted ? `I don't know a series called ${wanted}.` : "No series is set up yet.") };
  };

  server.registerTool(
    "get_last_session",
    {
      title: "Last session",
      description:
        "Get the most recent session in a recurring series, such as weekly coaching: when it was, how long it ran, Bee's summary of each part, and the insights Bee wrote in the first night after it.",
      inputSchema: { series: seriesArg },
      annotations: { readOnlyHint: true },
    },
    async ({ series: wanted }) => {
      const { series, failure } = await withSeries(wanted);
      if (!series) return failure;
      const latest = await store.getLatestSession(series.id);
      if (!latest) return text(`There's no ${series.name} session recorded yet.`);
      return json(describeSession(series, latest));
    },
  );

  server.registerTool(
    "add_agenda_item",
    {
      title: "Add agenda item",
      description:
        "Add something to bring up at the next session, for example: add 'ask about the offsite' to my coaching agenda. It stays on the agenda until the next session happens.",
      inputSchema: { series: seriesArg, text: noteText.describe("What to bring up, in a sentence or less.") },
    },
    async ({ series: wanted, text: item }) => {
      const { series, failure } = await withSeries(wanted);
      if (!series) return failure;
      await store.addAgendaItem(series.id, item);
      const open = openAgenda(await store.listAgenda(series.id), await store.getLatestSession(series.id));
      return text(`Added to your ${series.name} agenda. You have ${open.length} open item${open.length === 1 ? "" : "s"}.`);
    },
  );

  server.registerTool(
    "list_agenda",
    {
      title: "Open agenda",
      description:
        "List the things you planned to bring up at the next session in a series, oldest first. Items added before the last session are left out.",
      inputSchema: { series: seriesArg },
      annotations: { readOnlyHint: true },
    },
    async ({ series: wanted }) => {
      const { series, failure } = await withSeries(wanted);
      if (!series) return failure;
      const open = openAgenda(await store.listAgenda(series.id), await store.getLatestSession(series.id));
      if (!open.length) return text(`Your ${series.name} agenda is empty.`);
      return json({ series: series.name, items: open.map(({ text, createdAt }) => ({ text, createdAt })) });
    },
  );

  server.registerTool(
    "save_takeaway",
    {
      title: "Save takeaway",
      description:
        "Save your own takeaway from the most recent session, in your words, for example: my takeaway is to delegate earlier. It is filed under that session.",
      inputSchema: { series: seriesArg, text: noteText.describe("The takeaway, in a sentence or two.") },
    },
    async ({ series: wanted, text: takeaway }) => {
      const { series, failure } = await withSeries(wanted);
      if (!series) return failure;
      const latest = await store.getLatestSession(series.id);
      if (!latest) return error(`There's no ${series.name} session to attach a takeaway to yet.`);
      await store.saveTakeaway(series.id, latest.start, takeaway);
      return text(`Saved your takeaway from the session on ${formatLocal(Date.parse(latest.start), series.timezone)}.`);
    },
  );

  server.registerTool(
    "get_prep_brief",
    {
      title: "Prep brief",
      description:
        "Get a short brief to prepare for the next session: when the last one was, what it covered, Bee's insights after it, your takeaways, and your open agenda items.",
      inputSchema: { series: seriesArg },
      annotations: { readOnlyHint: true },
    },
    async ({ series: wanted }) => {
      const { series, failure } = await withSeries(wanted);
      if (!series) return failure;
      return json(await prepBrief(store, series));
    },
  );

  return server;
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
