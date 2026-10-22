#!/usr/bin/env node
// Stands in for the Bee CLI in tests: `fake-bee.mjs <resource> list ... --json`
// answers from the synthetic fixtures, two items per page (insights: up to
// --limit). `search --query <q> [--neural] ... --json` answers from
// search.json or neural.json.
// FAKE_BEE_DIR: read the fixtures from this directory instead.
// FAKE_BEE_ARGV: append each call's arguments, as a JSON line, to this file.
// FAKE_BEE_FAIL: print to stderr and exit with this code.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
if (process.env.FAKE_BEE_ARGV) appendFileSync(process.env.FAKE_BEE_ARGV, `${JSON.stringify(argv)}\n`);
if (process.env.FAKE_BEE_FAIL) {
  console.error("Synthetic: stderr that must not reach the page");
  process.exit(Number(process.env.FAKE_BEE_FAIL));
}
const dir = process.env.FAKE_BEE_DIR ? pathToFileURL(`${process.env.FAKE_BEE_DIR}/`) : new URL(".", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

const [resource, command, ...rest] = argv;
// `stream --json --types ...` prints the synthetic events in stream.jsonl and
// exits; asking for utterance, location or todo events is an error.
if (resource === "stream") {
  const types = process.argv[process.argv.indexOf("--types") + 1] ?? "";
  if (!process.argv.includes("--json") || /utterance|location|todo/.test(types)) {
    console.error(`Unexpected stream arguments: ${process.argv.slice(3).join(" ")}`);
    process.exit(2);
  }
  process.stdout.write(read("stream.jsonl"));
  process.exit(0);
}
// Keyword flags don't apply to --neural, as in the real CLI.
if (resource === "search") {
  const neural = argv.includes("--neural");
  if (!argv.includes("--json") || option("--query") === undefined || (neural && ["--filter", "--sort", "--scope"].some((f) => argv.includes(f)))) {
    console.error("Unexpected search arguments");
    process.exit(2);
  }
  process.stdout.write(read(neural ? "neural.json" : "search.json"));
  process.exit(0);
}
if (command !== "list" || !rest.includes("--json")) {
  console.error(`Unknown ${resource} subcommand: ${command}`);
  process.exit(1);
}
const all = JSON.parse(read(`${resource}.json`))[resource];
const offset = Number(option("--cursor") ?? 0);
const size = resource === "insights" && option("--limit") ? Number(option("--limit")) : 2;
const page = all.slice(offset, offset + size);
const next = offset + size < all.length ? String(offset + size) : null;
console.log(JSON.stringify({ [resource]: page, next_cursor: next }));
