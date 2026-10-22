import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { newToken, reviewServer } from "../src/local/review-ui.js";
import { PAST_WARNING, scheduleState, slotWarnings } from "../src/local/schedule-ui.js";
import { normalizeSeries } from "../src/series.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import type { SessionInput } from "../src/store/types.js";
import { other, therapy } from "./fixtures/meeting-types.js";

// All synthetic, October 2026 in New York (EDT, -04:00). Oct 21 is a
// Wednesday, Oct 22 a Thursday.
const mentoring = normalizeSeries({
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
});
const coaching = normalizeSeries({
  id: "synthetic-coaching",
  name: "Synthetic coaching",
  timezone: "America/New_York",
  minDurationMinutes: 5,
  minOverlapMinutes: 5,
  dated: [
    { date: "2026-10-22", start: "18:00", end: "18:10" },
    { date: "2026-10-22", start: "20:00", end: "20:10" },
  ],
});
const session = (start: string, end: string, id: number): SessionInput => ({
  start: new Date(start).toISOString(),
  end: new Date(end).toISOString(),
  parts: [{ id, start, end, shortSummary: `Synthetic short ${id}`, summary: `Synthetic long summary ${id}` }],
  insights: [],
  tag: { source: "schedule", confidence: "high", status: "auto", reason: "Wed 10:20 to 11:00 dated slot" },
});
const MENTORING_SESSION = "2026-10-21T10:21:00-04:00";

async function seed(store: TableStore) {
  for (const s of [therapy, other, mentoring, coaching]) await store.putSeries(s);
  await store.recordSession(mentoring.id, session(MENTORING_SESSION, "2026-10-21T10:59:00-04:00", 910001), "2026-10-21T11:30:00.000Z");
}

interface Reply {
  status: number;
  type: string;
  body: string;
  json: () => any;
}

function call(
  port: number,
  path: string,
  { method = "GET", host = `127.0.0.1:${port}`, token, body, contentType = "application/json" }: { method?: string; host?: string; token?: string; body?: unknown; contentType?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: host };
    if (token !== undefined) headers["X-Review-Token"] = token;
    if (body !== undefined) headers["Content-Type"] = contentType;
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), body: data, json: () => JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

let store: TableStore;
let server: Server;
let port: number;
const token = newToken();
beforeEach(async () => {
  store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-schedule-ui-")), "store.json"));
  await seed(store);
  server = reviewServer(store, token);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => server.close());

const post = (path: string, body: unknown, opts: { contentType?: string; token?: string } = {}) =>
  call(port, path, { method: "POST", token: opts.token ?? token, body, contentType: opts.contentType });
const ROUTES: [string, string][] = [
  ["GET", "/schedule"],
  ["GET", "/api/schedule"],
  ["POST", "/api/schedule/series"],
  ["POST", "/api/schedule/dated"],
  ["POST", "/api/schedule/dated/remove"],
  ["POST", "/api/schedule/series/delete"],
];
const NEW_COACHING = {
  name: "Synthetic coaching two",
  timezone: "America/New_York",
  weekday: 4,
  windowStart: "18:00",
  windowEnd: "18:10",
  minDurationMinutes: 5,
  minOverlapMinutes: 5,
  dated: [
    { date: "2026-10-22", start: "18:00", end: "18:10" },
    { date: "2026-10-22", start: "20:00", end: "20:10" },
  ],
};

describe("schedule page: access", () => {
  it("refuses a wrong Host with 403 and a missing or wrong token with 401 on every route", async () => {
    for (const [method, path] of ROUTES) {
      const body = method === "POST" ? { id: "synthetic-coaching" } : undefined;
      assert.equal((await call(port, path, { method, host: "evil.example", token, body })).status, 403, path);
      assert.equal((await call(port, path, { method, host: `127.0.0.1:${port + 1}`, token, body })).status, 403, path);
      assert.equal((await call(port, path, { method, body })).status, 401, path);
      assert.equal((await call(port, path, { method, token: `${token}x`, body })).status, 401, path);
      assert.equal((await call(port, `${path}?token=wrong`, { method, body })).status, 401, path);
    }
    assert.equal(await store.getSeries("synthetic-coaching").then((s) => s?.name), "Synthetic coaching");
  });

  it("needs JSON on its edits", async () => {
    assert.equal((await post("/api/schedule/series/delete", { id: "synthetic-coaching" }, { contentType: "text/plain" })).status, 415);
    assert.equal((await post("/api/schedule/dated", "series=x", { contentType: "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await post("/api/schedule/dated", "not json")).status, 400);
    assert.equal((await call(port, "/api/schedule/series", { token })).status, 404);
    assert.equal((await call(port, "/api/schedulex", { token })).status, 404);
  });

  it("serves one self-contained page that renders nested arrays with .flat(2)", async () => {
    const page = await call(port, `/schedule?token=${token}`);
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /<script>/);
    assert.match(page.body, /\.flat\(2\)/);
    assert.doesNotMatch(page.body, /\[object/);
    assert.doesNotMatch(page.body, /\bsrc=|\bhref=|https?:\/\/|@import/);
    // The inline script parses (not run: there's no DOM here).
    const script = page.body.split("<script>")[1].split("</script>")[0];
    assert.doesNotThrow(() => new Function(script));
    assert.match(page.body, /id="nav-review"/);
    assert.match(page.body, /"\/\?token=" \+ encodeURIComponent\(token\)/);
    const review = await call(port, `/?token=${token}`);
    assert.match(review.body, /"\/schedule\?token=" \+ encodeURIComponent\(token\)/);
  });
});

describe("schedule page: series", () => {
  it("lists every series with its slots, and no summaries", async () => {
    const res = await call(port, "/api/schedule?from=2026-10-12&to=2026-10-29", { token });
    assert.equal(res.status, 200);
    const state = res.json();
    const m = state.series.find((s: { id: string }) => s.id === mentoring.id);
    assert.equal(m.weekly, "Wed 10:00 to 11:00");
    assert.deepEqual(m.dated, mentoring.dated);
    assert.equal(m.minDurationMinutes, 30);
    assert.equal(state.series.find((s: { id: string }) => s.id === other.id).weekly, "none");
    assert.doesNotMatch(res.body, /Synthetic short|Synthetic long|summary/i);
  });

  it("creates a series with an id from its name, and reads it back", async () => {
    const res = await post("/api/schedule/series", NEW_COACHING);
    assert.equal(res.status, 200);
    assert.equal(res.json().readback, "Saved Synthetic coaching two: Thu 18:00 to 18:10 weekly, 2 dated sessions, minimum length 5 min.");
    const saved = await store.getSeries("synthetic-coaching-two");
    assert.equal(saved?.windowEnd, "18:10");
    assert.equal(saved?.dated.length, 2);
    // A second with the same name gets its own id.
    await post("/api/schedule/series", { name: "Synthetic coaching two" });
    assert.ok(await store.getSeries("synthetic-coaching-two-2"));
  });

  it("updates a series, warns about a slot shorter than the minimum, and clears the weekly slot", async () => {
    const res = await post("/api/schedule/series", { id: coaching.id, minDurationMinutes: 30 });
    assert.equal(res.status, 200);
    assert.equal(res.json().readback, "Saved Synthetic coaching: no weekly slot, 2 dated sessions, minimum length 30 min.");
    assert.ok(
      res.json().warnings.includes("This slot is 10 min but the minimum length is 30 min, so nothing will be filed. Set the minimum length to 5."),
      res.body,
    );
    assert.equal((await store.getSeries(coaching.id))?.minDurationMinutes, 30);

    const cleared = await post("/api/schedule/series", { id: mentoring.id, weekday: null, windowStart: null, windowEnd: null, spokenNames: ["mentor"] });
    assert.equal(cleared.status, 200);
    assert.match(cleared.json().readback, /^Saved Synthetic mentoring: no weekly slot, 1 dated session, 1 skipped day, minimum length 30 min\.$/);
    const s = await store.getSeries(mentoring.id);
    assert.equal(s?.weekday, undefined);
    assert.deepEqual(s?.spokenNames, ["mentor"]);
  });

  it("doesn't change ids, and rejects bad input with a clear message", async () => {
    const renamed = await post("/api/schedule/series", { id: "synthetic-renamed", name: "Synthetic coaching" });
    assert.equal(renamed.status, 400);
    assert.match(renamed.json().error, /A series' id can't be changed/);
    const badTime = await post("/api/schedule/series", { id: mentoring.id, windowStart: "25:00" });
    assert.equal(badTime.status, 400);
    assert.equal(badTime.json().error, 'Use a 24-hour time as HH:MM, not "25:00"');
    const backwards = await post("/api/schedule/series", { id: mentoring.id, windowStart: "11:00", windowEnd: "10:00" });
    assert.match(backwards.json().error, /The weekly end \(10:00\) must be after the start \(11:00\)/);
    const half = await post("/api/schedule/series", { id: mentoring.id, weekday: null });
    assert.match(half.json().error, /A schedule needs weekday, windowStart and windowEnd together/);
    const zone = await post("/api/schedule/series", { name: "Synthetic zone", timezone: "Mars/Olympus" });
    assert.match(zone.json().error, /Unknown time zone "Mars\/Olympus"/);
    const noName = await post("/api/schedule/series", { timezone: "America/New_York" });
    assert.equal(noName.status, 400);
    const badNumber = await post("/api/schedule/series", { id: mentoring.id, minDurationMinutes: 0 });
    assert.equal(badNumber.status, 400);
    assert.match(badNumber.json().error, /^minDurationMinutes: /);
    assert.equal((await store.getSeries(mentoring.id))?.windowStart, "10:00");
  });
});

describe("schedule page: delete", () => {
  it("deletes a series with nothing stored", async () => {
    const res = await post("/api/schedule/series/delete", { id: coaching.id });
    assert.equal(res.status, 200);
    assert.equal(res.json().readback, "Deleted Synthetic coaching.");
    assert.equal(await store.getSeries(coaching.id), null);
  });

  it("refuses a series with sessions, agenda items or takeaways, and Other", async () => {
    const res = await post("/api/schedule/series/delete", { id: mentoring.id });
    assert.equal(res.status, 409);
    assert.equal(res.json().error, "Has 1 session; move or mark them first.");
    await store.addAgendaItem(coaching.id, "Synthetic agenda item");
    await store.saveTakeaway(coaching.id, "2026-10-22T22:00:00.000Z", "Synthetic takeaway");
    assert.equal((await post("/api/schedule/series/delete", { id: coaching.id })).json().error, "Has 1 agenda item and 1 takeaway; move or mark them first.");
    assert.match((await post("/api/schedule/series/delete", { id: "other" })).json().error, /can't be deleted/);
    assert.equal((await post("/api/schedule/series/delete", { id: "missing" })).status, 400);
    assert.deepEqual((await store.listSeries()).map((s) => s.id).sort(), ["other", "synthetic-coaching", "synthetic-mentoring", "therapy"]);
  });
});

describe("schedule page: dated sessions", () => {
  it("adds and removes dated sessions and skips", async () => {
    const add = await post("/api/schedule/dated", { series: "therapy", date: "2026-11-03", start: "19:00", end: "19:10" });
    assert.equal(add.status, 200);
    assert.equal(add.json().readback, "Added a dated session to Weekly therapy: Tue, Nov 3, 19:00 to 19:10 (1 slot that day).");
    assert.ok(add.json().warnings.some((w: string) => w.startsWith("This slot is 10 min but the minimum length is 30 min")));
    assert.deepEqual((await store.getSeries("therapy"))?.dated, [{ date: "2026-11-03", start: "19:00", end: "19:10" }]);

    const second = await post("/api/schedule/dated", { series: "therapy", date: "2026-11-03", start: "20:00", end: "20:10" });
    assert.match(second.json().readback, /\(2 slots that day\)\.$/);

    // A skip replaces the day's sessions; a session replaces a skip.
    const skip = await post("/api/schedule/dated", { series: "therapy", date: "2026-11-03", skip: true });
    assert.equal(skip.json().readback, "Weekly therapy has no slot on Tue, Nov 3.");
    assert.deepEqual((await store.getSeries("therapy"))?.dated, [{ date: "2026-11-03", skip: true }]);

    const unskip = await post("/api/schedule/dated/remove", { series: "therapy", date: "2026-11-03" });
    assert.equal(unskip.json().readback, "Removed the skip from Weekly therapy on Tue, Nov 3. Slots that day: 17:00 to 18:00 weekly.");
    assert.deepEqual((await store.getSeries("therapy"))?.dated, []);

    const remove = await post("/api/schedule/dated/remove", { series: coaching.id, date: "2026-10-22", start: "18:00" });
    assert.equal(remove.json().readback, "Removed the 18:00 dated session from Synthetic coaching on Thu, Oct 22. Slots that day: 20:00 to 20:10 dated.");
    // Oct 21 has passed, so the page warns that a past session can be re-filed.
    const past = await post("/api/schedule/dated/remove", { series: mentoring.id, date: "2026-10-21", start: "10:20" });
    assert.equal(past.json().readback, "Removed the 10:20 dated session from Synthetic mentoring on Wed, Oct 21. Slots that day: 10:00 to 11:00 weekly.");
    assert.ok(past.json().warnings.includes(PAST_WARNING));
    const again = await post("/api/schedule/dated/remove", { series: coaching.id, date: "2026-10-22", start: "18:00" });
    assert.equal(again.status, 400);
    assert.match(again.json().error, /has no dated session at 18:00 on Thu, Oct 22/);
  });

  it("rejects a bad date or time with a 400 and a clear message", async () => {
    const time = await post("/api/schedule/dated", { series: coaching.id, date: "2026-10-23", start: "25:00", end: "25:10" });
    assert.equal(time.status, 400);
    assert.match(time.json().error, /Use a 24-hour time as HH:MM, not "25:00"/);
    const backwards = await post("/api/schedule/dated", { series: coaching.id, date: "2026-10-23", start: "19:10", end: "19:00" });
    assert.equal(backwards.json().error, "The end (19:00) must be after the start (19:10)");
    const date = await post("/api/schedule/dated", { series: coaching.id, date: "2026-02-30", start: "19:00", end: "19:10" });
    assert.equal(date.json().error, 'Use a real date as YYYY-MM-DD, not "2026-02-30"');
    assert.equal((await post("/api/schedule/dated", { series: "missing", date: "2026-10-23", start: "19:00", end: "19:10" })).status, 400);
    assert.equal((await post("/api/schedule/dated", { series: coaching.id, date: "2026-10-23" })).status, 400);
    assert.equal((await store.getSeries(coaching.id))?.dated.length, 2);
  });
});

describe("schedule page: calendar", () => {
  // Thu Oct 22, 19:00 in New York: between the two coaching slots.
  const now = Date.parse("2026-10-22T19:00:00-04:00");

  it("lists weekly, dated and skipped days, past and planned, with the filed session", async () => {
    const state = await scheduleState(store, { from: "2026-10-12", to: "2026-10-29" }, now);
    const rows = state.calendar.map((c) => [c.date, c.weekday, c.start, c.end, c.seriesId, c.source, c.timing, c.filed?.id ?? null]);
    assert.deepEqual(rows, [
      ["2026-10-13", "Tue", "17:00", "18:00", "therapy", "weekly", "past", null],
      ["2026-10-14", "Wed", "10:00", "11:00", "synthetic-mentoring", "weekly", "past", null],
      ["2026-10-20", "Tue", "17:00", "18:00", "therapy", "weekly", "past", null],
      ["2026-10-21", "Wed", "10:20", "11:00", "synthetic-mentoring", "dated", "past", `synthetic-mentoring@${new Date(MENTORING_SESSION).toISOString()}`],
      ["2026-10-22", "Thu", "18:00", "18:10", "synthetic-coaching", "dated", "past", null],
      ["2026-10-22", "Thu", "20:00", "20:10", "synthetic-coaching", "dated", "planned", null],
      ["2026-10-27", "Tue", "17:00", "18:00", "therapy", "weekly", "planned", null],
      // Oct 28 is skipped.
    ]);
    const filed = state.calendar[3].filed!;
    assert.deepEqual(filed, { id: filed.id, when: "Wed, Oct 21, 10:21 AM", status: "auto", source: "schedule" });
    assert.equal(state.calendar[4].minutes, 10);
    assert.equal(state.calendar[4].warning, null); // minimum length 5
  });

  it("defaults to two weeks back and one ahead, and checks the range", async () => {
    const state = await scheduleState(store, {}, now);
    assert.deepEqual([state.from, state.today, state.to], ["2026-10-08", "2026-10-22", "2026-10-29"]);
    await assert.rejects(scheduleState(store, { from: "2026-10-29", to: "2026-10-01" }, now), /ends before it starts/);
    assert.equal((await call(port, "/api/schedule?from=yesterday&to=2026-10-29", { token })).status, 400);
    assert.equal((await call(port, "/api/schedule?from=2026-01-01&to=2026-12-31", { token })).status, 400);
  });

  it("warns on a calendar slot shorter than the minimum", async () => {
    await store.putSeries({ ...coaching, minDurationMinutes: 30 });
    const state = await scheduleState(store, { from: "2026-10-22", to: "2026-10-22" }, now);
    assert.equal(
      state.calendar.find((c) => c.seriesId === coaching.id)?.warning,
      "This slot is 10 min but the minimum length is 30 min, so nothing will be filed. Set the minimum length to 5.",
    );
  });
});

describe("schedule page: warnings", () => {
  it("gives the minimum-length and overlap warnings for short slots", () => {
    assert.deepEqual(slotWarnings(normalizeSeries({ id: "x", name: "X" }), [10, 60]), [
      "This slot is 10 min but the minimum length is 30 min, so nothing will be filed. Set the minimum length to 5.",
      "This slot is 10 min and each conversation must overlap it by 10 min, so one that starts late won't count. Set the minimum overlap to 5.",
    ]);
    assert.deepEqual(slotWarnings(coaching, [10, 10]), []);
  });
});
