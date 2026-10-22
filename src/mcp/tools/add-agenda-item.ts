import { openAgenda } from "../../store/agenda.js";
import { defineTool, noteText, seriesArg, text, withSeries } from "../tool.js";

export default defineTool({
  name: "add_agenda_item",
  title: "Add agenda item",
  description:
    "Add something to bring up at the next session, for example: add 'ask about the offsite' to my coaching agenda. It stays on the agenda until the next session happens.",
  inputSchema: { series: seriesArg, text: noteText.describe("What to bring up, in a sentence or less.") },
  async run({ series: wanted, text: item }, { store }) {
    const { series, failure } = await withSeries(store, wanted);
    if (!series) return failure;
    await store.addAgendaItem(series.id, item);
    const open = openAgenda(await store.listAgenda(series.id), await store.getLatestSession(series.id));
    return text(`Added to your ${series.name} agenda. You have ${open.length} open item${open.length === 1 ? "" : "s"}.`);
  },
});
