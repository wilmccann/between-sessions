// MCP tool definitions, shared by the local HTTP server and the Lambda. Tools
// only read and write the store; nothing here calls Bee or Bedrock.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Series } from "../series.js";
import { formatLocal } from "../sessions.js";
import type { SessionStore, SessionVersion } from "../store/types.js";

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

async function resolveSeries(store: SessionStore, wanted?: string): Promise<Series | null> {
  if (!wanted) return (await store.listSeries())[0] ?? null;
  const byId = await store.getSeries(wanted);
  if (byId) return byId;
  const all = await store.listSeries();
  return all.find((s) => s.name.toLowerCase() === wanted.toLowerCase()) ?? null;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (value: unknown) => text(JSON.stringify(value, null, 2));
const error = (t: string) => ({ isError: true, ...text(t) });

const seriesArg = z
  .string()
  .optional()
  .describe("Which recurring series, by id or name. Leave it out for the default series.");

export function createMcpServer(store: SessionStore): McpServer {
  const server = new McpServer({ name: "between-sessions", version: "0.2.0" });

  server.registerTool(
    "get_last_session",
    {
      title: "Last session",
      description:
        "The most recent session in a recurring series (for example weekly coaching): when it was, how long, Bee's summary, and the insights Bee generated in the first night after it.",
      inputSchema: { series: seriesArg },
    },
    async ({ series: wanted }) => {
      const series = await resolveSeries(store, wanted);
      if (!series) return error(wanted ? `Unknown series: ${wanted}` : "No series set up yet.");
      const latest = await store.getLatestSession(series.id);
      if (!latest) return text(`No session found yet for ${series.name}.`);
      return json(describeSession(series, latest));
    },
  );

  return server;
}
