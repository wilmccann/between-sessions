// Runs the Bedrock notes prompt on the synthetic test fixture (never real Bee
// data) and prints the result. --write <path> also saves it as Markdown.
//
//   yarn try-notes [--model <id>] [--write docs/sample-note.md]
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { writeNotes } from "../src/notes/bedrock.js";
import { matchSessions, sessionInput } from "../src/sessions.js";
import { conversations, insights, series } from "../test/fixtures/index.js";

const { values } = parseArgs({ options: { write: { type: "string" }, model: { type: "string" } } });

const [latest] = matchSessions(conversations, series);
const input = {
  session: sessionInput(latest, insights, series),
  takeaways: ["Delegate the vendor follow-ups before the offsite."],
  agenda: ["Ask how to say no to the extra project"],
};

const started = Date.now();
const notes = await writeNotes(input, values.model ? { modelId: values.model } : {});
const ms = Date.now() - started;
console.log(JSON.stringify(notes, null, 2));
console.log(`(${ms}ms, ${notes.note.split(/\s+/).length} words in the note)`);

if (values.write) {
  const md = [
    "# Sample session note (synthetic)",
    "",
    "Output of `yarn try-notes` on the synthetic fixture in `test/fixtures/`. No real Bee data.",
    "",
    `Model: \`${notes.model}\``,
    "",
    "## Input",
    "",
    "```json",
    JSON.stringify(input, null, 2),
    "```",
    "",
    "## Session note",
    "",
    notes.note,
    "",
    "## Prep brief",
    "",
    ...notes.bullets.map((b) => `- ${b}`),
    "",
    "## Relevant insight ids",
    "",
    notes.relevantInsightIds.length ? notes.relevantInsightIds.join(", ") : "(none)",
    "",
  ].join("\n");
  await writeFile(values.write, md);
  console.log(`wrote ${values.write}`);
}
