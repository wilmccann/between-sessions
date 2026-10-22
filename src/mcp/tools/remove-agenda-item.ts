import { bestAgendaMatch } from "../../button.js";
import { openAgenda } from "../../store/agenda.js";
import { chooseSeries, defineTool, error, noteText, say, seriesArg, text } from "../tool.js";

export default defineTool({
  name: "remove_agenda_item",
  title: "Remove agenda item",
  description:
    "Take something off the agenda for the next session, for example: drop the work trip from my agenda. Matches the open item by its words, including items added with the Bee button.",
  inputSchema: { series: seriesArg, text: noteText.describe("The item to remove, in a few words.") },
  next: "Want to see what's left on the agenda?",
  async run({ series: wanted, text: words }, { store }) {
    const { series, why, failure } = await chooseSeries(store, wanted, "next");
    if (!series) return failure;
    const open = openAgenda(await store.listAgenda(series.id), await store.getLatestSession(series.id));
    const item = bestAgendaMatch(open, words);
    if (!item) return error(`Nothing on your ${series.name} agenda matches "${words}".`);
    await store.removeAgendaItem(item);
    const left = open.length - 1;
    return say(why, text(`Removed: ${item.text}. You have ${left} open item${left === 1 ? "" : "s"}.`));
  },
});
