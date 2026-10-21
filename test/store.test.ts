import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { recordSnapshot } from "../src/collector.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import { conversations, insights, series } from "./fixtures/index.js";

const snapshot = (collectedAt: string, convs = conversations, ins = insights) => ({
  collectedAt,
  conversations: convs,
  insights: ins,
});

let store: TableStore;
let path: string;
beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), "bs-store-")), "store.json");
  store = fileStore(path);
  await store.putSeries(series);
});

describe("file store", () => {
  it("writes the file readable only by the owner", async () => {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it("round-trips series config", async () => {
    assert.deepEqual(await store.getSeries(series.id), series);
    assert.deepEqual(await store.listSeries(), [series]);
    assert.equal(await store.getSeries("missing"), null);
  });
});

describe("session versions", () => {
  it("stores matched sessions only and points LATEST at the newest", async () => {
    const run = await recordSnapshot(store, [series], snapshot("2026-10-22T12:00:00.000Z"));
    assert.equal(run.matched, 2);
    assert.equal(run.written.length, 2);
    const latest = await store.getLatestSession(series.id);
    assert.equal(latest?.start, "2026-10-21T00:00:00.000Z");
    assert.deepEqual(latest?.parts.map((p) => p.id), [1002, 1003]);
    assert.deepEqual(latest?.insights.map((i) => i.id), [2002, 2003, 2004]);
    assert.equal(latest?.versions, 1);
    const raw = await readFile(path, "utf8");
    assert.ok(!raw.includes("Book club") && !raw.includes("Grocery list") && !raw.includes("Quick reschedule"));
  });

  it("skips unchanged content and keeps rewrites as new versions", async () => {
    await recordSnapshot(store, [series], snapshot("2026-10-22T12:00:00.000Z"));
    const again = await recordSnapshot(store, [series], snapshot("2026-10-22T12:15:00.000Z"));
    assert.equal(again.written.length, 0);

    const rewritten = conversations.map((c) => (c.id === 1003 ? { ...c, summary: "Bee rewrote this summary." } : c));
    const third = await recordSnapshot(store, [series], snapshot("2026-10-22T12:30:00.000Z", rewritten));
    assert.equal(third.written.length, 1);

    const latest = await store.getLatestSession(series.id);
    assert.equal(latest?.versions, 2);
    assert.equal(latest?.collectedAt, "2026-10-22T12:30:00.000Z");
    assert.equal(latest?.parts[1].summary, "Bee rewrote this summary.");

    const sessions = await store.listSessions(series.id, 10);
    assert.deepEqual(sessions.map((s) => [s.start, s.versions]), [
      ["2026-10-21T00:00:00.000Z", 2],
      ["2026-10-14T00:02:00.000Z", 1],
    ]);
    assert.equal((await store.listSessions(series.id, 1)).length, 1);
  });

  it("adds a version when the first insight batch arrives", async () => {
    await recordSnapshot(store, [series], snapshot("2026-10-20T18:15:00.000Z", conversations, []));
    const run = await recordSnapshot(store, [series], snapshot("2026-10-22T12:00:00.000Z"));
    assert.equal(run.written.length, 2);
    assert.equal((await store.getLatestSession(series.id))?.insights.length, 3);
  });

  it("does not move LATEST back when an older session is rewritten", async () => {
    await recordSnapshot(store, [series], snapshot("2026-10-22T12:00:00.000Z"));
    const rewritten = conversations.map((c) => (c.id === 1001 ? { ...c, summary: "Older rewrite." } : c));
    await recordSnapshot(store, [series], snapshot("2026-10-22T12:30:00.000Z", rewritten));
    assert.equal((await store.getLatestSession(series.id))?.start, "2026-10-21T00:00:00.000Z");
  });
});

describe("agenda, takeaways and briefs", () => {
  it("lists agenda items oldest first", async () => {
    await store.addAgendaItem(series.id, "Ask about the offsite");
    await store.addAgendaItem(series.id, "Review the delegation list");
    assert.deepEqual((await store.listAgenda(series.id)).map((a) => a.text), [
      "Ask about the offsite",
      "Review the delegation list",
    ]);
  });

  it("files takeaways under their session", async () => {
    await store.saveTakeaway(series.id, "2026-10-21T00:00:00.000Z", "Delegate earlier");
    await store.saveTakeaway(series.id, "2026-10-14T00:02:00.000Z", "Use the short script");
    assert.equal((await store.listTakeaways(series.id)).length, 2);
    assert.deepEqual((await store.listTakeaways(series.id, "2026-10-21T00:00:00.000Z")).map((t) => t.text), [
      "Delegate earlier",
    ]);
  });

  it("round-trips a prep brief", async () => {
    const brief = {
      seriesId: series.id,
      sessionStart: "2026-10-21T00:00:00.000Z",
      note: "You talked about the offsite.",
      bullets: ["How did delegating go?"],
      relevantInsightIds: [2002],
      model: "test",
      generatedAt: "2026-10-21T12:00:00.000Z",
    };
    await store.putPrepBrief(brief);
    assert.deepEqual(await store.getPrepBrief(series.id, brief.sessionStart), brief);
    assert.equal(await store.getPrepBrief(series.id, "2026-10-14T00:02:00.000Z"), null);
  });
});
