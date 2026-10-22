import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BeeConversation, BeeJournal } from "../src/bee/cli.js";
import { recordSnapshot } from "../src/collector.js";
import { createMcpServer } from "../src/mcp/server.js";
import { prepBrief } from "../src/mcp/views.js";
import { refId, reviewLine } from "../src/review.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import type { ReviewItem } from "../src/store/types.js";
import { at } from "./fixtures/index.js";
import { acme, coaching, other, therapy } from "./fixtures/meeting-types.js";

// Synthetic October 2026 in New York (EDT). Coaching is Thu 16:00 to 17:00
// with the keyword "coach"; therapy is Tue 17:00 to 18:00 with no keywords.
const t = (hhmm: string, day: string) => `${day}T${hhmm}:00-04:00`;
const talk = (id: number, start: string, end: string, summary = "Synthetic planning chat."): BeeConversation => ({
  id,
  start_time: at(start),
  end_time: at(end),
  summary,
  short_summary: "Synthetic",
  state: "COMPLETED",
  created_at: at(end),
  updated_at: at(end),
  utterances_count: 10,
});
const note = (id: string, time: string, text: string): BeeJournal => ({
  id,
  text,
  state: "READY",
  created_at: at(time),
  updated_at: at(time),
  corrections: [],
});

let store: TableStore;
let path: string;
let client: Client;
beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), "bs-review-")), "store.json");
  store = fileStore(path);
  for (const s of [therapy, coaching, acme]) await store.putSeries(s);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store).connect(a);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(b);
});

const run = async (collectedAt: string, conversations: BeeConversation[], journals: BeeJournal[] = []) =>
  recordSnapshot(store, await store.listSeries(), { collectedAt: new Date(collectedAt).toISOString(), conversations, insights: [], journals });
const call = async (name: string, args: Record<string, unknown> = {}) =>
  ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text;

const offWeek = talk(901, t("16:02", "2026-10-15"), t("16:55", "2026-10-15"), "Synthetic chat about a garden.");
const coached = talk(902, t("16:02", "2026-10-22"), t("16:55", "2026-10-22"), "The coach and the user planned next steps.");

describe("how a guess is made", () => {
  it("queues a schedule-only match in an off week and doesn't file it", async () => {
    const result = await run(t("18:00", "2026-10-15"), [offWeek]);
    assert.equal(result.review, 1);
    assert.equal(await store.getLatestSession(coaching.id), null);
    const [item] = await store.listReviewItems();
    assert.equal(item.filed, false);
    assert.equal(item.reason, "Thu 16:00 to 17:00 slot only");
    assert.deepEqual(item.conversationIds, [901]);
    const raw = await readFile(path, "utf8");
    assert.ok(!raw.includes("garden"), "a pending guess stores no summary");
  });

  it("files the slot when Bee's summary has a series keyword", async () => {
    await run(t("18:00", "2026-10-22"), [coached]);
    const s = await store.getLatestSession(coaching.id);
    assert.equal(s?.tag?.confidence, "high");
    assert.match(s!.tag!.reason, /"coach" in Bee's summary/);
    assert.deepEqual(await store.listReviewItems(), []);
  });

  it("files a named marker with no review", async () => {
    await run(t("12:00", "2026-10-21"), [talk(903, t("10:01", "2026-10-21"), t("10:40", "2026-10-21"))], [
      note("m1", t("10:00", "2026-10-21"), "Marty, Start session: Acme interview"),
      note("m2", t("10:41", "2026-10-21"), "Marty, End session"),
    ]);
    assert.equal((await store.getLatestSession(acme.id))?.tag?.confidence, "certain");
    assert.deepEqual(await store.listReviewItems(), []);
  });

  it("queues a long conversation that mentions a keyword", async () => {
    await run(t("15:00", "2026-10-21"), [talk(904, t("13:00", "2026-10-21"), t("13:45", "2026-10-21"), "Talked through the Acme role.")]);
    const [item] = await store.listReviewItems();
    assert.equal(item.seriesId, acme.id);
    assert.equal(item.source, "keyword");
    assert.match(item.reason, /"acme" in Bee's summary, 45 minutes/);
  });
});

describe("review_sessions and retag_session", () => {
  it("lists the queue without summaries, and the brief shows the review line", async () => {
    await run(t("18:00", "2026-10-15"), [offWeek]);
    const res = JSON.parse(await call("review_sessions")) as { line: string; sessions: { id: string; guess: string; beeId: string; durationMinutes: number }[] };
    assert.equal(res.line, "1 session to review.");
    assert.equal(res.sessions[0].guess, "Coaching");
    assert.equal(res.sessions[0].beeId, "901");
    assert.equal(res.sessions[0].durationMinutes, 53);
    assert.ok(!JSON.stringify(res).includes("garden"));
    const brief = await prepBrief(store, coaching, at(t("18:00", "2026-10-15")));
    assert.equal(brief.review, "1 session to review.");
  });

  it("confirming a guess stores the session on the next run", async () => {
    await run(t("18:00", "2026-10-15"), [offWeek]);
    const [item] = await store.listReviewItems();
    assert.match(await call("retag_session", { id: refId(item), series: "coaching" }), /Filed the .* conversation under Coaching/);
    assert.deepEqual(await store.listReviewItems(), []);
    await run(t("18:15", "2026-10-15"), [offWeek]);
    const s = await store.getLatestSession(coaching.id);
    assert.equal(s?.tag?.status, "confirmed");
    assert.equal(s?.parts[0].summary, "Synthetic chat about a garden.");
    assert.deepEqual(await store.listReviewItems(), []);
  });

  it("a rejected guess is never queued again", async () => {
    await run(t("18:00", "2026-10-15"), [offWeek]);
    const [item] = await store.listReviewItems();
    assert.match(await call("retag_session", { id: refId(item), notASession: true }), /won't be suggested again/);
    await run(t("18:15", "2026-10-15"), [offWeek]);
    assert.deepEqual(await store.listReviewItems(), []);
    assert.equal(await store.getLatestSession(coaching.id), null);
  });

  it("retagging moves the takeaway and reopens the agenda items it had closed", async () => {
    const earlier = talk(910, t("17:02", "2026-10-13"), t("17:55", "2026-10-13"));
    const later = talk(911, t("17:02", "2026-10-20"), t("17:55", "2026-10-20"));
    await run(t("19:00", "2026-10-20"), [earlier, later]);
    const latest = (await store.getLatestSession(therapy.id))!;
    await store.saveTakeaway(therapy.id, latest.start, "Synthetic takeaway");
    await store.addAgendaItem(therapy.id, "Synthetic item", { createdAt: new Date(t("09:00", "2026-10-16")).toISOString() });
    assert.equal((await prepBrief(store, therapy, at(t("19:00", "2026-10-20")))).openAgenda.length, 0);

    const out = await call("retag_session", { id: refId({ seriesId: therapy.id, start: latest.start }), series: "Acme" });
    assert.match(out, /Moved the .* session from Weekly therapy to Acme interview\. 1 agenda item reopened on Weekly therapy\./);
    assert.match(out, /Your Acme interview agenda has 0 open items/);
    assert.deepEqual((await store.listTakeaways(acme.id, latest.start)).map((x) => x.text), ["Synthetic takeaway"]);
    assert.equal((await store.listTakeaways(therapy.id)).length, 0);
    assert.equal((await store.getLatestSession(acme.id))?.tag?.status, "confirmed");

    // The schedule doesn't pull it back into therapy on the next run.
    await run(t("19:15", "2026-10-20"), [earlier, later]);
    assert.equal((await store.getLatestSession(therapy.id))?.start, new Date(earlier.start_time).toISOString());
    assert.equal((await store.listSessions(acme.id, 5)).length, 1);
  });

  it("not a session deletes it, keeps your notes on the session before, and stays gone", async () => {
    const earlier = talk(920, t("17:02", "2026-10-13"), t("17:55", "2026-10-13"));
    const later = talk(921, t("17:02", "2026-10-20"), t("17:55", "2026-10-20"));
    await run(t("19:00", "2026-10-20"), [earlier, later]);
    const latest = (await store.getLatestSession(therapy.id))!;
    await store.saveTakeaway(therapy.id, latest.start, "Synthetic takeaway");
    const out = await call("retag_session", { id: "last", notASession: true });
    assert.match(out, /as not a session\..*Your 1 note from it moved to the session before\./);
    assert.equal((await store.getLatestSession(therapy.id))?.start, new Date(earlier.start_time).toISOString());
    assert.equal((await store.listTakeaways(therapy.id, new Date(earlier.start_time).toISOString())).length, 1);
    await run(t("19:15", "2026-10-20"), [earlier, later]);
    assert.equal((await store.listSessions(therapy.id, 5)).length, 1);
  });

  it("not a session with no session before keeps your notes under Other", async () => {
    const only = talk(922, t("17:02", "2026-10-20"), t("17:55", "2026-10-20"));
    await run(t("19:00", "2026-10-20"), [only]);
    const start = (await store.getLatestSession(therapy.id))!.start;
    await store.saveTakeaway(therapy.id, start, "Synthetic takeaway");
    const out = await call("retag_session", { id: "last", notASession: true });
    assert.match(out, /as not a session\..*Your 1 note from it was kept under Other\./);
    assert.equal(await store.getLatestSession(therapy.id), null);
    assert.equal((await store.listTakeaways(therapy.id, start)).length, 0);
    assert.equal((await store.listTakeaways(other.id, start)).length, 1);
    assert.ok((await store.listSeries()).some((s) => s.id === other.id));
  });
});

describe("review by Bee button", () => {
  it("'That was Acme' moves an unnamed marked session out of Other", async () => {
    await store.putSeries(other);
    const day = "2026-10-21";
    await run(t("12:00", day), [talk(930, t("11:01", day), t("11:40", day))], [
      note("r1", t("11:00", day), "Marty, Start session"),
      note("r2", t("11:41", day), "Marty, End session"),
    ]);
    assert.equal((await store.listReviewItems()).length, 1);
    await run(t("12:15", day), [talk(930, t("11:01", day), t("11:40", day))], [note("r3", t("12:05", day), "Marty, That was Acme.")]);
    assert.equal(await store.getLatestSession(other.id), null);
    assert.equal((await store.getLatestSession(acme.id))?.tag?.status, "confirmed");
    assert.deepEqual(await store.listReviewItems(), []);
    // The markers now name Acme, so later runs keep it there.
    await run(t("12:30", day), [talk(930, t("11:01", day), t("11:40", day))]);
    assert.equal(await store.getLatestSession(other.id), null);
    assert.match((await prepBrief(store, acme, at(t("12:30", day)))).fromBee!, /1 session retagged/);
  });

  it("'Not a session' drops the session that just happened", async () => {
    const day = "2026-10-20";
    await run(t("18:30", day), [talk(940, t("17:02", day), t("17:55", day))]);
    await run(t("18:45", day), [talk(940, t("17:02", day), t("17:55", day))], [note("x1", t("18:40", day), "Marty, Not a session")]);
    assert.equal(await store.getLatestSession(therapy.id), null);
  });
});

describe("reviewLine", () => {
  const item = (dropsAt: string): ReviewItem => ({
    seriesId: "coaching",
    start: "",
    end: "",
    conversationIds: [],
    source: "schedule",
    reason: "",
    filed: false,
    dropsAt,
  });
  it("adds the deadline when it's close", () => {
    const now = at("2026-10-22T12:00:00Z");
    assert.equal(reviewLine([item("2026-10-25T11:00:00Z"), item("2026-11-01T00:00:00Z")], now), "2 sessions to review; the oldest expires in 3 days.");
    assert.equal(reviewLine([item("2026-11-01T00:00:00Z")], now), "1 session to review.");
    assert.equal(reviewLine([], now), null);
  });
});
