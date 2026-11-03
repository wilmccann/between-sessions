// Writes a synthetic store for trying the local tools without a Bee device or
// AWS: four series (therapy, coaching, an interview loop, other), sessions,
// a review queue, voice notes, agenda, a takeaway and since-last-session
// digests, all made up, dated October 2026. Pair it with the fake Bee CLI for
// the Bee data tab.
//
//   yarn demo:seed                       # writes snapshots/demo-store.json
//   yarn demo:review                     # the review page on it, with the fake Bee CLI
import { rm } from "node:fs/promises";
import { fileStore } from "../src/store/file-store.js";
import { seedBeeTab, seedDemoDigests } from "../test/fixtures/review-seed.js";

const path = process.env.STORE_FILE ?? "snapshots/demo-store.json";
await rm(path, { force: true });
const store = fileStore(path);
await seedBeeTab(store);
await seedDemoDigests(store);
const series = await store.listSeries();
console.log(`Wrote ${path}: ${series.length} series, synthetic data only.`);
