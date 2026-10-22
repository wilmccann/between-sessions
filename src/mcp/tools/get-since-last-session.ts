import { digestSentence } from "../../digest.js";
import { buttonReceipt } from "../../receipts.js";
import { reviewLine } from "../../review.js";
import { OTHER_ID } from "../../series.js";
import { formatLocal } from "../../sessions.js";
import { chooseSeries, defineTool, json, say, seriesArg, text } from "../tool.js";
import { nextSessionView } from "../views.js";

export default defineTool({
  name: "get_since_last_session",
  title: "Since last session",
  description:
    "Say what has happened since the last session in a series: how many days and conversations, which topics from that session came up again and how often, Bee's insight titles since, and how many todos were added. Counts and topic words only, never conversation summaries.",
  inputSchema: { series: seriesArg },
  annotations: { readOnlyHint: true },
  next: "Want your prep brief for the next session?",
  async run({ series: wanted }, { store }) {
    const { series, why, failure } = await chooseSeries(store, wanted, "recent");
    if (!series) return failure;
    if (series.id === OTHER_ID) {
      return text("The since-last-session digest is off for Other, because it isn't a recurring series. Name a series to see its digest.");
    }
    const digest = await store.getDigest(series.id);
    if (!digest) return text(`There's no ${series.name} digest yet. It's computed every 15 minutes once a session is recorded.`);
    const now = Date.now();
    const [records, all, queue] = await Promise.all([store.listJournalRecords(), store.listSeries(), store.listReviewItems()]);
    return say(
      why,
      json({
        series: series.name,
        fromBee: buttonReceipt(records, all, now),
        review: reviewLine(queue, now),
        summary: digestSentence(digest, now),
        lastSessionEndedLocal: digest.since ? formatLocal(Date.parse(digest.since), series.timezone) : null,
        conversations: digest.conversations,
        topics: digest.topics,
        insightTitles: digest.insightTitles,
        todosAdded: digest.todos,
        countsMayBeLow: digest.partial,
        ...nextSessionView(series, now),
        computedAt: digest.computedAt,
      }),
    );
  },
});
