// The one list of what Between Sessions can do. The tools, the menu, the
// server instructions, the prompts and the next-step hints all come from
// here, so they can't drift. Each new capability adds one entry.
import { defineTool, text, type ToolDef } from "./tool.js";
import addAgendaItem from "./tools/add-agenda-item.js";
import getLastSession from "./tools/get-last-session.js";
import getPrepBrief from "./tools/get-prep-brief.js";
import getSinceLastSession from "./tools/get-since-last-session.js";
import listAgenda from "./tools/list-agenda.js";
import listSessions from "./tools/list-sessions.js";
import removeAgendaItem from "./tools/remove-agenda-item.js";
import saveTakeaway from "./tools/save-takeaway.js";

export interface CapabilityPrompt {
  name: string; // what `/` lists in Claude Code
  title: string;
  // Optional string arguments, by name, with a description each.
  args: Record<string, string>;
  text: (args: Record<string, string | undefined>) => string;
}

export interface Capability {
  id: string;
  // Menu line, short enough to speak, and one example of asking for it.
  label: string;
  example: string;
  tools: ToolDef[];
  prompt?: CapabilityPrompt;
  // In the spoken menu (three or four items); the rest are still tools.
  inMenu: boolean;
}

const inSeries = (series?: string) => (series ? ` for ${series}` : "");

export const CAPABILITIES: Capability[] = [
  {
    id: "prep",
    label: "prepare for your next session",
    example: "Give me my prep brief",
    tools: [getPrepBrief],
    inMenu: true,
    prompt: {
      name: "prep",
      title: "Prep brief",
      args: { series: "Which series, if you have more than one" },
      text: ({ series }) => `Give me my prep brief${inSeries(series)}. Keep it short.`,
    },
  },
  {
    id: "since",
    label: "hear what's happened since your last session",
    example: "What's happened since my last session?",
    tools: [getSinceLastSession],
    inMenu: true,
    prompt: {
      name: "since",
      title: "Since last session",
      args: { series: "Which series, if you have more than one" },
      text: ({ series }) => `What's happened since my last session${inSeries(series)}?`,
    },
  },
  {
    id: "sessions",
    label: "look back at your last session, as Bee first summarized it",
    example: "What did we cover last session?",
    tools: [getLastSession, listSessions],
    inMenu: false,
  },
  {
    id: "agenda",
    label: "keep an agenda for next time",
    example: "Add the work trip to my agenda",
    tools: [addAgendaItem, listAgenda, removeAgendaItem],
    inMenu: true,
    prompt: {
      name: "agenda",
      title: "Agenda",
      args: { item: "Something to bring up next time; leave it out to see the agenda", series: "Which series" },
      text: ({ item, series }) =>
        item ? `Add "${item}" to my agenda${inSeries(series)}.` : `What's on my agenda${inSeries(series)}?`,
    },
  },
  {
    id: "takeaway",
    label: "save a takeaway from the session you just had",
    example: "Save a takeaway: delegate earlier",
    tools: [saveTakeaway],
    inMenu: true,
    prompt: {
      name: "takeaway",
      title: "Save a takeaway",
      args: { text: "The takeaway, in your words", series: "Which series" },
      text: ({ text, series }) =>
        text ? `Save a takeaway${inSeries(series)}: ${text}` : `I want to save a takeaway from my last session${inSeries(series)}.`,
    },
  },
  {
    id: "help",
    label: "say what you can ask",
    example: "What can I ask?",
    inMenu: false,
    tools: [
      defineTool({
        name: "help",
        title: "What can I ask?",
        description:
          "Say what Between Sessions can do, with one example each, short enough to read aloud. Use it when the user asks what they can ask, or asks for something outside these capabilities.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
        run: async () => text(`${menu()}\n\n${BOUNDARY}`),
      }),
    ],
    prompt: { name: "help", title: "What can I ask?", args: {}, text: () => "What can I ask Between Sessions?" },
  },
];

export const TOOLS: ToolDef[] = CAPABILITIES.flatMap((c) => c.tools);

export const BOUNDARY =
  "I see your sessions, including any you mark with the Bee button. For anything else Bee knows, use the Bee app.";

// Short enough to speak: one line per capability, with one example each.
export function menu(): string {
  const items = CAPABILITIES.filter((c) => c.inMenu).map((c) => `${c.label[0].toUpperCase()}${c.label.slice(1)}: "${c.example}"`);
  return `You can ask me to:\n${items.map((i) => `- ${i}`).join("\n")}`;
}

export function instructions(): string {
  return [
    "Between Sessions follows the week around a recurring 1:1 (therapy, coaching, an interview loop): it helps you prepare before a session, keep what mattered after it, and capture what happens in between, using what the user's Bee already heard.",
    "",
    "When the user asks what they can do, answer with this menu in plain words, without tool names:",
    menu(),
    `Also, when asked: ${CAPABILITIES.filter((c) => !c.inMenu && c.id !== "help")
      .map((c) => `${c.label} ("${c.example}")`)
      .join("; ")}.`,
    "",
    `For anything outside these, say: "${BOUNDARY}"`,
    "",
    "Rules:",
    "- Keep answers short; offer more on request.",
    "- When a result has `seriesChosen`, say which series you used.",
    "- When a result has `next`, end with that one suggestion, phrased as a question.",
    "- Read back every write (\"Added: the work trip.\").",
    "- Don't quote Bee summaries at length; paraphrase.",
  ].join("\n");
}
