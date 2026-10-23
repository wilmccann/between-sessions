// Writes a synthetic store for trying the local tools without a Bee device or
// AWS: four series (therapy, coaching, an interview loop, other), sessions,
// a review queue, voice notes, agenda and a takeaway, all made up, dated
// October 2026. Pair it with the fake Bee CLI for the Bee data tab.
//
//   yarn demo:seed                       # writes snapshots/demo-store.json
//   STORE_FILE=snapshots/demo-store.json yarn review-ui --store file
import { rm } from "node:fs/promises";
import { fileStore } from "../src/store/file-store.js";
import { seedBeeTab } from "../test/fixtures/review-seed.js";

const path = process.env.STORE_FILE ?? "snapshots/demo-store.json";
await rm(path, { force: true });
const store = fileStore(path);
await seedBeeTab(store);
const series = await store.listSeries();
console.log(`Wrote ${path}: ${series.length} series, synthetic data only.`);
