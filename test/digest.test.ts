import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BeeConversation, BeeInsight, BeeTodo } from "../src/bee/cli.js";
import { recordSnapshot } from "../src/collector.js";
import { digestSentence, topicWords } from "../src/digest.js";
import { createMcpServer } from "../src/mcp/server.js";
import { prepBrief } from "../src/mcp/views.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import type { Digest } from "../src/store/types.js";
import { at, insight } from "./fixtures/index.js";
import { other, therapy } from "./fixtures/meeting-types.js";

// Synthetic weeks in New York. Therapy is Tue 17:00 to 18:00; the last
// session is Tue Oct 13, 2026.
const talk = (id: number, start: string, end: string, summary: string): BeeConversation => ({
  id,
  start_time: at(start),
  end_time: at(end),
  summary,
  short_summary: "Check-in",
  state: "COMPLETED",
  created_at: at(end),
  updated_at: at(end),
  utterances_count: 10,
});
const todo = (id: number, time: string): BeeTodo => ({ id, text: `Synthetic todo ${id}`, completed: false, created_at: at(time) });

const session = talk(801, "2026-10-13T17:02:00-04:00", "2026-10-13T17:55:00-04:00", "Trip planning came up, and sleep. The trip again, and sleep.");
const since = [
  talk(811, "2026-10-14T09:00:00-04:00", "2026-10-14T09:20:00-04:00", "A trip to the airport."),
  talk(812, "2026-10-15T09:00:00-04:00", "2026-10-15T09:20:00-04:00", "Packing for the trip; sleep was short."),
  talk(813, "2026-10-16T19:00:00-04:00", "2026-10-16T20:00:00-04:00", "Dinner with friends."),
  talk(814, "2026-10-17T08:00:00-04:00", "2026-10-17T08:30:00-04:00", "A podcast about sleep."),
  talk(815, "2026-10-18T12:00:00-04:00", "2026-10-18T12:10:00-04:00", "Trip photos."),
];
const todos = [todo(1, "2026-10-12T10:00:00-04:00"), todo(2, "2026-10-15T10:00:00-04:00"), todo(3, "2026-10-16T10:00:00-04:00")];
const insights: BeeInsight[] = [insight(901, "2026-10-14T03:00:00-04:00"), insight(902, "2026-10-16T03:00:00-04:00")];

let store: TableStore;
let path: string;
beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), "bs-digest-")), "store.json");
  store = fileStore(path);
  await store.putSeries(therapy);
  await store.putSeries(other);
});

const run = (collectedAt: string, conversations: BeeConversation[], ins = insights, tds = todos) =>
  recordSnapshot(store, [therapy, other], { collectedAt: new Date(collectedAt).toISOString(), conversations, insights: ins, todos: tds });

describe("digest", () => {
  it("takes topics from the last session's summaries and the capture keywords", () => {
    const words = topicWords({ start: "", end: "", insights: [], parts: [{ id: 1, start: "", end: "", shortSummary: "Check-in", summary: session.summary }] }, therapy);
    assert.deepEqual(words, ["trip", "sleep"]);
    assert.deepEqual(topicWords(null, { ...therapy, captureKeywords: ["Therapist"] }), ["therapist"]);
  });

  it("counts conversations, topics, todos and new insights since the last session", async () => {
    await run("2026-10-19T12:00:00-04:00", [session, ...since]);
    const d = (await store.getDigest(therapy.id))!;
    assert.equal(d.since, new Date(session.end_time).toISOString());
    assert.equal(d.conversations, 5);
    assert.deepEqual(d.topics, [
      { word: "trip", count: 3 },
      { word: "sleep", count: 2 },
    ]);
    assert.equal(d.todos, 2);
    assert.deepEqual(d.insightTitles, ["Synthetic insight 902"]);
    assert.equal(d.partial, false);
    assert.equal(
      digestSentence(d, at("2026-10-19T18:00:00-04:00")),
      "It's been 6 days and 5 conversations. From last session, trip (3 times) and sleep (twice) came up again. Bee noticed: Synthetic insight 902. You added 2 todos.",
    );
  });

  it("keeps counting after Bee's 14-day history drops the early days", async () => {
    await run("2026-10-19T12:00:00-04:00", [session, ...since]);
    const later = talk(816, "2026-10-25T10:00:00-04:00", "2026-10-25T10:20:00-04:00", "Booking the next trip.");
    await run("2026-11-02T12:00:00-05:00", [since[4], later], [], [todo(4, "2026-10-26T10:00:00-04:00")]);
    const d = (await store.getDigest(therapy.id))!;
    assert.equal(d.conversations, 6);
    assert.deepEqual(d.topics[0], { word: "trip", count: 4 });
    assert.equal(d.todos, 3);
  });

  it("says when its counts may be low", async () => {
    // A store that saw the session but none of the days after it.
    await run("2026-10-19T12:00:00-04:00", [session]);
    const fresh = fileStore(join(await mkdtemp(join(tmpdir(), "bs-digest-")), "store.json"));
    await fresh.putSeries(therapy);
    await fresh.recordSession(therapy.id, (await store.getLatestSession(therapy.id))!, "2026-10-13T22:15:00.000Z");
    await recordSnapshot(fresh, [therapy], { collectedAt: "2026-11-02T17:00:00.000Z", conversations: [since[4]], insights: [], todos: [] });
    assert.equal((await fresh.getDigest(therapy.id))?.partial, true);
  });

  it("is off for Other and stores no summaries", async () => {
    await run("2026-10-19T12:00:00-04:00", [session, ...since]);
    assert.equal(await store.getDigest(other.id), null);
    const raw = await readFile(path, "utf8");
    assert.ok(!raw.includes("airport") && !raw.includes("Dinner with friends") && !raw.includes("Synthetic todo"));
  });

  it("speaks of hours between same-day interview rounds", () => {
    const d: Digest = {
      seriesId: "acme-interview",
      computedAt: "",
      since: "2026-10-22T14:50:00.000Z",
      conversations: 1,
      todos: 0,
      insightTitles: [],
      topics: [],
      partial: false,
    };
    assert.equal(digestSentence(d, at("2026-10-22T17:55:00.000Z")), "It's been 3 hours and 1 conversation.");
  });
});

describe("get_since_last_session", () => {
  let client: Client;
  beforeEach(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(store).connect(a);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(b);
  });
  const call = async (args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: "get_since_last_session", arguments: args });
    return (res.content as { text: string }[])[0].text;
  };

  it("answers in one call, and the prep brief includes it", async () => {
    await run("2026-10-19T12:00:00-04:00", [session, ...since]);
    const res = JSON.parse(await call({ series: "therapy" })) as { summary: string; conversations: number; next: string };
    assert.equal(res.conversations, 5);
    assert.match(res.summary, /^It's been \d+ days and 5 conversations\./);
    assert.ok(res.next);
    const brief = await prepBrief(store, therapy, at("2026-10-19T18:00:00-04:00"));
    assert.match(brief.sinceLastSession!, /^It's been 6 days and 5 conversations/);
  });

  it("says the digest is off for Other", async () => {
    assert.match(await call({ series: "Other" }), /off for Other/);
  });
});
