#!/usr/bin/env node
// Stands in for the Bee CLI in tests: `fake-bee.mjs <resource> list ... --json`
// answers from the synthetic fixtures, two items per page.
import { readFileSync } from "node:fs";

const [resource, command, ...rest] = process.argv.slice(2);
// `stream --json --types ...` prints the synthetic events in stream.jsonl and
// exits; asking for utterance, location or todo events is an error.
if (resource === "stream") {
  const types = process.argv[process.argv.indexOf("--types") + 1] ?? "";
  if (!process.argv.includes("--json") || /utterance|location|todo/.test(types)) {
    console.error(`Unexpected stream arguments: ${process.argv.slice(3).join(" ")}`);
    process.exit(2);
  }
  process.stdout.write(readFileSync(new URL("stream.jsonl", import.meta.url), "utf8"));
  process.exit(0);
}
if (command !== "list" || !rest.includes("--json")) {
  console.error(`Unknown ${resource} subcommand: ${command}`);
  process.exit(1);
}
const all = JSON.parse(readFileSync(new URL(`${resource}.json`, import.meta.url), "utf8"))[resource];
const at = rest.indexOf("--cursor");
const offset = at === -1 ? 0 : Number(rest[at + 1]);
const page = all.slice(offset, offset + 2);
const next = offset + 2 < all.length ? String(offset + 2) : null;
console.log(JSON.stringify({ [resource]: page, next_cursor: next }));
