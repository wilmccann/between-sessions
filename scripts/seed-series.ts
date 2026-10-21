// Writes series config (the schedule rules) into the store, local file or
// DynamoDB. Prints counts only, since your schedule is personal.
//
//   yarn seed --file series.local.json --store file
//   yarn seed --file series.local.json --store dynamo   # TABLE_NAME, default between-sessions
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseSeries } from "../src/series.js";
import { dynamoStore } from "../src/store/dynamo-store.js";
import { fileStore } from "../src/store/file-store.js";

const { values } = parseArgs({
  options: {
    file: { type: "string", default: "series.local.json" },
    store: { type: "string", default: "file" },
  },
});

if (values.store !== "file" && values.store !== "dynamo") {
  console.error("--store must be file or dynamo");
  process.exit(1);
}

const series = parseSeries(readFileSync(values.file, "utf8"));
const store = values.store === "dynamo" ? dynamoStore() : fileStore();
for (const s of series) await store.putSeries(s);
const stored = await store.listSeries();
console.log(`Seeded ${series.length} series into the ${values.store} store (${stored.length} in the store now).`);
