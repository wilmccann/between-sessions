import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { chooseSeries } from "../src/mcp/tool.js";
import { prepBrief } from "../src/mcp/views.js";
import { matchSeriesName, newSeries, otherSeries, parseSeries } from "../src/series.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import type { SessionInput } from "../src/store/types.js";
import { nextSession } from "../src/time.js";
import { acme, coaching, globex, meetingTypes, NOW, other, therapy } from "./fixtures/meeting-types.js";

describe("series config", () => {
  it("makes the schedule optional and fills defaults", () => {
    assert.equal(acme.weekday, undefined);
    assert.deepEqual(acme.spokenNames, []);
    assert.equal(acme.maxSessionMinutes, 120);
    const [noZone] = parseSeries(JSON.stringify([{ id: "x", name: "X" }]));
    assert.ok(noZone.timezone.length > 0);
  });

  it("rejects half a schedule", () => {
    assert.throws(() => parseSeries(JSON.stringify([{ id: "x", name: "X", weekday: 2 }])));
  });

  it("creates new unscheduled series with a unique id and the usual timezone", () => {
    const s = newSeries("Acme interview", meetingTypes);
    assert.equal(s.id, "acme-interview-2");
    assert.equal(s.timezone, "America/New_York");
    assert.equal(s.weekday, undefined);
    assert.equal(newSeries("Initech screen", meetingTypes).id, "initech-screen");
    assert.equal(otherSeries([therapy]).id, "other");
  });
});

describe("matchSeriesName", () => {
  const match = (name: string) => {
    const m = matchSeriesName(meetingTypes, name);
    return m.kind === "match" ? m.series.id : m.kind === "ambiguous" ? m.candidates.map((s) => s.id) : null;
  };

  it("matches ids, names and spoken names exactly", () => {
    assert.equal(match("therapy"), "therapy");
    assert.equal(match("Weekly Therapy"), "therapy");
    assert.equal(match("acme-interview"), "acme-interview");
  });

  it("forgives transcription slips and plurals", () => {
    assert.equal(match("Akme interview"), "acme-interview");
    assert.equal(match("acme"), "acme-interview");
    assert.equal(match("Acme interviews"), "acme-interview");
    assert.equal(match("coaching session"), "coaching");
    assert.equal(match("my therapy session"), "therapy");
  });

  it("says when a name fits more than one series", () => {
    assert.deepEqual(match("interview"), ["acme-interview", "globex-interview"]);
  });

  it("finds nothing for a new name", () => {
    assert.equal(match("dentist"), null);
    assert.equal(match("Initech interview"), null);
  });
});

describe("nextSession", () => {
  it("computes the next weekly slot in the series timezone", () => {
    const next = nextSession(therapy, NOW);
    assert.equal(next?.start, Date.parse("2026-10-27T17:00:00-04:00"));
    assert.equal(next?.end, Date.parse("2026-10-27T18:00:00-04:00"));
  });

  it("returns today's slot until it ends", () => {
    assert.equal(nextSession(coaching, NOW)?.start, Date.parse("2026-10-22T16:00:00-04:00"));
    const during = Date.parse("2026-10-22T16:30:00-04:00");
    assert.equal(nextSession(coaching, during)?.start, Date.parse("2026-10-22T16:00:00-04:00"));
    const after = Date.parse("2026-10-22T17:00:00-04:00");
    assert.equal(nextSession(coaching, after)?.start, Date.parse("2026-10-29T16:00:00-04:00"));
  });

  it("crosses the end of DST", () => {
    const fri = Date.parse("2026-10-30T12:00:00-04:00");
    assert.equal(nextSession(therapy, fri)?.start, Date.parse("2026-11-03T17:00:00-05:00"));
  });

  it("is null without a schedule", () => {
    assert.equal(nextSession(acme, NOW), null);
    assert.equal(nextSession(other, NOW), null);
  });
});

const session = (start: string, end: string): SessionInput => ({
  start: new Date(start).toISOString(),
  end: new Date(end).toISOString(),
  parts: [{ id: 1, start, end, shortSummary: "Synthetic", summary: "Synthetic." }],
  insights: [],
});

describe("chooseSeries", () => {
  let store: TableStore;
  beforeEach(async () => {
    store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-series-")), "store.json"));
    for (const s of meetingTypes) await store.putSeries(s);
  });
  const chosen = async (wanted: string | undefined, purpose: "recent" | "next") => {
    const c = await chooseSeries(store, wanted, purpose, NOW);
    return c.series ? { id: c.series.id, why: c.why } : { failure: (c.failure.content[0] as { text: string }).text };
  };

  it("uses a named series, fuzzy-matched, without explaining", async () => {
    assert.deepEqual(await chosen("Akme", "recent"), { id: "acme-interview", why: null });
  });

  it("asks when a name is ambiguous or unknown", async () => {
    assert.match((await chosen("interview", "recent")).failure!, /Did you mean Acme interview or Globex interview\?/);
    assert.match((await chosen("dentist", "next")).failure!, /don't know a series called dentist/);
  });

  it("preps for the next scheduled session and says so", async () => {
    const c = await chosen(undefined, "next");
    assert.equal(c.id, "coaching");
    assert.match(c.why!, /^Using Coaching, your next scheduled session/);
  });

  it("files on the most recently ended session and says so", async () => {
    await store.putSessionVersion(therapy.id, session("2026-10-20T17:00:00-04:00", "2026-10-20T18:00:00-04:00"));
    await store.putSessionVersion(acme.id, session("2026-10-21T10:00:00-04:00", "2026-10-21T11:00:00-04:00"));
    await store.putSessionVersion(globex.id, session("2026-10-21T08:00:00-04:00", "2026-10-21T09:00:00-04:00"));
    assert.deepEqual(await chosen(undefined, "recent"), {
      id: "acme-interview",
      why: "Using Acme interview, your most recent session.",
    });
  });

  it("asks when nothing points at a series", async () => {
    const bare = fileStore(join(await mkdtemp(join(tmpdir(), "bs-series-")), "store.json"));
    await bare.putSeries(acme);
    await bare.putSeries(globex);
    const c = await chooseSeries(bare, undefined, "next", NOW);
    assert.match((c.failure!.content[0] as { text: string }).text, /^Which series\?/);
  });

  it("never preps for Other unless it is the only series", async () => {
    const bare = fileStore(join(await mkdtemp(join(tmpdir(), "bs-series-")), "store.json"));
    await bare.putSeries(acme);
    await bare.putSeries(other);
    await bare.putSessionVersion(other.id, session("2026-10-21T10:00:00-04:00", "2026-10-21T11:00:00-04:00"));
    assert.equal((await chooseSeries(bare, undefined, "next", NOW)).series?.id, "acme-interview");
    assert.equal((await chooseSeries(bare, undefined, "recent", NOW)).series?.id, "other");
  });
});

describe("prep brief next session", () => {
  it("shows the next slot, or not scheduled", async () => {
    const store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-series-")), "store.json"));
    const t = await prepBrief(store, therapy, NOW);
    assert.equal(t.nextSessionAt, "2026-10-27T21:00:00.000Z");
    assert.match(t.nextSession, /Tue, Oct 27, 5:00\s?PM/);
    const a = await prepBrief(store, acme, NOW);
    assert.equal(a.nextSession, "not scheduled");
    assert.equal(a.nextSessionAt, null);
  });
});
