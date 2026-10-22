import { describeSession } from "../views.js";
import { defineTool, json, seriesArg, text, withSeries } from "../tool.js";

export default defineTool({
  name: "get_last_session",
  title: "Last session",
  description:
    "Get the most recent session in a recurring series, such as weekly coaching: when it was, how long it ran, Bee's summary of each part, and the insights Bee wrote in the first night after it.",
  inputSchema: { series: seriesArg },
  annotations: { readOnlyHint: true },
  async run({ series: wanted }, { store }) {
    const { series, failure } = await withSeries(store, wanted);
    if (!series) return failure;
    const latest = await store.getLatestSession(series.id);
    if (!latest) return text(`There's no ${series.name} session recorded yet.`);
    return json(describeSession(series, latest));
  },
});
