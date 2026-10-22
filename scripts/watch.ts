// Voice-note watcher: `yarn watch [--collect] [--shape] [--store file]`.
// Shows each Bee voice note as it arrives, what Bee heard, and what the
// collector will do with it. Prints to this terminal only and writes nothing
// to disk. See src/watch.ts.
//   --collect     when a note turns READY, run the collector Lambda once and
//                 print its counts
//   --shape       no text at all: kinds, times and verdicts only
//   --store file  series from the local file store instead of DynamoDB
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { CollectorResult } from "../src/aws/collector.js";
import type { Series } from "../src/series.js";
import { dynamoStore } from "../src/store/dynamo-store.js";
import { fileStore } from "../src/store/file-store.js";
import { describeCollectorResult, lineHandler, oneAtATime, streamOnce, timeOf } from "../src/watch.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const storeArg = args.find((a) => a.startsWith("--store="))?.slice(8) ?? (args.includes("--store") ? args[args.indexOf("--store") + 1] : "dynamo");
const shape = flag("--shape");
const collect = flag("--collect");
const COLLECTOR = "between-sessions-collector";
const SERIES_REFRESH = 5 * 60_000;
const BACKOFF_START = 5_000;
const BACKOFF_MAX = 60_000;

const store = storeArg === "file" ? fileStore() : dynamoStore();
const log = (line: string) => console.log(line);
const now = () => timeOf(Date.now());

let series: Series[] = [];
async function loadSeries() {
  try {
    series = await store.listSeries();
  } catch (err) {
    log(`${now()} couldn't load series (${(err as Error).name}); keeping ${series.length}`);
  }
}
await loadSeries();
setInterval(() => void loadSeries(), SERIES_REFRESH).unref();

const lambda = new LambdaClient({});
const runCollector = oneAtATime(async () => {
  log(`${now()} running the collector...`);
  try {
    const res = await lambda.send(new InvokeCommand({ FunctionName: COLLECTOR }));
    const body = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString("utf8")) : {};
    if (res.FunctionError) log(`${now()} collector failed (${res.FunctionError}: ${body.errorType ?? "error"})`);
    else log(`${now()} ${describeCollectorResult(body as Partial<CollectorResult>)}`);
  } catch (err) {
    log(`${now()} couldn't run the collector (${(err as Error).name})`);
  }
});

const handle = lineHandler({
  series: () => series,
  shape,
  print: log,
  onReady: collect ? () => runCollector() : undefined,
});

const bin = process.env.BEE_BIN ?? "bee";
log(
  `Watching Bee voice notes and conversations (${series.length} series from ${storeArg === "file" ? "the file store" : "DynamoDB"}` +
    `${shape ? ", shape only" : ""}${collect ? ", collector on READY" : ""}). ` +
    "The first connection can take about 20 s (Keychain). Ctrl-C to stop.",
);

let backoff = BACKOFF_START;
for (;;) {
  const started = Date.now();
  const code = await streamOnce(bin, handle);
  // A stream that stayed up a while starts the backoff over.
  if (Date.now() - started > BACKOFF_MAX) backoff = BACKOFF_START;
  log(`${now()} stream ended (${code === null ? "couldn't start" : `exit ${code}`}); reconnecting in ${backoff / 1000} s`);
  await new Promise((r) => setTimeout(r, backoff));
  backoff = Math.min(backoff * 2, BACKOFF_MAX);
}
