import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { BeeConversation, BeeJournal } from "../src/bee/cli.js";
import { recordSnapshot } from "../src/collector.js";
import { prepBrief } from "../src/mcp/views.js";
import type { Series } from "../src/series.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import { at, conversation } from "./fixtures/index.js";
import { coaching, therapy } from "./fixtures/meeting-types.js";

// Synthetic Thursday, Oct 22, 2026 in New York (EDT, -04:00).
const t = (hhmm: string, day = "2026-10-22") => `${day}T${hhmm}:00-04:00`;
const note = (id: string, time: string, text: string): BeeJournal => ({
  id,
  text,
  state: "READY",
  created_at: at(time),
  updated_at: at(time) + 60_000,
  corrections: [],
});

let store: TableStore;
let path: string;
let series: Series[];
beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), "bs-button-")), "store.json");
  store = fileStore(path);
  series = [therapy, coaching];
  for (const s of series) await store.putSeries(s);
});

const run = async (collectedAt: string, conversations: BeeConversation[], journals: BeeJournal[]) =>
  recordSnapshot(store, await store.listSeries(), { collectedAt: new Date(collectedAt).toISOString(), conversations, insights: [], journals });

describe("Bee button: device test D", () => {
  const journals = [
    note("j1", t("16:02"), "Start coaching session."),
    note("j2", t("16:31"), "End coaching session."),
    note("j3", t("16:33"), "Debrief: synthetic debrief words."),
  ];
  const talk = conversation(101, t("16:03"), t("16:30"));

  it("captures the marked span with the debrief, and the brief confirms it", async () => {
    const result = await run(t("16:45"), [talk], journals);
    assert.equal(result.button.markers, 2);
    assert.equal(result.button.filed, 1);

    const s = await store.getLatestSession(coaching.id);
    assert.equal(s?.start, new Date(t("16:02")).toISOString());
    assert.equal(s?.end, new Date(t("16:31")).toISOString());
    assert.deepEqual(s?.parts.map((p) => p.id), [101]);
    assert.equal(s?.tag?.source, "marker");
    assert.equal(s?.tag?.confidence, "certain");
    assert.deepEqual((await store.listDebriefs(coaching.id, s!.start)).map((d) => d.text), ["synthetic debrief words"]);

    const brief = await prepBrief(store, coaching, at(t("17:00")));
    assert.deepEqual(brief.debriefs, ["synthetic debrief words"]);
    assert.match(brief.fromBee!, /^Got it: session started .*4:02.* \(Coaching\), session ended .*4:31.*, debrief saved\.$/);
  });

  it("uses each note once", async () => {
    await run(t("16:45"), [talk], journals);
    const again = await run(t("17:00"), [talk], journals);
    assert.equal(again.button.notes, 0);
    assert.equal((await store.listMarkers()).length, 2);
    const s = await store.getLatestSession(coaching.id);
    assert.equal((await store.listDebriefs(coaching.id, s!.start)).length, 1);
  });

  it("files the debrief before Bee finishes the conversation, and keeps it", async () => {
    await run(t("16:35"), [], journals);
    const empty = await store.getLatestSession(coaching.id);
    assert.equal(empty?.parts.length, 0);
    await run(t("16:50"), [talk], []);
    const full = await store.getLatestSession(coaching.id);
    assert.equal(full?.start, empty?.start);
    assert.equal(full?.parts.length, 1);
    assert.equal((await store.listDebriefs(coaching.id, full!.start)).length, 1);
  });

  it("isn't also stored as a window session", async () => {
    const long = conversation(102, t("16:01"), t("16:50"));
    await run(t("17:00"), [long], [note("j1", t("16:00"), "Start coaching session."), note("j2", t("16:52"), "End coaching session.")]);
    assert.equal((await store.listSessions(coaching.id, 10)).length, 1);
    assert.equal((await store.getLatestSession(coaching.id))?.tag?.source, "marker");
  });
});

describe("Bee button: interviews and unnamed starts", () => {
  it("files 'Acme interview' and a misheard 'Akme interview' in one new unscheduled series", async () => {
    const journals = [
      note("a1", t("10:00"), "Start session: Acme interview"),
      note("a2", t("10:46"), "End session."),
      note("a3", t("14:00"), "Start session: Akme interview."),
      note("a4", t("14:51"), "And session."),
    ];
    const result = await run(t("15:00"), [conversation(201, t("10:01"), t("10:45")), conversation(202, t("14:01"), t("14:50"))], journals);
    assert.equal(result.button.seriesCreated, 1);
    const all = await store.listSeries();
    const acme = all.find((s) => s.name === "Acme Interview");
    assert.ok(acme);
    assert.equal(acme.weekday, undefined);
    const sessions = await store.listSessions(acme.id, 10);
    assert.deepEqual(sessions.map((s) => s.parts.map((p) => p.id)), [[202], [201]]);
  });

  it("sends an unnamed start with two series to Other, pending review", async () => {
    await run(t("12:00", "2026-10-21"), [conversation(301, t("11:01", "2026-10-21"), t("11:40", "2026-10-21"))], [
      note("o1", t("11:00", "2026-10-21"), "Start session"),
      note("o2", t("11:41", "2026-10-21"), "End session"),
    ]);
    const other = await store.getLatestSession("other");
    assert.equal(other?.tag?.status, "pending");
    assert.match(other!.tag!.reason, /filed under Other/);
    assert.ok((await store.listSeries()).some((s) => s.id === "other"));
  });

  it("guesses the series from its slot for an unnamed start, pending review", async () => {
    await run(t("17:00"), [conversation(302, t("16:01"), t("16:40"))], [
      note("s1", t("16:00"), "Start session"),
      note("s2", t("16:41"), "End session"),
    ]);
    const s = await store.getLatestSession(coaching.id);
    assert.equal(s?.tag?.status, "pending");
    assert.match(s!.tag!.reason, /Thu 16:00 to 17:00 slot/);
  });

  it("closes a lone start at the end of its run of conversations", async () => {
    const convs = [
      conversation(401, t("10:01"), t("10:40")),
      conversation(402, t("10:50"), t("11:10")),
      conversation(403, t("13:00"), t("13:30")),
    ];
    await run(t("14:00"), convs, [note("l1", t("10:00"), "Start therapy session")]);
    const s = await store.getLatestSession(therapy.id);
    assert.deepEqual(s?.parts.map((p) => p.id), [401, 402]);
    assert.equal(s?.end, new Date(t("11:10")).toISOString());
  });

  it("opens a lone end at the start of the run leading up to it", async () => {
    const convs = [conversation(501, t("09:00"), t("09:40")), conversation(502, t("09:45"), t("10:20"))];
    await run(t("11:00"), convs, [note("e1", t("10:21"), "End therapy session")]);
    const s = await store.getLatestSession(therapy.id);
    assert.equal(s?.start, new Date(t("09:00")).toISOString());
    assert.deepEqual(s?.parts.map((p) => p.id), [501, 502]);
  });

  it("still finds an unmarked session from the schedule window", async () => {
    await run(t("19:00", "2026-10-20"), [conversation(601, t("17:02", "2026-10-20"), t("17:55", "2026-10-20"))], []);
    assert.equal((await store.getLatestSession(therapy.id))?.tag?.source, "schedule");
  });
});

describe("Bee button: agenda, takeaways and reports", () => {
  it("adds an agenda item for the next session, marked from Bee, at the note's time", async () => {
    await run(t("09:30"), [], [note("g1", t("09:00"), "Agenda: synthetic item")]);
    const [item] = await store.listAgenda(coaching.id); // Coaching is next (Thu 16:00)
    assert.equal(item.text, "synthetic item");
    assert.equal(item.source, "bee");
    assert.equal(item.createdAt, new Date(t("09:00")).toISOString());
    const brief = await prepBrief(store, coaching, at(t("10:00")));
    assert.deepEqual(brief.openAgenda, ["synthetic item (from Bee)"]);
    assert.match(brief.fromBee!, /1 agenda item added/);
  });

  it("files a named agenda item and removes one by voice", async () => {
    await run(t("09:30"), [], [note("g1", t("09:00"), "Agenda for therapy: synthetic sleep item")]);
    assert.equal((await store.listAgenda(therapy.id)).length, 1);
    await run(t("09:45"), [], [note("g2", t("09:40"), "Drop the sleep item from my therapy agenda")]);
    assert.equal((await store.listAgenda(therapy.id)).length, 0);
  });

  it("saves a takeaway on the session that just ended", async () => {
    await run(t("17:00"), [conversation(701, t("16:03"), t("16:30"))], [
      note("k1", t("16:02"), "Start coaching session"),
      note("k2", t("16:31"), "End coaching session"),
      note("k3", t("16:35"), "Takeaway: synthetic takeaway"),
    ]);
    const s = await store.getLatestSession(coaching.id);
    const [tk] = await store.listTakeaways(coaching.id, s!.start);
    assert.equal(tk.text, "synthetic takeaway");
    assert.equal(tk.source, "bee");
  });

  it("reports a note it couldn't file and stores no text of ordinary notes", async () => {
    await run(t("09:30"), [], [note("u1", t("09:00"), "Agenda."), note("n1", t("09:05"), "Synthetic grocery reminder")]);
    const brief = await prepBrief(store, coaching, at(t("10:00")));
    assert.equal(brief.fromBee, "1 voice note I couldn't file.");
    const raw = await readFile(path, "utf8");
    assert.ok(!raw.includes("grocery"));
    assert.ok(raw.includes("n1"));
  });
});
