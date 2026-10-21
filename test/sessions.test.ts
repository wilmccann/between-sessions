import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { insightsAfter, matchSessions, sessionInput } from "../src/sessions.js";
import { at, conversation, conversations, insight, insights, series } from "./fixtures/index.js";

const ids = (items: { id: number }[]) => items.map((i) => i.id);

describe("matchSessions", () => {
  const sessions = matchSessions(conversations, series);

  it("finds the sessions newest first", () => {
    assert.equal(sessions.length, 2);
    assert.ok(sessions[0].start > sessions[1].start);
  });

  it("keeps a one-part session", () => {
    assert.deepEqual(ids(sessions[1].parts), [1001]);
    assert.equal(sessions[1].start, at("2026-10-13T17:02:00-07:00"));
    assert.equal(sessions[1].end, at("2026-10-13T17:55:00-07:00"));
  });

  it("merges split parts in order and spans them all", () => {
    assert.deepEqual(ids(sessions[0].parts), [1002, 1003]);
    assert.equal(sessions[0].start, at("2026-10-20T17:00:00-07:00"));
    assert.equal(sessions[0].end, at("2026-10-20T17:58:00-07:00"));
  });

  it("drops a conversation under minOverlapMinutes", () => {
    assert.ok(!sessions.some((s) => ids(s.parts).includes(1004)));
  });

  it("ignores the wrong weekday", () => {
    assert.ok(!sessions.some((s) => ids(s.parts).includes(1005)));
  });

  it("drops a day whose total overlap is under minDurationMinutes", () => {
    assert.ok(!sessions.some((s) => ids(s.parts).includes(1006)));
  });

  it("uses local time across DST changes", () => {
    const dst = [
      conversation(1, "2026-03-10T17:05:00-07:00", "2026-03-10T17:50:00-07:00"), // PDT, Wednesday in UTC
      conversation(2, "2026-11-03T17:05:00-08:00", "2026-11-03T17:50:00-08:00"), // PST, Wednesday in UTC
      conversation(3, "2026-11-03T16:05:00-08:00", "2026-11-03T16:50:00-08:00"), // 17:05 at a fixed -07:00
    ];
    assert.deepEqual(
      matchSessions(dst, series).map((s) => ids(s.parts)),
      [[2], [1]],
    );
  });
});

describe("insightsAfter", () => {
  const [latest, earlier] = matchSessions(conversations, series);

  it("keeps only the first batch after the session", () => {
    assert.deepEqual(ids(insightsAfter(latest, insights, 72)), [2002, 2003, 2004]);
    assert.deepEqual(ids(insightsAfter(earlier, insights, 72)), [2001]);
  });

  it("returns nothing when no batch arrives within the window", () => {
    assert.deepEqual(insightsAfter(latest, insights, 6), []);
    assert.deepEqual(insightsAfter(latest, [insight(1, "2026-10-20T17:30:00-07:00")], 72), []);
  });
});

describe("sessionInput", () => {
  it("keeps the parts' summaries and the first insight batch", () => {
    const [latest] = matchSessions(conversations, series);
    const input = sessionInput(latest, insights, series);
    assert.equal(input.start, "2026-10-21T00:00:00.000Z");
    assert.equal(input.end, "2026-10-21T00:58:00.000Z");
    assert.deepEqual(input.parts.map((p) => p.shortSummary), ["Offsite budget", "Delegation plan"]);
    assert.deepEqual(input.insights.map((i) => i.id), [2002, 2003, 2004]);
    assert.ok(!("utterances_count" in input.parts[0]));
  });
});
