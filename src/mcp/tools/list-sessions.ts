import { z } from "zod";
import { formatLocal } from "../../sessions.js";
import { chooseSeries, defineTool, json, minutes, say, seriesArg, text } from "../tool.js";

export default defineTool({
  name: "list_sessions",
  title: "Recent sessions",
  description:
    "List recent sessions in a series, newest first, with the date, how long each ran and how many versions Bee's summary went through. No summaries; use get_last_session for those.",
  inputSchema: {
    series: seriesArg,
    limit: z.number().int().min(1).max(20).default(5).describe("How many sessions, 1 to 20. Defaults to 5."),
  },
  annotations: { readOnlyHint: true },
  async run({ series: wanted, limit }, { store }) {
    const { series, why, failure } = await chooseSeries(store, wanted, "recent");
    if (!series) return failure;
    const sessions = await store.listSessions(series.id, limit);
    if (!sessions.length) return text(`There's no ${series.name} session recorded yet.`);
    return say(why, json({
      series: series.name,
      sessions: sessions.map((v) => ({
        startedAt: v.start,
        startedAtLocal: formatLocal(Date.parse(v.start), series.timezone),
        durationMinutes: minutes(v.start, v.end),
        parts: v.parts.length,
        versions: v.versions,
      })),
    }));
  },
});
