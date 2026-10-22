import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyStreamEvent,
  describeCollectorResult,
  describeEvent,
  lineHandler,
  oneAtATime,
  STREAM_TYPES,
  streamOnce,
  type StreamEvent,
} from "../src/watch.js";
import { fakeBee } from "./fixtures/index.js";
import { meetingTypes } from "./fixtures/meeting-types.js";

// All synthetic. Times print in New York so the lines are stable.
const AT = Date.parse("2026-10-22T16:02:05-04:00");
const opts = { at: AT, timeZone: "America/New_York" };
const journal = (text: string, state = "READY", cleanedUpText?: string) =>
  classifyStreamEvent({
    journal: { id: "jrnl-synthetic-ab12", state, text, aiResponse: { message: "x", cleanedUpText: cleanedUpText ?? text, followUp: null, todos: [] } },
  });
const line = (event: StreamEvent, shape = false, series = meetingTypes) => describeEvent(event, series, { ...opts, shape });
const verdictOf = (text: string, series = meetingTypes) => line(journal(text), true, series).split(" -> ")[1];

describe("classifyStreamEvent", () => {
  it("tells events apart by their keys", () => {
    assert.equal(journal("hi").kind, "journal");
    assert.deepEqual(classifyStreamEvent({ journalId: "j1", text: "partial" }), { kind: "journal-text", journalId: "j1", text: "partial" });
    assert.deepEqual(classifyStreamEvent({ journalId: "j1", reason: "user" }), { kind: "journal-deleted", journalId: "j1", reason: "user" });
    assert.equal(classifyStreamEvent({ conversation: { id: 7, uuid: "u", state: "CAPTURING", title: "t" } }).kind, "new-conversation");
    assert.equal(classifyStreamEvent({ conversation: { id: 7, state: "COMPLETED", title: "t", short_summary: "s" } }).kind, "update-conversation");
    assert.equal(classifyStreamEvent({ conversation: { id: 7, title: "t" } }).kind, "delete-conversation");
    assert.deepEqual(classifyStreamEvent({ type: "connected", at: 1 }), { kind: "unknown", keys: ["type", "at"] });
    assert.deepEqual(classifyStreamEvent("nope"), { kind: "unknown", keys: [] });
  });

  it("uses an event or type field when there is one", () => {
    const created = classifyStreamEvent({ event: "journal-created", data: { journal: { id: "j2", state: "PROCESSING", text: "" } } });
    assert.equal(created.kind, "journal-created");
    assert.equal(classifyStreamEvent({ type: "journal-updated", journal: { id: "j2", state: "READY", text: "x" } }).kind, "journal-updated");
    assert.equal(classifyStreamEvent({ type: "delete-conversation", conversation: { id: 9, state: "COMPLETED" } }).kind, "delete-conversation");
  });
});

describe("describeEvent: voice notes", () => {
  it("prints the time, kind, id, state, what Bee heard and the verdict", () => {
    assert.equal(
      line(journal("Start coaching session.")),
      '16:02:05 journal …ab12 READY heard "Start coaching session." -> START, series coaching (existing series)',
    );
  });

  it("gives the collector's verdict for every command", () => {
    assert.equal(verdictOf("Start coaching session.", []), "START (new series)");
    assert.equal(line(journal("Start coaching session."), false, []).split(" -> ")[1], "START, series coaching (new series)");
    assert.equal(line(journal("Start session: Initech interview")).split(" -> ")[1], "START, series Initech interview (new series)");
    assert.equal(verdictOf("Start session."), "START");
    assert.equal(verdictOf("End session"), "END");
    assert.equal(verdictOf("Debrief: synthetic notes."), "DEBRIEF");
    assert.equal(verdictOf("Agenda: the synthetic trip"), "AGENDA");
    assert.equal(line(journal("Agenda for therapy: the synthetic trip")).split(" -> ")[1], "AGENDA (series therapy, existing series)");
    assert.equal(line(journal("Agenda for chess: x")).split(" -> ")[1], "AGENDA (series chess, no such series, can't file)");
    assert.equal(verdictOf("Takeaway: synthetic lesson"), "TAKEAWAY");
    assert.equal(line(journal("That was Acme.")).split(" -> ")[1], "RETAG to Acme (existing series)");
    assert.equal(verdictOf("Not a session."), "NOT A SESSION");
    assert.equal(verdictOf("Drop the synthetic trip from my agenda"), "DROP");
    assert.equal(verdictOf("Debrief:"), "can't file: debrief with nothing after it");
    assert.equal(verdictOf("Remember the synthetic milk"), "plain note");
  });

  it("shows what a Test: note would do", () => {
    assert.equal(
      line(journal("Test: start coaching session"), false, []).split(" -> ")[1],
      "Test: would be START, series coaching (new series)",
    );
    assert.equal(verdictOf("Testing, end session."), "Test: would be END");
    assert.equal(verdictOf("Tests came back fine"), "plain note");
  });

  it("says when Bee's cleanup changes the verdict", () => {
    const out = line(journal("And session.", "READY", "End session."));
    assert.match(out, /heard "And session\." cleaned "End session\."/);
    assert.match(out, /-> END$/);
    const changed = line(journal("Agenda the synthetic trip", "READY", "A gender: the synthetic trip"));
    assert.match(changed, /\(cleanup changes the verdict: raw=AGENDA cleaned=plain note\)$/);
  });

  it("waits for text", () => {
    assert.equal(line(journal("", "PROCESSING")), "16:02:05 journal …ab12 PROCESSING -> no text yet");
  });

  it("prints no text with shape", () => {
    const out = line(journal("Start session: Initech interview", "READY", "Start session, Initech interview."), true);
    assert.equal(out, "16:02:05 journal …ab12 READY -> START (new series)");
    assert.doesNotMatch(out, /Initech/);
    const partial = classifyStreamEvent({ journalId: "jrnl-synthetic-cd34", text: "synthetic partial words" });
    assert.equal(line(partial, true), "16:02:05 journal-text …cd34 3 words");
    assert.equal(line(partial), '16:02:05 journal-text …cd34 3 words: "synthetic partial words"');
    const deleted = classifyStreamEvent({ journalId: "jrnl-synthetic-cd34", reason: "synthetic reason" });
    assert.equal(line(deleted, true), "16:02:05 journal-deleted …cd34");
    assert.equal(line(deleted), "16:02:05 journal-deleted …cd34 (synthetic reason)");
  });
});

describe("describeEvent: conversations and the rest", () => {
  it("prints only the id and state of a conversation, never its title or summary", () => {
    const events = [
      { conversation: { id: 424242, uuid: "u", state: "CAPTURING", title: "Synthetic secret title" } },
      { conversation: { id: 424242, state: "COMPLETED", title: "Synthetic secret title", short_summary: "Synthetic private summary" } },
      { conversation: { id: 424242, title: "Synthetic secret title" } },
    ].map(classifyStreamEvent);
    const lines = events.flatMap((e) => [line(e), line(e, true)]);
    assert.deepEqual(lines.slice(0, 2), ["16:02:05 new-conversation 424242 CAPTURING", "16:02:05 new-conversation 424242 CAPTURING"]);
    assert.equal(lines[2], "16:02:05 update-conversation 424242 COMPLETED");
    assert.equal(lines[4], "16:02:05 delete-conversation 424242");
    for (const l of lines) assert.doesNotMatch(l, /secret|private/i);
  });

  it("names only the keys of an unrecognized event", () => {
    assert.equal(line(classifyStreamEvent({ utterance: { text: "secret" }, at: 1 })), "16:02:05 unrecognized event (keys: utterance, at)");
  });
});

describe("collector counts", () => {
  it("prints counts only", () => {
    const out = describeCollectorResult({
      conversations: 12,
      insights: 3,
      series: 2,
      matched: 1,
      replaced: 0,
      written: 1,
      writtenSessions: [{ seriesId: "synthetic-series", start: "2026-10-22T20:00:00.000Z", versions: 1 }],
      briefs: 0,
      briefsFailed: 0,
      configRefreshed: false,
      durationMs: 4200,
    });
    assert.equal(
      out,
      "collector: 12 conversations, 3 insights, 2 series, 1 matched, 0 replaced, 1 written (1 sessions), 0 briefs, 0 briefs failed, config refreshed no, 4.2s",
    );
    assert.doesNotMatch(out, /synthetic-series|2026/);
  });

  it("runs one at a time and queues at most one more", async () => {
    let runs = 0;
    let release!: () => void;
    const run = oneAtATime(async () => {
      runs++;
      await new Promise<void>((r) => (release = r));
    });
    run();
    run();
    run();
    assert.equal(runs, 1);
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(runs, 2);
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(runs, 2);
  });
});

describe("the watcher against a fake bee stream", () => {
  it("prints a line per event and fires READY once per note", async () => {
    const printed: string[] = [];
    const ready: string[] = [];
    const handle = lineHandler({ series: () => [], ...opts, print: (l) => printed.push(l), onReady: (id) => ready.push(id) });
    const code = await streamOnce(fakeBee, handle);
    assert.equal(code, 0);
    assert.deepEqual(printed, [
      "16:02:05 unrecognized event (keys: type)",
      '16:02:05 journal-text …0001 3 words: "Test start coaching"',
      "16:02:05 journal …0001 PROCESSING -> no text yet",
      '16:02:05 journal …0001 READY heard "Test: start coaching session." -> Test: would be START, series coaching (new series)',
      '16:02:05 journal …0001 READY heard "Test: start coaching session." -> Test: would be START, series coaching (new series)',
      "16:02:05 new-conversation 424242 CAPTURING",
      "16:02:05 unparsed line (15 characters)",
      "16:02:05 update-conversation 424242 COMPLETED",
    ]);
    assert.deepEqual(ready, ["jrnl-synthetic-0001"]);
  });

  it("runs as yarn watch, from the file store, and reconnects when the stream ends", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bs-watch-"));
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/watch.ts", "--store", "file", "--shape"], {
      env: { ...process.env, BEE_BIN: fakeBee, STORE_FILE: join(dir, "store.json") },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reconnect line in time: ${out}`)), 20_000);
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("reconnecting in 5 s")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    child.kill();
    assert.match(out, /^Watching Bee voice notes .*0 series from the file store, shape only\). The first connection can take about 20 s/);
    assert.match(out, / journal …0001 READY -> Test: would be START \(new series\)\n/);
    assert.match(out, /stream ended \(exit 0\); reconnecting in 5 s/);
    assert.doesNotMatch(out, /secret|private|coaching/i);
  });

  it("never asks the stream for utterance, location or todo events", async () => {
    assert.doesNotMatch(STREAM_TYPES.join(","), /utterance|location|todo/);
    // The fake refuses them, so the check above is what keeps the run clean.
    assert.equal(await streamOnce(fakeBee, () => {}, ["new-utterance"]), 2);
  });
});
