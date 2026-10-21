// Collector: reads recent conversations and insights through the Bee CLI and
// saves a local snapshot that the MCP tools read.
import { writeSnapshot } from "../src/local/snapshot-store.js";
import { collectSnapshot } from "../src/sessions.js";

const started = Date.now();
const snapshot = await collectSnapshot();
const path = await writeSnapshot(snapshot);
console.log(
  `Saved ${snapshot.conversations.length} conversations and ${snapshot.insights.length} insights to ${path} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
