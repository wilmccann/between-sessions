import { openAgenda } from "../../store/agenda.js";
import { chooseSeries, defineTool, json, say, seriesArg, text } from "../tool.js";

export default defineTool({
  name: "list_agenda",
  title: "Open agenda",
  description:
    "List the things you planned to bring up at the next session in a series, oldest first. Items added before the last session are left out.",
  inputSchema: { series: seriesArg },
  annotations: { readOnlyHint: true },
  next: "Want your prep brief too?",
  async run({ series: wanted }, { store }) {
    const { series, why, failure } = await chooseSeries(store, wanted, "next");
    if (!series) return failure;
    const open = openAgenda(await store.listAgenda(series.id), await store.getLatestSession(series.id));
    if (!open.length) return say(why, text(`Your ${series.name} agenda is empty.`));
    return say(why, json({ series: series.name, items: open.map(({ text, createdAt }) => ({ text, createdAt })) }));
  },
});
