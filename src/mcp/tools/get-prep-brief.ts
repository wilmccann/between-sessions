import { prepBrief } from "../views.js";
import { chooseSeries, defineTool, json, say, seriesArg } from "../tool.js";

export default defineTool({
  name: "get_prep_brief",
  title: "Prep brief",
  description:
    "Get a short brief to prepare for the next session: when the last one was, what it covered, Bee's insights after it, your takeaways, your open agenda items, and when the next session is.",
  inputSchema: { series: seriesArg },
  annotations: { readOnlyHint: true },
  next: "Want to add something to your agenda?",
  async run({ series: wanted }, { store }) {
    const { series, why, failure } = await chooseSeries(store, wanted, "next");
    if (!series) return failure;
    return say(why, json(await prepBrief(store, series)));
  },
});
