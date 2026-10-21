// MCP tool definitions, shared by the local HTTP server and (later) Lambda.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadSeries } from "../series.js";
import { readSnapshot } from "../local/snapshot-store.js";
import { getLastSession } from "../sessions.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "between-sessions", version: "0.1.0" });

  server.registerTool(
    "get_last_session",
    {
      title: "Last session",
      description:
        "The most recent session in a recurring series (for example weekly therapy): when it was, Bee's summary, and the insights Bee generated in the days after it.",
      inputSchema: {
        series: z.string().optional().describe("Series id or name. Defaults to the first series."),
      },
    },
    async ({ series: wanted }) => {
      const all = loadSeries();
      const series = wanted
        ? all.find((s) => s.id === wanted || s.name.toLowerCase() === wanted.toLowerCase())
        : all[0];
      if (!series) {
        return { isError: true, content: [{ type: "text", text: `Unknown series: ${wanted}` }] };
      }
      const snapshot = await readSnapshot();
      if (!snapshot) {
        return { isError: true, content: [{ type: "text", text: "No Bee snapshot yet. Run the collector first." }] };
      }
      const last = getLastSession(series, snapshot);
      const text = last
        ? JSON.stringify({ ...last, collectedAt: snapshot.collectedAt }, null, 2)
        : `No session found for ${series.name} in the last 21 days.`;
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}
