import { formatLocal } from "../../sessions.js";
import { defineTool, error, noteText, seriesArg, text, withSeries } from "../tool.js";

export default defineTool({
  name: "save_takeaway",
  title: "Save takeaway",
  description:
    "Save your own takeaway from the most recent session, in your words, for example: my takeaway is to delegate earlier. It is filed under that session.",
  inputSchema: { series: seriesArg, text: noteText.describe("The takeaway, in a sentence or two.") },
  async run({ series: wanted, text: takeaway }, { store }) {
    const { series, failure } = await withSeries(store, wanted);
    if (!series) return failure;
    const latest = await store.getLatestSession(series.id);
    if (!latest) return error(`There's no ${series.name} session to attach a takeaway to yet.`);
    await store.saveTakeaway(series.id, latest.start, takeaway);
    return text(`Saved your takeaway from the session on ${formatLocal(Date.parse(latest.start), series.timezone)}.`);
  },
});
