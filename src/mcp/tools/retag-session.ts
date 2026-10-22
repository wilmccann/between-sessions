import { z } from "zod";
import { choose } from "../../choose.js";
import { findTarget, retag } from "../../review.js";
import { defineTool, error, text } from "../tool.js";

export default defineTool({
  name: "retag_session",
  title: "Retag a session",
  description:
    "Confirm or correct which series a session belongs to, or say it wasn't a session. Use the id from review_sessions or list_sessions, or \"last\" for the most recent. Moves the session with its takeaways and debrief, and reads back what changed, including agenda effects.",
  inputSchema: {
    id: z.string().min(1).describe('The session id from review_sessions or list_sessions, or "last".'),
    series: z.string().optional().describe("The series it belongs to (the guess, to confirm it)."),
    notASession: z.boolean().optional().describe("True when it wasn't a session at all."),
  },
  next: "Anything else to review?",
  async run({ id, series: wanted, notASession }, { store }) {
    if (!wanted && !notASession) return error("Say which series it belongs to, or that it wasn't a session.");
    const all = await store.listSeries();
    const target = await findTarget(store, id, all);
    if (!target) return error(`I can't find a session or guess with id ${id}.`);
    if (notASession) return text(await retag(store, target, "not-session", all));
    const c = await choose(store, wanted, "recent", Date.now(), all);
    if (!c.series) return error(c.ask);
    return text(await retag(store, target, c.series, all));
  },
});
