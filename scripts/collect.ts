// Collector: reads recent conversations and insights through the Bee CLI,
// matches them to your series, and stores the sessions in the local file store
// (git-ignored) that the MCP tools read.
import { recordSnapshot } from "../src/collector.js";
import { loadSeries } from "../src/series.js";
import { collectSnapshot } from "../src/sessions.js";
import { fileStore } from "../src/store/file-store.js";

const started = Date.now();
const store = fileStore();
const series = loadSeries();
for (const s of series) await store.putSeries(s);
const snapshot = await collectSnapshot();
const result = await recordSnapshot(store, series, snapshot);
console.log(
  `Read ${snapshot.conversations.length} conversations and ${snapshot.insights.length} insights; ` +
    `matched ${result.matched} sessions in ${result.series} series; ` +
    `stored ${result.written.length} new versions in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
const b = result.button;
console.log(
  `Bee button: ${b.notes} new notes, ${b.markers} markers, ${b.filed} filed, ${b.unfiled} unfiled, ` +
    `${b.waiting} waiting, ${b.seriesCreated} series created; ${result.review} to review; ${result.digests} digests`,
);
