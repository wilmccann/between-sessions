import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DISCREET_BY_DEFAULT,
  escapeSsml,
  isDiscreet,
  menuSentence,
  paraphrase,
  renderAgendaAdded,
  renderAgendaList,
  renderAgendaRemoved,
  renderError,
  renderFallback,
  renderHelp,
  renderLastSession,
  renderLaunch,
  renderNextSession,
  renderNoTakeawaySession,
  renderNotOnAgenda,
  renderPrepBrief,
  renderRetagConfirm,
  renderRetagDone,
  renderReview,
  renderSinceLastSession,
  renderTakeawaySaved,
  renderWhichSeries,
  sentenceCount,
  spokenWhen,
  type AgendaView,
  type ReviewView,
  type SinceView,
  type Speech,
} from "../src/alexa/speech.js";
import { BOUNDARY, CAPABILITIES } from "../src/mcp/capabilities.js";
import type { PrepBriefView, SessionView } from "../src/mcp/views.js";
import { normalizeSeries, type Series } from "../src/series.js";
import { acme, coaching, NOW, therapy } from "./fixtures/meeting-types.js";

// All synthetic. NOW is Thursday Oct 22, 2026, 10:00 in New York; therapy is
// Tuesdays 17:00 and coaching Thursdays 16:00.
const discreetTherapy: Series = { ...therapy, discreet: true };
const discreetCoaching: Series = { ...coaching, spokenNames: ["synthetic coach"], discreet: true };

const ITEMS = ["Synthetic: bring up the zeppelin trip", "Synthetic marmalade budget", "Synthetic quokka plan", "Synthetic fourth item"];
const SHORT = "Synthetic chat about lighthouse keeping. Then more synthetic words.";
const LONG = "Synthetic long summary that must never be spoken";
const TOPICS = [{ word: "zeppelin", count: 3 }, { word: "marmalade", count: 2 }];
const INSIGHT = "Synthetic insight about kumquats";

const brief = (over: Partial<PrepBriefView> = {}): PrepBriefView => ({
  series: coaching.name,
  fromBee: null,
  review: null,
  sinceLastSession: "It's been 7 days and 12 conversations. Bee noticed: Synthetic insight about kumquats.",
  lastSessionLocal: "Thursday, October 15, 2026 at 4:02 PM",
  shortSummary: SHORT,
  note: "Synthetic note",
  bullets: ["Synthetic bullet"],
  insightTitles: [INSIGHT],
  openAgenda: ITEMS.slice(0, 2).map((t, i) => (i === 0 ? `${t} (from Bee)` : t)),
  takeaways: ["Synthetic takeaway text"],
  debriefs: ["Synthetic debrief text"],
  nextSession: "Thu, Oct 22, 4:00 PM",
  nextSessionAt: "2026-10-22T20:00:00.000Z",
  source: "assembled",
  ...over,
});

const since: SinceView = {
  series: coaching.name,
  summary: `It's been 6 days and 38 conversations. From last session, zeppelin (3 times) came up again. Bee noticed: ${INSIGHT}.`,
  lastSessionEndedLocal: "Thursday, October 15, 2026 at 4:55 PM",
  conversations: 38,
  topics: TOPICS,
  insightTitles: [INSIGHT],
};

const last: SessionView = {
  series: coaching.name,
  startedAt: "2026-10-15T20:02:00.000Z",
  startedAtLocal: "Thursday, October 15, 2026 at 4:02 PM",
  durationMinutes: 53,
  foundBy: { source: "schedule", status: "auto", reason: "Thu 16:00 to 17:00 slot" },
  debriefs: ["Synthetic debrief text"],
  parts: [],
  shortSummary: SHORT,
  summary: LONG,
  insights: [{ title: INSIGHT, description: "Synthetic insight description", generatedAt: "2026-10-16T08:00:00.000Z" }],
  versions: 1,
  collectedAt: "2026-10-15T21:30:00.000Z",
  source: "bee-cli",
};

const agenda: AgendaView = {
  series: coaching.name,
  items: ITEMS.map((text) => ({ text, createdAt: "2026-10-21T12:00:00.000Z", from: "you" })),
};

const review: ReviewView = {
  line: "2 sessions to review.",
  sessions: [
    { id: `coaching@2026-10-15T20:02:00.000Z`, when: "Thu, Oct 15, 4:02 PM", durationMinutes: 52, guess: coaching.name, filed: true, expiresInDays: 9 },
    { id: `acme-interview@2026-10-19T15:00:00.000Z`, when: "Mon, Oct 19, 11:00 AM", durationMinutes: 45, guess: acme.name, filed: false, expiresInDays: 11 },
  ],
};

const all = [therapy, coaching, acme];

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Every renderer, in both modes, for a full and a discreet copy of a series.
function everything(series: Series, discreet: boolean): Record<string, Speech> {
  const next = "Want to see the whole agenda?";
  return {
    launch: renderLaunch("Got it: session ended Thu, Oct 22, 9:00 AM, 1 agenda item added. 1 voice note I couldn't file.", { series, nextAt: brief().nextSessionAt }, NOW),
    help: renderHelp(),
    fallback: renderFallback(),
    error: renderError(),
    prep: renderPrepBrief(brief(), series, discreet, next, NOW),
    prepNone: renderPrepBrief(brief({ lastSessionLocal: null, shortSummary: null, openAgenda: [], nextSessionAt: null }), series, discreet, next, NOW),
    next: renderNextSession(brief(), series, discreet, next, NOW),
    nextNone: renderNextSession(brief({ nextSessionAt: null }), series, discreet, next, NOW),
    since: renderSinceLastSession(since, series, discreet, next, NOW),
    sinceNone: renderSinceLastSession(null, series, discreet, next, NOW),
    last: renderLastSession(last, series, discreet, next),
    lastNone: renderLastSession(null, series, discreet, next),
    list: renderAgendaList(agenda, series, discreet, next),
    listOne: renderAgendaList({ ...agenda, items: agenda.items.slice(0, 1) }, series, discreet, next),
    listEmpty: renderAgendaList(null, series, discreet, next),
    add: renderAgendaAdded(ITEMS[0], series, discreet, next),
    remove: renderAgendaRemoved(ITEMS[1], series, discreet, next),
    notOnAgenda: renderNotOnAgenda(ITEMS[2], series, discreet),
    takeaway: renderTakeawaySaved("Synthetic takeaway text", series, discreet, next),
    takeawayNone: renderNoTakeawaySession(series, discreet),
    review: renderReview(review, all, discreet, next, NOW),
    reviewOne: renderReview({ ...review, sessions: review.sessions.slice(0, 1) }, all, discreet, next, NOW),
    reviewNone: renderReview(null, all, discreet, next, NOW),
    retagAsk: renderRetagConfirm(review.sessions[0], series, all, discreet, NOW),
    retagDone: renderRetagDone(`Moved the Thu, Oct 15, 4:02 PM session from Acme interview to ${series.name}. 1 agenda item reopened.`, series, discreet, next),
  };
}

describe("Alexa speech: discreet setting", () => {
  it("defaults to full answers and honors the series field", () => {
    assert.equal(DISCREET_BY_DEFAULT, false);
    assert.equal(isDiscreet(therapy), false);
    assert.equal(isDiscreet(discreetTherapy), true);
    assert.equal(isDiscreet({ ...therapy, discreet: false }), false);
  });

  it("parses the field from a series config", () => {
    assert.equal(normalizeSeries({ id: "x", name: "X", discreet: true }).discreet, true);
    assert.equal("discreet" in normalizeSeries({ id: "x", name: "X" }), false);
  });
});

describe("Alexa speech: every renderer", () => {
  for (const [mode, series, discreet] of [
    ["full", coaching, false],
    ["discreet", discreetCoaching, true],
  ] as const) {
    it(`keeps every ${mode} answer to at most 3 sentences, with a question reprompt`, () => {
      for (const [name, s] of Object.entries(everything(series, discreet))) {
        assert.ok(s.speech.length > 0, name);
        assert.ok(sentenceCount(s.speech) <= 3, `${name}: ${s.speech}`);
        assert.ok(s.reprompt?.trim().endsWith("?"), `${name} reprompt: ${s.reprompt}`);
        assert.ok(sentenceCount(s.reprompt!) === 1, `${name} reprompt: ${s.reprompt}`);
      }
    });
  }

  it("speaks dates and times naturally", () => {
    assert.equal(spokenWhen(Date.parse("2026-10-27T21:00:00.000Z"), "America/New_York", NOW), "Tuesday at 5 PM");
    assert.equal(spokenWhen(Date.parse("2026-10-22T20:30:00.000Z"), "America/New_York", NOW), "today at 4:30 PM");
    assert.equal(spokenWhen(Date.parse("2026-11-10T22:00:00.000Z"), "America/New_York", NOW), "Tuesday, November 10 at 5 PM");
    const full = everything(coaching, false);
    assert.equal(full.next.speech.split(".")[0], "Your next Coaching session is today at 4 PM");
    assert.match(full.launch.speech, /Thursday, October 22, 9:00 AM/);
    assert.match(full.list.speech, /You have 4 items on your Coaching agenda\./);
  });

  it("builds the menu from the capability list and gives the boundary on fallback", () => {
    for (const c of CAPABILITIES.filter((c) => c.inMenu)) assert.ok(menuSentence().includes(c.label), c.id);
    for (const c of CAPABILITIES.filter((c) => !c.inMenu)) assert.ok(!menuSentence().includes(c.label), c.id);
    assert.equal(sentenceCount(menuSentence()), 1);
    assert.ok(renderHelp().speech.startsWith(menuSentence()));
    assert.ok(unescape(renderFallback().speech).startsWith(BOUNDARY));
    assert.ok(renderLaunch(null, null, NOW).speech.includes(menuSentence()));
  });

  it("follows the full-mode use cases", () => {
    const f = everything(coaching, false);
    assert.equal(
      f.prep.speech,
      "Your last Coaching session was Thursday, October 15: Synthetic chat about lighthouse keeping. " +
        "You have 2 agenda items, starting with Synthetic: bring up the zeppelin trip. Want to see the whole agenda?",
    );
    assert.equal(f.since.speech.split(". ").slice(0, 2).join(". "), "It's been 6 days and 38 conversations. From last session, zeppelin 3 times and marmalade twice came up again");
    assert.match(f.last.speech, /^Your last Coaching session was Thursday, October 15, for 53 minutes: Synthetic chat about lighthouse keeping\./);
    assert.match(f.list.speech, /Number one, Synthetic: bring up the zeppelin trip; number two, Synthetic marmalade budget; number three, Synthetic quokka plan\./);
    assert.ok(!f.list.speech.includes(ITEMS[3]), "at most three items");
    assert.match(f.reviewOne.speech, /^One guess is waiting: a 52-minute conversation on Thursday, October 15 at 4:02 PM, filed under Coaching\. It expires in 9 days\./);
    assert.match(f.review.speech, /^2 guesses are waiting; the first is/);
    assert.equal(f.retagAsk.speech, "Move the 52-minute conversation on Thursday, October 15 at 4:02 PM to Coaching?");
    assert.match(f.retagDone.speech, /^Moved the Thursday, October 15, 4:02 PM session from Acme interview to Coaching\./);
  });

  it("reads back every write, naming the series in full mode", () => {
    const f = everything(coaching, false);
    assert.match(f.add.speech, /^Added to Coaching: Synthetic: bring up the zeppelin trip\./);
    assert.match(f.remove.speech, /^Removed from Coaching: Synthetic marmalade budget\./);
    assert.match(f.takeaway.speech, /^Saved for Coaching: Synthetic takeaway text\./);
    const d = everything(discreetCoaching, true);
    assert.match(d.add.speech, /^Added to your agenda\./);
    assert.match(d.remove.speech, /^Removed from your agenda\./);
    assert.match(d.takeaway.speech, /^Saved your takeaway\./);
  });

  it("follows the discreet table", () => {
    const d = everything(discreetTherapy, true);
    assert.equal(d.prep.speech, "Your Thursday session is today at 4 PM. You have 2 agenda items. The details are in Claude.");
    const tue = renderPrepBrief(brief({ nextSessionAt: "2026-10-27T21:00:00.000Z" }), discreetTherapy, true, "Want more?", NOW);
    assert.equal(tue.speech, "Your Tuesday session is at 5 PM. You have 2 agenda items. The details are in Claude.");
    assert.match(d.last.speech, /^It was on Thursday, October 15\. The summary is in Claude\./);
    assert.match(d.since.speech, /^It's been 6 days and 38 conversations\./);
    assert.match(d.list.speech, /^You have 4 items on your agenda\./);
    assert.match(d.review.speech, /^2 sessions need review\. The details are in Claude\./);
    const unscheduled = renderNextSession(brief({ nextSessionAt: null }), { ...acme, discreet: true }, true, "Want more?", NOW);
    assert.match(unscheduled.speech, /^Your next session isn't scheduled\./);
  });

  it("never says a discreet series' name, spoken names, items, topics, insight titles or summaries", () => {
    for (const series of [discreetTherapy, discreetCoaching]) {
      const forbidden = [
        series.name,
        ...series.spokenNames,
        ...ITEMS,
        "zeppelin",
        "marmalade",
        "quokka",
        ...TOPICS.map((t) => t.word),
        INSIGHT,
        "kumquats",
        "lighthouse",
        "Synthetic takeaway text",
        "Synthetic debrief text",
        LONG,
      ].map((s) => s.toLowerCase());
      // Every answer, the launch greeting, help, fallback and errors included.
      for (const [name, s] of Object.entries(everything(series, true))) {
        const said = `${s.speech} ${s.reprompt ?? ""}`.toLowerCase();
        for (const word of forbidden) assert.ok(!said.includes(word), `${name} says "${word}": ${s.speech}`);
      }
      const launch = renderLaunch(null, { series, nextAt: "2026-10-27T21:00:00.000Z" }, NOW).speech.toLowerCase();
      assert.ok(!launch.includes(series.name.toLowerCase()), launch);
      assert.ok(launch.startsWith("your tuesday session is at 5 pm."), launch);
      assert.ok(!launch.includes(series.spokenNames[0]?.toLowerCase() ?? "\u0000"), launch);
    }
  });

  it("never speaks the full summary or insight descriptions in full mode", () => {
    for (const [name, s] of Object.entries(everything(coaching, false))) {
      assert.ok(!s.speech.includes(LONG), name);
      assert.ok(!s.speech.includes("Synthetic insight description"), name);
      assert.ok(!s.speech.includes("Then more synthetic words"), name);
    }
  });

  it("paraphrases as one sentence of the short summary, cut to 20 words", () => {
    assert.equal(paraphrase(SHORT), "Synthetic chat about lighthouse keeping");
    assert.equal(paraphrase("First part. / Second part."), "First part");
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    assert.equal(paraphrase(long).split(" ").length, 20);
    assert.equal(paraphrase(null), "");
  });

  it("escapes SSML in everything spoken", () => {
    assert.equal(escapeSsml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
    const s = renderAgendaAdded("Synthetic <tag> & more", coaching, false, "Want the agenda?");
    assert.ok(s.speech.includes("Synthetic &lt;tag&gt; &amp; more"), s.speech);
    assert.ok(!/[<>]/.test(s.speech));
    const r = renderReview({ ...review, sessions: [{ ...review.sessions[0], guess: "Synthetic <b> & co" }] }, all, false, "Next?", NOW);
    assert.ok(!/[<>]/.test(r.speech) && r.speech.includes("&amp;"), r.speech);
    // Series names and agenda items come from the store, so they're escaped too.
    const odd: Series = { ...coaching, name: "Synthetic R&D <x>", spokenNames: ["synthetic r&d <x>"] };
    const items = { ...agenda, items: [{ ...agenda.items[0], text: "Synthetic a<b & c>d" }] };
    for (const [name, s] of Object.entries({ ...everything(odd, false), storeList: renderAgendaList(items, odd, false, "Next?") })) {
      const said = `${s.speech} ${s.reprompt ?? ""}`;
      assert.ok(!/[<>]|&(?!amp;|lt;|gt;)/.test(said), `${name}: ${said}`);
    }
    assert.ok(everything(odd, false).next.speech.includes("synthetic r&amp;d &lt;x&gt;"));
  });

  it("keeps free text to one sentence", () => {
    const s = renderAgendaAdded("Synthetic one. Two? Three! Four.", coaching, false, "Want the agenda?");
    assert.equal(sentenceCount(s.speech), 2, s.speech);
  });

  it("asks which series without naming discreet ones", () => {
    const ask = "Which series? Your series: Weekly therapy, Coaching.";
    assert.match(renderWhichSeries(ask, false).speech, /Weekly therapy/);
    assert.doesNotMatch(renderWhichSeries(ask, true).speech, /therapy|Coaching/);
  });
});
