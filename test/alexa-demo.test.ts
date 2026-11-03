import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const demo = (storeFile: string, ...args: string[]) =>
  run(process.execPath, ["--import", "tsx", "scripts/alexa-demo.ts", ...args], { env: { ...process.env, STORE_FILE: storeFile } });

describe("demo:alexa", () => {
  it("seeds a missing store, prints a full and a discreet conversation, and leaves the store unchanged", async () => {
    const storeFile = join(await mkdtemp(join(tmpdir(), "bs-alexa-demo-")), "demo-store.json");
    const full = await demo(storeFile);
    assert.ok(existsSync(storeFile));
    const before = await readFile(storeFile, "utf8");
    assert.match(full.stdout, /^You: Alexa, open Between Sessions$/m);
    assert.match(full.stdout, /^Alexa: Added to Coaching: the work trip\. .* \(2 sentences\)$/m);
    assert.match(full.stdout, /^Alexa: Removed from Coaching: the work trip\./m);
    assert.match(full.stdout, /^Alexa: Saved for Coaching: delegate earlier\./m);
    for (const [, n] of full.stdout.matchAll(/\((\d+) sentences?\)$/gm)) assert.ok(Number(n) <= 3);

    const discreet = await demo(storeFile, "--discreet");
    assert.match(discreet.stdout, /discreet answers/);
    assert.match(discreet.stdout, /^Alexa: Added to your agenda\./m);
    assert.match(discreet.stdout, /^Alexa: You have 2 items on your agenda\./m);
    const alexaLines = discreet.stdout.split("\n").filter((l) => l.startsWith("Alexa: "));
    for (const l of alexaLines) assert.ok(!/coaching|therapy|work trip|Synthetic short/i.test(l), l);
    // The demo talks to a copy; the store and its series are unchanged.
    assert.equal(await readFile(storeFile, "utf8"), before);
    assert.ok(!before.includes('"discreet"'));
  });
});
