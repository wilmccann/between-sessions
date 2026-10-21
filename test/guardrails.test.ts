import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeHandler, targets, type KillDeps } from "../src/aws/kill-switch.js";

const NAMES = [
  "between-sessions-mcp",
  "between-sessions-collector",
  "other-site-contact-handler",
  "cost-guardrails-kill-switch",
];

function fakeDeps(failOn?: string) {
  const throttled: string[] = [];
  const notes: { subject: string; message: string }[] = [];
  const deps: KillDeps = {
    listFunctions: async () => NAMES,
    throttle: async (name) => {
      if (name === failOn) throw new Error("synthetic failure");
      throttled.push(name);
    },
    notify: async (subject, message) => {
      notes.push({ subject, message });
    },
  };
  return { deps, throttled, notes };
}

describe("kill switch targets", () => {
  it("matches only registered prefixes, sorted", () => {
    assert.deepEqual(targets(NAMES, ["between-sessions-"]), ["between-sessions-collector", "between-sessions-mcp"]);
  });

  it("never targets itself", () => {
    assert.deepEqual(targets(NAMES, ["cost-"], "cost-guardrails-kill-switch"), []);
  });

  it("ignores empty or too-short prefixes instead of matching everything", () => {
    assert.deepEqual(targets(NAMES, ["", " ", "b"]), []);
  });
});

describe("kill switch handler", () => {
  it("dry run lists targets and changes nothing", async () => {
    const { deps, throttled, notes } = fakeDeps();
    const res = await makeHandler(deps, ["between-sessions-"])({ dryRun: true });
    assert.deepEqual(res, { dryRun: true, functions: ["between-sessions-collector", "between-sessions-mcp"] });
    assert.deepEqual(throttled, []);
    assert.equal(notes.length, 0);
  });

  it("throttles every target and emails what changed", async () => {
    const { deps, throttled, notes } = fakeDeps();
    const event = { Records: [{ Sns: { Subject: "AWS Budgets: account-daily has exceeded your alert threshold" } }] };
    await makeHandler(deps, ["between-sessions-"])(event);
    assert.deepEqual(throttled, ["between-sessions-collector", "between-sessions-mcp"]);
    assert.equal(notes.length, 1);
    assert.match(notes[0].message, /account-daily/);
    assert.match(notes[0].message, /guardrails:restore/);
  });

  it("keeps going past a failure, reports it, then fails the invocation", async () => {
    const { deps, throttled, notes } = fakeDeps("between-sessions-collector");
    await assert.rejects(makeHandler(deps, ["between-sessions-"])({}), /between-sessions-collector/);
    assert.deepEqual(throttled, ["between-sessions-mcp"]);
    assert.match(notes[0].message, /Failed: between-sessions-collector/);
  });
});
