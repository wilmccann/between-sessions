import { refId, reviewLine } from "../../review.js";
import { DAY, formatShort } from "../../time.js";
import { defineTool, json, minutes, text } from "../tool.js";

export default defineTool({
  name: "review_sessions",
  title: "Sessions to review",
  description:
    "List the meetings Between Sessions guessed and wants you to confirm, oldest first: date, time, length, the guessed series, why, and when Bee's history drops it. No summaries. Confirm or correct one with retag_session.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
  next: "Want to confirm or retag the first one?",
  async run(_args, { store }) {
    const [items, series] = await Promise.all([store.listReviewItems(), store.listSeries()]);
    if (!items.length) return text("Nothing to review.");
    const now = Date.now();
    const byId = new Map(series.map((s) => [s.id, s]));
    return json({
      line: reviewLine(items, now),
      sessions: items.map((i) => {
        const s = byId.get(i.seriesId);
        const beeId = String(i.conversationIds[0] ?? "");
        return {
          id: refId(i),
          when: formatShort(Date.parse(i.start), s?.timezone ?? "UTC"),
          durationMinutes: minutes(i.start, i.end),
          guess: s?.name ?? i.seriesId,
          filed: i.filed,
          reason: i.reason,
          beeId: beeId.slice(-4),
          expiresInDays: Math.max(0, Math.ceil((Date.parse(i.dropsAt) - now) / DAY)),
        };
      }),
    });
  },
});
