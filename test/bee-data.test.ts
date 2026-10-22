import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BeeData } from "../src/local/bee-data.js";
import { newToken } from "../src/local/review-ui.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import { beeTabData, writeBeeTabData } from "./fixtures/bee-tab.js";
import { fakeBee } from "./fixtures/index.js";
import { argvLines, call, seedBeeTab, startServer } from "./fixtures/review-seed.js";

process.env.BEE_BIN = fakeBee;

let store: TableStore;
let server: Server;
let port: number;
let argvFile: string;
let fixtureDir: string;
const token = newToken();

beforeEach(async () => {
  store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-bee-data-")), "store.json"));
  await seedBeeTab(store);
  ({ dir: fixtureDir, argvFile } = await writeBeeTabData());
  process.env.FAKE_BEE_DIR = fixtureDir;
  process.env.FAKE_BEE_ARGV = argvFile;
  delete process.env.FAKE_BEE_FAIL;
  ({ server, port } = await startServer(store, token));
});
afterEach(async () => {
  server.close();
  await rm(fixtureDir, { recursive: true, force: true });
});

const getBee = async (query = "") => {
  const res = await call(port, `/api/bee${query}`, { token });
  assert.equal(res.status, 200, res.body);
  return res;
};
type Row = { key: string; type: string; id: string; marty: string | null; start: string | null; end: string | null; lookups: { label: string; command: string }[] };
const byKey = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.key, r]));

describe("Bee data: reading", () => {
  it("pages journals and conversations until items are older than the window", async () => {
    const { rows, days, cutShort } = (await getBee()).json();
    assert.equal(days, 14);
    assert.deepEqual(cutShort, { journals: false, conversations: false, insights: false });
    const keys = rows.map((r: Row) => r.key);
    for (const old of ["journal:jrnl-synthetic-old", "journal:jrnl-synthetic-older", "conversation:900999", "conversation:900998", "insight:2103"]) {
      assert.ok(!keys.includes(old), old);
    }
    assert.equal(keys.filter((k: string) => k.startsWith("journal:")).length, 5);
    assert.equal(keys.filter((k: string) => k.startsWith("conversation:")).length, 6);
    assert.deepEqual(keys.filter((k: string) => k.startsWith("insight:")), ["insight:2101", "insight:2102"]);
    // Two per page: journals stop on the third page, conversations on the fourth.
    const calls = await argvLines(argvFile);
    assert.deepEqual(
      calls.map((a) => a.slice(0, 2).join(" ")),
      ["journals list", "journals list", "journals list", "conversations list", "conversations list", "conversations list", "conversations list", "insights list"],
    );
    assert.deepEqual(calls[1], ["journals", "list", "--limit", "100", "--cursor", "2", "--json"]);
    assert.deepEqual(calls.at(-1), ["insights", "list", "--limit", "200", "--json"]);
    // Newest first, with times, state and an open end for one in progress.
    assert.equal(rows[0].key, "journal:jrnl-synthetic-6666");
    const live = byKey(rows)["conversation:900666"];
    assert.equal(live.end, null);
    assert.match(live.start!, /^\d{4}-\d\d-\d\dT/);
  });

  it("joins each row with what Marty did with it", async () => {
    const rows = byKey((await getBee()).json().rows);
    assert.equal(rows["journal:jrnl-synthetic-6666"].marty, "start, filed, Coaching");
    assert.equal(rows["journal:jrnl-synthetic-3333"].marty, "note, ignored");
    assert.equal(rows["journal:jrnl-synthetic-5555"].marty, "retag, unfiled: I don't know a series called x");
    assert.equal(rows["journal:jrnl-synthetic-1111"].marty, "start, filed");
    assert.equal(rows["journal:jrnl-synthetic-7777"].marty, null);
    assert.equal(rows["conversation:900111"].marty, "session: Coaching, Thu, Oct 15, 4:02 PM");
    assert.equal(rows["conversation:900222"].marty, "session: Weekly therapy, Tue, Oct 20, 5:00 PM");
    assert.equal(rows["conversation:900444"].marty, "waiting for review: guess Acme interview");
    assert.equal(rows["conversation:900333"].marty, "waiting for review: filed under Other");
    assert.equal(rows["conversation:900555"].marty, "not a session");
    assert.equal(rows["conversation:900666"].marty, null);
    assert.equal(rows["insight:2101"].marty, null);
    assert.deepEqual(rows["conversation:900111"].lookups, [{ label: "bee 900111", command: "bee conversations get '900111' --json" }]);
    assert.deepEqual(rows["insight:2101"].lookups, [{ label: "bee", command: "bee insights get '2101' --json" }]);
  });

  it("gives db lookups for the related table item when it knows the table", async () => {
    const withTable = await startServer(store, token, { table: "synthetic-table" });
    try {
      const rows = byKey((await call(withTable.port, "/api/bee", { token })).json().rows);
      const db = (key: string) => rows[key].lookups.find((l) => l.label === "db")?.command;
      assert.match(db("journal:jrnl-synthetic-6666")!, /get-item .*"JOURNALS".*"J#2026-10-22T11:00:00.000Z#jrnl-synthetic-6666"/);
      assert.match(db("conversation:900111")!, /query .*"SERIES#coaching".*"SESSION#2026-10-15T20:02:00.000Z#V#"/);
      assert.match(db("conversation:900444")!, /get-item .*"REVIEW".*"R#2026-10-19T15:00:00.000Z#acme-interview"/);
      assert.match(db("conversation:900555")!, /get-item .*"CLAIMS".*"CONV#900555"/);
      assert.equal(db("conversation:900666"), undefined);
      assert.equal(db("journal:jrnl-synthetic-7777"), undefined);
    } finally {
      withTable.server.close();
    }
  });

  it("flags insights as maybe cut short when Bee gives exactly 200", async () => {
    const data = beeTabData();
    data.insights = Array.from({ length: 205 }, (_, i) => ({ ...data.insights[0], id: 5000 + i }));
    const many = await writeBeeTabData(data);
    process.env.FAKE_BEE_DIR = many.dir;
    try {
      const body = (await getBee()).json();
      assert.equal(body.cutShort.insights, true);
      assert.equal(body.rows.filter((r: Row) => r.type === "insight").length, 200);
    } finally {
      await rm(many.dir, { recursive: true, force: true });
    }
  });
});

describe("Bee data: privacy", () => {
  it("sends no text, location or link in /api/bee", async () => {
    const res = await getBee();
    assert.doesNotMatch(res.body, /Synthetic:|Fake Street|synthetic\.example|location|link/i);
    for (const row of res.json().rows) assert.equal(row.hasText, true);
  });

  it("gives exactly one row's text on request", async () => {
    await getBee();
    const text = async (q: string) => call(port, `/api/bee/text?${q}`, { token });
    const journal = await text("type=journal&id=jrnl-synthetic-3333");
    assert.equal(journal.status, 200);
    assert.deepEqual(journal.json(), { type: "journal", id: "jrnl-synthetic-3333", parts: [{ label: "note text", text: "Synthetic: a plain thought about the garden." }] });
    const conv = await text("type=conversation&id=900666");
    assert.deepEqual(conv.json().parts, [
      { label: "short summary", text: "Synthetic: short 900666" },
      { label: "summary", text: "Synthetic: long summary 900666" },
    ]);
    assert.doesNotMatch(conv.body, /Fake Street|location|900111/);
    assert.deepEqual((await text("type=insight&id=2102")).json().parts, [
      { label: "insight title", text: "Synthetic: insight title 2102" },
      { label: "insight description", text: "Synthetic: insight description 2102" },
    ]);
    assert.equal((await text("type=journal&id=jrnl-synthetic-old")).status, 404);
    assert.equal((await text("type=conversation&id=424242")).status, 404);
    assert.equal((await text("type=utterance&id=900666")).status, 400);
    assert.equal((await text("type=journal")).status, 400);
    assert.equal((await text("type=daily&id=1&source=nope")).status, 400);
  });

  it("needs the token and the right host on the new routes", async () => {
    for (const path of ["/api/bee", "/api/bee/text?type=journal&id=jrnl-synthetic-3333"]) {
      assert.equal((await call(port, path)).status, 401, path);
      assert.equal((await call(port, path, { token: "wrong" })).status, 401, path);
      assert.equal((await call(port, path, { token, host: "evil.example" })).status, 403, path);
    }
    // Refused before Bee is ever called.
    assert.deepEqual(await argvLines(argvFile), []);
  });

  it("reports a failed Bee CLI by exit code only", async () => {
    process.env.FAKE_BEE_FAIL = "3";
    const res = await call(port, "/api/bee", { token });
    assert.equal(res.status, 502);
    assert.deepEqual(res.json(), { error: "Bee CLI failed (exit 3)" });
  });

  it("rejects a bad day count", async () => {
    for (const days of ["0", "61", "1.5", "x"]) assert.equal((await call(port, `/api/bee?days=${days}`, { token })).status, 400, days);
  });
});

describe("Bee data: cache", () => {
  it("keeps one read for 60 seconds; refresh=1 reads again", async () => {
    let now = Date.now();
    const bee = new BeeData(store, { now: () => now });
    const own = await startServer(store, token, { bee });
    try {
      const count = async () => (await argvLines(argvFile)).length;
      await call(own.port, "/api/bee", { token });
      const once = await count();
      assert.equal(once, 8);
      now += 59_000;
      await call(own.port, "/api/bee", { token });
      assert.equal(await count(), once);
      // The Marty column is joined on every request, so edits show at once.
      await store.putClaims([{ conversationId: 900666, seriesId: "", sessionStart: "", source: "you", status: "rejected" }]);
      const joined = byKey((await call(own.port, "/api/bee", { token })).json().rows);
      assert.equal(joined["conversation:900666"].marty, "not a session");
      assert.equal(await count(), once);
      await call(own.port, "/api/bee?refresh=1", { token });
      assert.equal(await count(), 2 * once);
      now += 61_000;
      await call(own.port, "/api/bee", { token });
      assert.equal(await count(), 3 * once);
      // A different window reads again.
      await call(own.port, "/api/bee?days=7", { token });
      assert.equal(await count(), 4 * once);
      // Text comes from the cached read, even after it's stale.
      now += 120_000;
      assert.equal((await call(own.port, "/api/bee/text?type=journal&id=jrnl-synthetic-6666", { token })).status, 200);
      assert.equal(await count(), 4 * once);
    } finally {
      own.server.close();
    }
  });

  it("reads Bee once for text when nothing is cached yet", async () => {
    const res = await call(port, "/api/bee/text?type=journal&id=jrnl-synthetic-6666", { token });
    assert.equal(res.status, 200);
    assert.equal((await argvLines(argvFile)).length, 8);
  });
});
