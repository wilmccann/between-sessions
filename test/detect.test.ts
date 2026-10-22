import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { recordSnapshot } from "../src/collector.js";
import { placeSessions, windowCandidates, type Candidate } from "../src/detect.js";
import { matchSessions, sessionInput } from "../src/sessions.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import type { Claim } from "../src/store/types.js";
import { at, conversation } from "./fixtures/index.js";
import { acme, coaching, therapy } from "./fixtures/meeting-types.js";

// Synthetic week around Tue Oct 20, 2026 (New York, EDT). Therapy is
// Tue 17:00 to 18:00.
const early = conversation(11, "2026-10-20T17:02:00-04:00", "2026-10-20T17:20:00-04:00");
const late = conversation(12, "2026-10-20T17:22:00-04:00", "2026-10-20T17:58:00-04:00");
const lunch = conversation(13, "2026-10-20T12:00:00-04:00", "2026-10-20T13:30:00-04:00");
const ids = (p: { candidate: Candidate }) => p.candidate.session.parts.map((x) => x.id);

const claim = (id: number, over: Partial<Claim>): Claim => ({
  conversationId: id,
  seriesId: therapy.id,
  sessionStart: new Date(early.start_time).toISOString(),
  source: "schedule",
  status: "auto",
  ...over,
});

const marked = (seriesId: string, parts = [early, late]): Candidate => ({
  seriesId,
  session: { parts, start: parts[0].start_time, end: parts.at(-1)!.end_time },
  span: { from: parts[0].start_time, to: parts.at(-1)!.end_time },
  minDurationMinutes: 0,
  tag: { source: "marker", confidence: "certain", status: "auto", reason: "Start and end markers" },
});

describe("window sessions are spans", () => {
  it("takes only the window's conversations, not the whole day", () => {
    const [s] = matchSessions([lunch, early, late], therapy);
    assert.deepEqual(s.parts.map((p) => p.id), [11, 12]);
    assert.equal(s.start, early.start_time);
  });

  it("tags each window session with its slot", () => {
    const [c] = windowCandidates([early, late], therapy);
    assert.deepEqual(c.tag, { source: "schedule", confidence: "high", status: "auto", reason: "Tue 17:00 to 18:00 slot" });
  });

  it("finds nothing for a series without a schedule", () => {
    assert.deepEqual(windowCandidates([early, late], acme), []);
  });
});

describe("placeSessions", () => {
  const window = () => windowCandidates([early, late], therapy);

  it("lets a marker take a conversation from a window in the same run", () => {
    const placed = placeSessions([...window(), marked(acme.id)], new Map());
    assert.equal(placed.length, 1);
    assert.equal(placed[0].candidate.seriesId, acme.id);
  });

  it("keeps a marked conversation out of another series' window", () => {
    const stored = new Map([
      [11, claim(11, { seriesId: acme.id, source: "marker" })],
      [12, claim(12, { seriesId: acme.id, source: "marker" })],
    ]);
    assert.deepEqual(placeSessions(window(), stored), []);
  });

  it("never re-files a rejected conversation from the schedule", () => {
    const stored = new Map([[12, claim(12, { seriesId: "", sessionStart: "", status: "rejected" })]]);
    const placed = placeSessions(window(), stored);
    assert.deepEqual(placed.map(ids), []); // what's left is under minDurationMinutes
  });

  it("replaces a stored window session when a marker claims its conversations", () => {
    const stored = new Map([[11, claim(11, {})], [12, claim(12, {})]]);
    const [p] = placeSessions([marked(coaching.id)], stored);
    assert.deepEqual(p.replaces, [{ seriesId: therapy.id, start: new Date(early.start_time).toISOString() }]);
  });

  it("does not let the schedule take over a confirmed session", () => {
    const stored = new Map([[11, claim(11, { seriesId: coaching.id, status: "confirmed" })]]);
    const placed = placeSessions(window(), stored);
    assert.ok(placed.every((p) => !ids(p).includes(11)));
  });

  it("keeps two marked sessions on one day apart", () => {
    const a = conversation(21, "2026-10-21T10:00:00-04:00", "2026-10-21T10:45:00-04:00");
    const b = conversation(22, "2026-10-21T14:00:00-04:00", "2026-10-21T14:50:00-04:00");
    const placed = placeSessions([marked(acme.id, [a]), marked(acme.id, [b])], new Map());
    assert.deepEqual(placed.map(ids), [[21], [22]]);
  });
});

describe("stored session identity", () => {
  let store: TableStore;
  beforeEach(async () => {
    store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-detect-")), "store.json"));
    for (const s of [therapy, coaching, acme]) await store.putSeries(s);
  });
  const snapshot = (collectedAt: string, conversations = [early, late]) => ({ collectedAt, conversations, insights: [] });

  it("stores the tag and claims each conversation", async () => {
    await recordSnapshot(store, [therapy], snapshot("2026-10-20T22:15:00.000Z"));
    const latest = await store.getLatestSession(therapy.id);
    assert.equal(latest?.tag?.source, "schedule");
    const claims = await store.listClaims();
    assert.deepEqual([...claims.keys()].sort(), [11, 12]);
    assert.equal(claims.get(12)?.sessionStart, latest?.start);
  });

  it("replaces its earlier self when Bee adds a part, and moves the takeaway", async () => {
    await recordSnapshot(store, [therapy], snapshot("2026-10-20T22:15:00.000Z", [late]));
    const first = await store.getLatestSession(therapy.id);
    assert.equal(first?.start, new Date(late.start_time).toISOString());
    await store.saveTakeaway(therapy.id, first!.start, "Synthetic takeaway");

    const run = await recordSnapshot(store, [therapy], snapshot("2026-10-20T22:30:00.000Z"));
    assert.equal(run.replaced, 1);
    const sessions = await store.listSessions(therapy.id, 10);
    assert.deepEqual(sessions.map((s) => s.start), [new Date(early.start_time).toISOString()]);
    assert.deepEqual((await store.listTakeaways(therapy.id, sessions[0].start)).map((t) => t.text), ["Synthetic takeaway"]);
    assert.equal((await store.listTakeaways(therapy.id)).length, 1);
  });

  it("moves a window session's takeaway to the marked session that replaces it", async () => {
    await recordSnapshot(store, [therapy], snapshot("2026-10-20T22:15:00.000Z"));
    const start = new Date(early.start_time).toISOString();
    await store.saveTakeaway(therapy.id, start, "Synthetic takeaway");

    const [p] = placeSessions([marked(coaching.id)], await store.listClaims());
    await store.recordSession(coaching.id, sessionInput(p.candidate.session, [], coaching, p.candidate.tag), "2026-10-20T22:30:00.000Z", p.replaces);

    assert.equal(await store.getLatestSession(therapy.id), null);
    assert.equal((await store.listTakeaways(therapy.id)).length, 0);
    assert.deepEqual((await store.listTakeaways(coaching.id, start)).map((t) => t.text), ["Synthetic takeaway"]);
    assert.equal((await store.listClaims()).get(11)?.seriesId, coaching.id);

    // The next schedule run doesn't bring the therapy session back.
    await recordSnapshot(store, [therapy, coaching], snapshot("2026-10-20T22:45:00.000Z"));
    assert.equal(await store.getLatestSession(therapy.id), null);
  });

  it("updates the tag in place when only the tag changes", async () => {
    await recordSnapshot(store, [therapy], snapshot("2026-10-20T22:15:00.000Z"));
    const v = (await store.getLatestSession(therapy.id))!;
    const { written } = await store.recordSession(therapy.id, { ...v, tag: { ...v.tag!, status: "confirmed" } }, "2026-10-21T00:00:00.000Z");
    assert.equal(written, false);
    const after = (await store.getLatestSession(therapy.id))!;
    assert.equal(after.tag?.status, "confirmed");
    assert.equal(after.versions, 1);
    assert.equal(at(after.collectedAt), at(v.collectedAt));
  });
});
