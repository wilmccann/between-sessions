// The one list of what Between Sessions can do. The tools, the menu, the
// prompts and the next-step hints all come from here, so they can't drift.
import type { ToolDef } from "./tool.js";
import addAgendaItem from "./tools/add-agenda-item.js";
import getLastSession from "./tools/get-last-session.js";
import getPrepBrief from "./tools/get-prep-brief.js";
import listAgenda from "./tools/list-agenda.js";
import listSessions from "./tools/list-sessions.js";
import saveTakeaway from "./tools/save-takeaway.js";

export interface Capability {
  id: string;
  // Menu line, short enough to speak, and one example of asking for it.
  label: string;
  example: string;
  tools: ToolDef[];
}

export const CAPABILITIES: Capability[] = [
  {
    id: "prep",
    label: "Prepare for your next session",
    example: "Give me my prep brief",
    tools: [getPrepBrief],
  },
  {
    id: "sessions",
    label: "Look back at your last session, as Bee first summarized it",
    example: "What did we cover last session?",
    tools: [getLastSession, listSessions],
  },
  {
    id: "agenda",
    label: "Keep an agenda for next time",
    example: "Add the work trip to my agenda",
    tools: [addAgendaItem, listAgenda],
  },
  {
    id: "takeaway",
    label: "Save a takeaway from the session you just had",
    example: "Save a takeaway: delegate earlier",
    tools: [saveTakeaway],
  },
];

export const TOOLS: ToolDef[] = CAPABILITIES.flatMap((c) => c.tools);
