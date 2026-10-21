import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { recordSnapshot } from "../src/collector.js";
import { buildPrompt, converseInput, parseNotes, writeNotes, type NotesInput } from "../src/notes/bedrock.js";
import { writeBriefs } from "../src/notes/briefs.js";
import { matchSessions, sessionInput } from "../src/sessions.js";
import { fileStore } from "../src/store/file-store.js";
import { conversations, insights, series } from "./fixtures/index.js";

const input: NotesInput = {
  session: sessionInput(matchSessions(conversations, series)[0], insights, series),
  takeaways: ["Delegate earlier"],
  agenda: ["Ask about the offsite"],
};

const toolReply = (value: unknown) => ({ message: { content: [{ toolUse: { name: "save_notes", input: value } }] } });

describe("Bedrock notes", () => {
  it("wraps the data and forces the tool", () => {
    const req = converseInput(input, "test-model");
    assert.equal(req.inferenceConfig?.maxTokens, 1200);
    assert.deepEqual(req.toolConfig?.toolChoice, { tool: { name: "save_notes" } });
    const prompt = buildPrompt(input);
    assert.ok(prompt.startsWith("<data>") && prompt.includes("Ask about the offsite"));
  });

  it("parses the tool call and drops unknown insight ids", () => {
    const notes = parseNotes(toolReply({ note: "You talked.", bullets: ["One"], relevantInsightIds: [2002, 9999] }), input);
    assert.deepEqual(notes.relevantInsightIds, [2002]);
  });

  it("falls back to JSON in text", () => {
    const output = { message: { content: [{ text: 'Here: {"note":"N","bullets":["B"],"relevantInsightIds":[]}' }] } };
    assert.equal(parseNotes(output, input).note, "N");
  });

  it("rejects a reply without notes", () => {
    assert.throws(() => parseNotes({ message: { content: [{ text: "no" }] } }, input));
  });

  it("writes a brief only for each series' latest session", async () => {
    const store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-notes-")), "store.json"));
    await store.putSeries(series);
    const run = await recordSnapshot(store, [series], {
      collectedAt: "2026-10-22T12:00:00.000Z",
      conversations,
      insights,
    });
    let calls = 0;
    const fake: typeof writeNotes = async (i) => {
      calls++;
      return { ...parseNotes(toolReply({ note: "Synthetic note.", bullets: ["B"], relevantInsightIds: [2002] }), i), model: "fake" };
    };
    assert.deepEqual(await writeBriefs(store, run.written, fake), { briefs: 1, failed: 0 });
    assert.equal(calls, 1);
    const latest = await store.getLatestSession(series.id);
    assert.equal((await store.getPrepBrief(series.id, latest!.start))?.note, "Synthetic note.");

    const failing: typeof writeNotes = async () => {
      throw new Error("boom");
    };
    assert.deepEqual(await writeBriefs(store, run.written, failing), { briefs: 0, failed: 1 });
  });
});
