import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { windowCandidates } from "../src/detect.js";
import { markerCandidates } from "../src/markers.js";
import { normalizeSeries, parseSeries } from "../src/series.js";
import { matchSessions } from "../src/sessions.js";
import { slotsBetween } from "../src/slots.js";
import { nextSession } from "../src/time.js";
import { conversation } from "./fixtures/index.js";
import { NOW, other, therapy } from "./fixtures/meeting-types.js";

// All synthetic, October and November 2026 in New York. Oct 21 is a
// Wednesday, Oct 22 a Thursday.
const [mentoring, coaching, globex] = parseSeries(
  JSON.stringify([
    {
      id: "synthetic-mentoring",
      name: "Synthetic mentoring",
      timezone: "America/New_York",
      weekday: 3,
      windowStart: "10:00",
      windowEnd: "11:00",
      dated: [
        { date: "2026-10-21", start: "10:20", end: "11:00" },
        { date: "2026-10-28", skip: true },
      ],
    },
    {
      id: "synthetic-coaching",
      name: "Synthetic coaching",
      timezone: "America/New_York",
      minDurationMinutes: 5,
      minOverlapMinutes: 5,
      dated: [
        { date: "2026-10-22", start: "20:00", end: "20:10" },
        { date: "2026-10-22", start: "18:00", end: "18:10" },
      ],
    },
    {
      id: "globex-interview",
      name: "Globex interview",
      timezone: "America/New_York",
      minDurationMinutes: 5,
      minOverlapMinutes: 5,
      dated: [
        { date: "2026-10-22", start: "19:00", end: "19:10" },
        { date: "2026-10-23", start: "19:00", end: "19:10" },
        { date: "2026-11-01", start: "18:00", end: "18:10" },
      ],
    },
  ]),
);

const ny = (date: string, time: string) => {
  const offset = date >= "2026-11-01" ? "-05:00" : "-04:00";
  return `${date}T${time}:00${offset}`;
};
const conv = (id: number, date: string, from: string, to: string) => conversation(id, ny(date, from), ny(date, to));
const ids = (items: { id: number }[]) => items.map((i) => i.id);
const reasons = (cs: { tag: { reason: string } }[]) => cs.map((c) => c.tag.reason);

describe("dated sessions: config", () => {
  it("defaults to none and keeps entries", () => {
    assert.deepEqual(therapy.dated, []);
    assert.deepEqual(mentoring.dated, [
      { date: "2026-10-21", start: "10:20", end: "11:00" },
      { date: "2026-10-28", skip: true },
    ]);
  });

  it("parses the example config's dated entries", () => {
    const example = parseSeries(readFileSync("series.example.json", "utf8"));
    assert.deepEqual(example.map((s) => s.dated.length), [1, 1]);
  });

  it("rejects bad dates and times with a clear message", () => {
    const bad = (dated: unknown[]) => () => normalizeSeries({ id: "x", name: "X", dated });
    assert.throws(bad([{ date: "2026-02-30", start: "10:00", end: "11:00" }]), /Use a real date as YYYY-MM-DD, not \\"2026-02-30\\"/);
    assert.throws(bad([{ date: "Oct 22", start: "10:00", end: "11:00" }]), /real date/);
    assert.throws(bad([{ date: "2026-10-22", start: "25:00", end: "26:00" }]), /Use a 24-hour time as HH:MM, not \\"25:00\\"/);
    assert.throws(bad([{ date: "2026-10-22", start: "18:10", end: "18:00" }]), /The end \(18:00\) must be after the start \(18:10\)/);
    assert.throws(bad([{ date: "2026-10-22", start: "18:00" }]), /needs a start and an end/);
    assert.throws(bad([{ date: "2026-10-22", skip: true, start: "18:00" }]), /skipped day has no start or end/);
    assert.throws(
      bad([{ date: "2026-10-22", skip: true }, { date: "2026-10-22", start: "18:00", end: "18:10" }]),
      /2026-10-22 has both a skip and a dated session/,
    );
  });
});

describe("dated sessions: slots", () => {
  it("lists weekly and dated slots, with dated entries replacing the weekly slot that day", () => {
    const slots = slotsBetween(mentoring, Date.parse(ny("2026-10-12", "00:00")), Date.parse(ny("2026-11-08", "00:00")));
    assert.deepEqual(
      slots.map((s) => [s.date, s.startTime, s.endTime, s.source]),
      [
        ["2026-10-14", "10:00", "11:00", "weekly"],
        ["2026-10-21", "10:20", "11:00", "dated"],
        // Oct 28 is skipped.
        ["2026-11-04", "10:00", "11:00", "weekly"],
      ],
    );
    assert.equal(slots[2].start, Date.parse("2026-11-04T10:00:00-05:00"));
  });

  it("lists several dated slots on one day, earliest first", () => {
    const slots = slotsBetween(coaching, Date.parse(ny("2026-10-22", "00:00")), Date.parse(ny("2026-10-23", "00:00")));
    assert.deepEqual(slots.map((s) => [s.startTime, s.endTime]), [["18:00", "18:10"], ["20:00", "20:10"]]);
  });

  it("keeps a dated slot on the DST change in local time", () => {
    const [slot] = slotsBetween(globex, Date.parse("2026-11-01T00:00:00-04:00"), Date.parse("2026-11-02T00:00:00-05:00"));
    assert.equal(slot.date, "2026-11-01");
    assert.equal(slot.start, Date.parse("2026-11-01T18:00:00-05:00"));
    assert.equal(slot.end, Date.parse("2026-11-01T18:10:00-05:00"));
  });
});

describe("dated sessions: filing", () => {
  it("files a weekly-only series exactly as before", () => {
    const convs = [conv(1, "2026-10-20", "17:05", "17:50"), conv(2, "2026-10-21", "17:05", "17:50")];
    const withEmpty = normalizeSeries({ ...therapy, dated: [] });
    assert.deepEqual(windowCandidates(convs, withEmpty), windowCandidates(convs, therapy));
    const [c] = windowCandidates(convs, therapy);
    assert.deepEqual(ids(c.session.parts), [1]);
    assert.equal(c.tag.reason, "Tue 17:00 to 18:00 slot");
  });

  it("uses a dated session instead of the weekly slot on the weekly day", () => {
    const convs = [
      conv(11, "2026-10-21", "10:00", "10:19"), // in the weekly slot, before the dated one
      conv(12, "2026-10-21", "10:21", "10:59"),
      conv(13, "2026-10-14", "10:00", "10:50"), // an ordinary Wednesday
    ];
    const cs = windowCandidates(convs, mentoring);
    assert.deepEqual(cs.map((c) => ids(c.session.parts)), [[12], [13]]);
    assert.deepEqual(reasons(cs), ["Wed 10:20 to 11:00 dated slot", "Wed 10:00 to 11:00 slot"]);
  });

  it("files nothing on a skipped day", () => {
    assert.deepEqual(windowCandidates([conv(21, "2026-10-28", "10:00", "10:50")], mentoring), []);
  });

  it("files two sessions for two dated slots on one day", () => {
    const convs = [conv(31, "2026-10-22", "18:00", "18:10"), conv(32, "2026-10-22", "20:01", "20:10")];
    const sessions = matchSessions(convs, coaching);
    assert.deepEqual(sessions.map((s) => ids(s.parts)), [[32], [31]]);
    assert.deepEqual(reasons(windowCandidates(convs, coaching)), ["Thu 18:00 to 18:10 dated slot", "Thu 20:00 to 20:10 dated slot"]);
  });

  it("files a dated slot on a series with no weekly slot", () => {
    const cs = windowCandidates([conv(41, "2026-10-23", "19:00", "19:08"), conv(42, "2026-10-24", "19:00", "19:08")], globex);
    assert.deepEqual(cs.map((c) => ids(c.session.parts)), [[41]]);
    assert.equal(cs[0].tag.reason, "Fri 19:00 to 19:10 dated slot");
  });

  it("files a dated slot on the DST change", () => {
    const convs = [conversation(51, "2026-11-01T18:01:00-05:00", "2026-11-01T18:09:00-05:00")];
    assert.deepEqual(matchSessions(convs, globex).map((s) => ids(s.parts)), [[51]]);
  });

  it("keeps the minimum length rule for a short dated slot", () => {
    const strict = normalizeSeries({ ...coaching, minDurationMinutes: 30 });
    assert.deepEqual(matchSessions([conv(61, "2026-10-22", "18:00", "18:10")], strict), []);
  });

  it("places an unnamed marked session in a dated slot", () => {
    const series = [coaching, globex, other];
    const marker = (journalId: string, kind: "start" | "end", date: string, time: string) => ({ journalId, kind, at: new Date(ny(date, time)).toISOString() });
    const [early] = markerCandidates(
      [marker("j1", "start", "2026-10-22", "17:45"), marker("j2", "end", "2026-10-22", "18:12")],
      [conv(71, "2026-10-22", "17:46", "18:11")],
      series,
    );
    assert.equal(early.seriesId, "synthetic-coaching");
    assert.match(early.tag.reason, /no series named; in the Thu 18:00 to 18:10 dated slot$/);
    const [interview] = markerCandidates(
      [marker("j3", "start", "2026-10-22", "19:01"), marker("j4", "end", "2026-10-22", "19:09")],
      [conv(72, "2026-10-22", "19:01", "19:09")],
      series,
    );
    assert.equal(interview.seriesId, "globex-interview");
    const [outside] = markerCandidates(
      [marker("j5", "start", "2026-10-22", "21:00"), marker("j6", "end", "2026-10-22", "21:20")],
      [conv(73, "2026-10-22", "21:01", "21:19")],
      series,
    );
    assert.equal(outside.seriesId, "other");
  });
});

describe("dated sessions: nextSession", () => {
  const withDated = (dated: unknown[]) => normalizeSeries({ ...mentoring, dated });

  it("picks the earliest of the weekly slot and dated sessions", () => {
    // NOW is Thu Oct 22, 10:00; the weekly slot is next on Wed Oct 28.
    assert.equal(nextSession(withDated([{ date: "2026-10-23", start: "08:00", end: "08:30" }]), NOW)?.start, Date.parse(ny("2026-10-23", "08:00")));
    assert.equal(nextSession(withDated([{ date: "2026-10-30", start: "08:00", end: "08:30" }]), NOW)?.start, Date.parse(ny("2026-10-28", "10:00")));
    // A skipped week finds the slot after it, across the end of DST.
    assert.equal(nextSession(withDated([{ date: "2026-10-28", skip: true }]), NOW)?.start, Date.parse("2026-11-04T10:00:00-05:00"));
  });

  it("walks today's dated slots until each ends", () => {
    assert.equal(nextSession(coaching, NOW)?.start, Date.parse(ny("2026-10-22", "18:00")));
    assert.equal(nextSession(coaching, Date.parse(ny("2026-10-22", "18:05")))?.start, Date.parse(ny("2026-10-22", "18:00")));
    assert.equal(nextSession(coaching, Date.parse(ny("2026-10-22", "18:10")))?.end, Date.parse(ny("2026-10-22", "20:10")));
    assert.equal(nextSession(coaching, Date.parse(ny("2026-10-22", "20:10"))), null);
  });

  it("finds a dated session weeks ahead on a series with no weekly slot", () => {
    const later = normalizeSeries({ ...globex, dated: [{ date: "2026-12-01", start: "19:00", end: "19:10" }] });
    assert.equal(nextSession(later, NOW)?.start, Date.parse("2026-12-01T19:00:00-05:00"));
  });
});
