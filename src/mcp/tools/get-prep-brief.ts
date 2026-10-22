import { prepBrief } from "../views.js";
import { defineTool, json, seriesArg, withSeries } from "../tool.js";

export default defineTool({
  name: "get_prep_brief",
  title: "Prep brief",
  description:
    "Get a short brief to prepare for the next session: when the last one was, what it covered, Bee's insights after it, your takeaways, and your open agenda items.",
  inputSchema: { series: seriesArg },
  annotations: { readOnlyHint: true },
  async run({ series: wanted }, { store }) {
    const { series, failure } = await withSeries(store, wanted);
    if (!series) return failure;
    return json(await prepBrief(store, series));
  },
});
