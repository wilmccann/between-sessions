import assert from "node:assert/strict";
import { it } from "node:test";
import { fakeBee } from "./fixtures/index.js";

process.env.BEE_BIN = fakeBee;
const { collectSnapshot } = await import("../src/sessions.js");

it("pages through the CLI until items are older than the lookback", async () => {
  const now = Date.parse("2026-10-28T12:00:00-07:00"); // 21 days back is Oct 7
  const snapshot = await collectSnapshot(now);
  assert.equal(snapshot.collectedAt, new Date(now).toISOString());
  assert.deepEqual(
    snapshot.conversations.map((c) => c.id),
    [1004, 1003, 1002, 1005, 1001],
  );
  assert.equal(snapshot.insights.length, 6);
});
