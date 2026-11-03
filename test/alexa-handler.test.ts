import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { ResponseEnvelope } from "ask-sdk-model";
import { runAlexa, type AlexaConfig } from "../src/alexa/handler.js";
import { menuSentence, REFUSAL } from "../src/alexa/speech.js";
import { choose } from "../src/choose.js";
import { BOUNDARY } from "../src/mcp/capabilities.js";
import { openAgenda } from "../src/store/agenda.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import type { SessionStore } from "../src/store/types.js";
import {
  conversation,
  dynamicSlot,
  endedRequest,
  envelope,
  type EnvelopeOptions,
  intentRequest,
  launchRequest,
  SKILL_ID,
  spoken,
  staticSlot,
  USER_ID,
} from "./fixtures/alexa.js";
import { coaching, therapy } from "./fixtures/meeting-types.js";
import { COACHING, seed } from "./fixtures/review-seed.js";

let store: TableStore;
let config: AlexaConfig;

beforeEach(async () => {
  store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-alexa-")), "store.json"));
  await seed(store);
  config = { store, skillId: SKILL_ID, userIds: [USER_ID] };
});

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const open = async (seriesId: string) => openAgenda(await store.listAgenda(seriesId), await store.getLatestSession(seriesId));

function assertVoiceOnly(r: ResponseEnvelope) {
  assert.equal(r.response.card, undefined);
  assert.equal(r.response.outputSpeech?.type, "SSML");
}

describe("Alexa handler: guards", () => {
  // A store that fails on any use: refusals must not touch it.
  const untouchable = new Proxy({} as SessionStore, {
    get: () => {
      throw new Error("store touched");
    },
  });

  const cases: [string, EnvelopeOptions, Partial<AlexaConfig>][] = [
    ["another skill ID", { skillId: "amzn1.ask.skill.someone-else" }, {}],
    ["an unknown user", { userId: "amzn1.ask.account.STRANGER" }, {}],
    ["no skill ID configured", {}, { skillId: "" }],
    ["no user IDs configured", {}, { userIds: [] }],
    ["blank user IDs configured", {}, { userIds: [" ", ""] }],
  ];
  for (const [why, opts, cfg] of cases) {
    it(`refuses ${why}, ends the session and touches no data`, async () => {
      const res = await runAlexa(envelope(intentRequest("ListAgendaIntent"), opts), {
        store: untouchable,
        skillId: SKILL_ID,
        userIds: [USER_ID],
        ...cfg,
      });
      assert.equal(res.outcome, "refused");
      assert.equal(spoken(res.response), REFUSAL);
      assert.equal(res.response.response.shouldEndSession, true);
      assert.equal(res.response.sessionAttributes, undefined);
      assert.equal(res.response.response.reprompt, undefined);
      assertVoiceOnly(res.response);
    });
  }

  it("checks the user in both the session and the context", async () => {
    const env = envelope(launchRequest());
    env.context.System.user.userId = "amzn1.ask.account.STRANGER";
    assert.equal((await runAlexa(env, config)).outcome, "refused");
  });
});

describe("Alexa handler: every intent", () => {
  it("greets on launch with the menu and loads your series as dynamic entities", async () => {
    const res = await runAlexa(envelope(launchRequest(), { isNew: true }), config);
    assert.equal(res.outcome, "ok");
    const r = res.response;
    assert.ok(spoken(r).includes(menuSentence()), spoken(r));
    assert.equal(r.response.shouldEndSession, false);
    assert.ok(r.response.reprompt);
    const [directive] = r.response.directives ?? [];
    assert.equal(directive?.type, "Dialog.UpdateDynamicEntities");
    if (directive?.type !== "Dialog.UpdateDynamicEntities") return;
    assert.equal(directive.updateBehavior, "REPLACE");
    const [type] = directive.types!;
    assert.equal(type.name, "SERIES");
    const ids = (await store.listSeries()).map((s) => s.id).sort();
    assert.deepEqual(type.values.map((v) => v.id).sort(), ids);
    const t = type.values.find((v) => v.id === therapy.id)!;
    assert.deepEqual(t.name, { value: therapy.name, synonyms: ["therapy"] });
  });

  it("loads dynamic entities on the first request of a one-shot session only", async () => {
    const first = await runAlexa(envelope(intentRequest("NextSessionIntent"), { isNew: true }), config);
    assert.equal(first.response.response.directives?.[0]?.type, "Dialog.UpdateDynamicEntities");
    const later = await runAlexa(envelope(intentRequest("NextSessionIntent")), config);
    assert.equal(later.response.response.directives, undefined);
  });

  it("answers help with the menu and fallback with the boundary", async () => {
    const c = conversation(config);
    assert.ok((await c.say("AMAZON.HelpIntent")).startsWith(menuSentence()));
    assert.ok(unescape(await c.say("AMAZON.FallbackIntent")).startsWith(BOUNDARY));
    assert.ok((await c.say("AMAZON.YesIntent")).startsWith(menuSentence()), "yes to 'want to hear what you can ask?'");
  });

  it("ends the session on stop, cancel and navigate home, and answers session end with nothing", async () => {
    for (const name of ["AMAZON.StopIntent", "AMAZON.CancelIntent", "AMAZON.NavigateHomeIntent"]) {
      const r = (await runAlexa(envelope(intentRequest(name)), config)).response;
      assert.equal(r.response.shouldEndSession, true, name);
      assert.equal(r.response.reprompt, undefined, name);
    }
    const ended = await runAlexa(envelope(endedRequest()), config);
    assert.deepEqual(ended.response, { version: "1.0", response: {} });
  });

  it("gives the prep brief for a named series and remembers it", async () => {
    const c = conversation(config);
    const said = await c.say("PrepBriefIntent", { series: "coaching" });
    assert.match(said, /^Your last Coaching session was Thursday, October 15: Synthetic short 900111\./);
    assert.match(said, /You have 1 agenda item: Synthetic: bring up the trip\./);
    assert.equal(c.attributes.series, coaching.id);
    // The agenda intents take no series; the one you named is used.
    assert.match(await c.say("AddAgendaItemIntent", { item: "synthetic budget" }), /^Added to Coaching: synthetic budget\./);
    assert.deepEqual((await open(coaching.id)).map((i) => i.text), ["Synthetic: bring up the trip", "synthetic budget"]);
  });

  it("resolves the series from a dynamic entity, a static value or the words heard", async () => {
    const c = conversation(config);
    assert.match(await c.say("NextSessionIntent", { series: dynamicSlot("my synthetic thing", therapy.id) }), /^Your next therapy session is /);
    assert.equal(c.attributes.series, therapy.id);
    assert.match(await c.say("NextSessionIntent", { series: staticSlot("coach", "coaching") }), /^Your next Coaching session is /);
    assert.match(await c.say("LastSessionIntent", { series: "acme" }), /^There's no Acme interview session recorded yet\./);
    assert.match(await c.say("NextSessionIntent", { series: "zork" }), /^I don't know a series called zork\./);
  });

  it("uses the series from the session attributes, else the usual default", async () => {
    const remembered = conversation(config, { series: therapy.id });
    assert.match(await remembered.say("AddAgendaItemIntent", { item: "synthetic walk" }), /^Added to therapy: synthetic walk\./);
    assert.ok((await open(therapy.id)).some((i) => i.text === "synthetic walk"));

    const fresh = conversation(config);
    const expected = (await choose(store, undefined, "next"))!.series!;
    const said = await fresh.say("AddAgendaItemIntent", { item: "synthetic default" });
    assert.ok(said.startsWith(`Added to ${expected.spokenNames[0] ?? expected.name}: synthetic default.`), said);
    assert.ok((await open(expected.id)).some((i) => i.text === "synthetic default"));
    assert.equal(fresh.attributes.series, undefined, "a default isn't remembered");
  });

  it("lists the agenda numbered and removes by the number you heard", async () => {
    const c = conversation(config, { series: coaching.id });
    await c.say("AddAgendaItemIntent", { item: "synthetic second" });
    await c.say("AddAgendaItemIntent", { item: "synthetic third" });
    const list = await c.say("ListAgendaIntent");
    assert.match(list, /^You have 3 items on your Coaching agenda\. Number one, Synthetic: bring up the trip; number two, synthetic second; number three, synthetic third\./);
    assert.match(await c.say("RemoveAgendaItemIntent", { n: "2" }), /^Removed from Coaching: synthetic second\./);
    // Numbers stay as you heard them.
    assert.match(await c.say("RemoveAgendaItemIntent", { n: "3" }), /^Removed from Coaching: synthetic third\./);
    assert.match(await c.say("RemoveAgendaItemIntent", { n: "2" }), /no longer on your agenda/);
    assert.match(await c.say("RemoveAgendaItemIntent", { n: "7" }), /^There's no number 7 on the list I read\./);
    assert.deepEqual((await open(coaching.id)).map((i) => i.text), ["Synthetic: bring up the trip"]);
  });

  it("asks for the list before removing by number, and removes by words", async () => {
    const c = conversation(config);
    assert.match(await c.say("RemoveAgendaItemIntent", { n: "1" }), /^Ask what's on your agenda first/);
    const named = conversation(config, { series: coaching.id });
    assert.match(await named.say("RemoveAgendaItemIntent", { item: "zork" }), /^Nothing on your Coaching agenda matches zork\./);
    assert.match(await named.say("RemoveAgendaItemIntent", { item: "the trip" }), /^Removed from Coaching: Synthetic: bring up the trip\./);
    assert.deepEqual(await open(coaching.id), []);
    assert.match(await named.say("ListAgendaIntent"), /^Your Coaching agenda is empty\./);
  });

  it("says what's happened since the last session, from the digest", async () => {
    const c = conversation(config);
    assert.match(await c.say("SinceLastSessionIntent", { series: "coaching" }), /^There's nothing to count yet for Coaching\./);
    await store.putDigest({
      seriesId: coaching.id,
      computedAt: new Date().toISOString(),
      since: "2026-10-15T20:55:00.000Z",
      conversations: 38,
      todos: 2,
      insightTitles: ["Synthetic insight title"],
      topics: [{ word: "synthetic-topic", count: 3 }],
      partial: false,
    });
    const said = await c.say("SinceLastSessionIntent", { series: "coaching" });
    assert.match(said, /^It's been \d+ days and 38 conversations\. From last session, synthetic-topic 3 times came up again\./);
    assert.ok(!said.includes("Synthetic insight title"));
    assert.match(await c.say("SinceLastSessionIntent", { series: "other" }), /off for Other/);
  });

  it("paraphrases the last session in one sentence", async () => {
    const said = await conversation(config).say("LastSessionIntent", { series: "coaching" });
    assert.match(said, /^Your last Coaching session was Thursday, October 15, for 53 minutes: Synthetic short 900111\./);
    assert.ok(!said.includes("Synthetic long summary"));
  });

  it("saves a takeaway on the latest session and reads it back", async () => {
    const c = conversation(config, { series: coaching.id });
    assert.match(await c.say("SaveTakeawayIntent", { takeaway: "synthetic delegate earlier" }), /^Saved for Coaching: synthetic delegate earlier\./);
    assert.deepEqual((await store.listTakeaways(coaching.id, COACHING)).map((t) => t.text), ["synthetic delegate earlier"]);
    const none = conversation(config, { series: "acme-interview" });
    assert.match(await none.say("SaveTakeawayIntent", { takeaway: "synthetic x" }), /^There's no Acme interview session to attach a takeaway to yet\./);
    assert.match(await c.say("SaveTakeawayIntent"), /^I didn't catch the takeaway\./);
  });

  it("lists the review queue", async () => {
    const c = conversation(config);
    const said = await c.say("ReviewIntent");
    assert.match(said, /^2 guesses are waiting; the first is a 45-minute conversation on .+, guessed as Acme interview\./);
    assert.deepEqual(c.attributes.review?.map((r) => r.id), ["acme-interview@2026-10-19T15:00:00.000Z", "other@2026-10-21T18:00:00.000Z"]);
  });

  it("follows yes to a question with what it offered", async () => {
    const c = conversation(config, { series: coaching.id });
    await c.say("AddAgendaItemIntent", { item: "synthetic yes" });
    assert.match(await c.say("AMAZON.YesIntent"), /^You have 2 items on your Coaching agenda\./);
    assert.match(await c.say("AMAZON.YesIntent"), /^Your last Coaching session was/, "yes to 'want your prep brief too?'");
    assert.match(await c.say("AMAZON.YesIntent"), /^Say add, then the item, to my agenda\./);
    assert.match(await c.say("AMAZON.NoIntent"), /^OK\./);
  });

  it("keeps the session open with a question reprompt, and never sends a card", async () => {
    const c = conversation(config);
    await c.send(launchRequest());
    for (const [name, slots] of [
      ["AMAZON.HelpIntent", {}],
      ["PrepBriefIntent", { series: "therapy" }],
      ["NextSessionIntent", {}],
      ["SinceLastSessionIntent", {}],
      ["LastSessionIntent", {}],
      ["ListAgendaIntent", {}],
      ["AddAgendaItemIntent", { item: "synthetic one" }],
      ["RemoveAgendaItemIntent", { n: "1" }],
      ["SaveTakeawayIntent", { takeaway: "synthetic two" }],
      ["ReviewIntent", {}],
      ["AMAZON.FallbackIntent", {}],
    ] as const) {
      const r = await c.send(intentRequest(name, slots));
      assert.equal(r.response.shouldEndSession, false, name);
      const reprompt = r.response.reprompt?.outputSpeech;
      assert.ok(reprompt?.type === "SSML" && reprompt.ssml.endsWith("?</speak>"), name);
    }
    for (const r of c.responses) assertVoiceOnly(r);
  });

  it("turns a failing store into a spoken error, not an exception", async () => {
    const broken = new Proxy(store, {
      get: (target, key) =>
        key === "getLatestSession" ? async () => Promise.reject(new Error("synthetic failure")) : Reflect.get(target, key, target),
    });
    const res = await runAlexa(envelope(intentRequest("LastSessionIntent", { series: "coaching" })), { ...config, store: broken });
    assert.equal(res.outcome, "error");
    assert.match(spoken(res.response), /^Sorry, something went wrong on my side\./);
    assert.equal(res.response.response.shouldEndSession, false);
  });
});

describe("Alexa handler: discreet series", () => {
  it("gives discreet answers end to end", async () => {
    await store.putSeries({ ...therapy, discreet: true });
    const c = conversation(config);
    const said = [
      await c.say("PrepBriefIntent", { series: "therapy" }),
      await c.say("NextSessionIntent"),
      await c.say("LastSessionIntent"),
      await c.say("AddAgendaItemIntent", { item: "synthetic private worry" }),
      await c.say("ListAgendaIntent"),
      await c.say("RemoveAgendaItemIntent", { n: "1" }),
      await c.say("SaveTakeawayIntent", { takeaway: "synthetic private takeaway" }),
      await c.say("ReviewIntent"),
    ];
    assert.match(said[0], /^Your Tuesday session is .+\. You have 1 agenda item\. The details are in Claude\.$/);
    assert.match(said[2], /^It was on .+\. The summary is in Claude\./);
    assert.match(said[3], /^Added to your agenda\./);
    assert.match(said[4], /^You have 2 items on your agenda\./);
    assert.match(said[5], /^Removed from your agenda\./);
    assert.match(said[6], /^Saved your takeaway\./);
    assert.match(said[7], /^2 sessions need review\. The details are in Claude\./);
    for (const s of said) {
      for (const secret of ["therapy", "Weekly", "sleep", "private", "Synthetic short", "Acme"]) {
        assert.ok(!s.toLowerCase().includes(secret.toLowerCase()), `"${secret}" in: ${s}`);
      }
    }
    const reprompts = c.responses.map((r) => (r.response.reprompt?.outputSpeech as { ssml?: string } | undefined)?.ssml ?? "");
    for (const r of reprompts) assert.ok(!r.toLowerCase().includes("therapy"), r);
    // The writes landed where they should.
    assert.deepEqual((await open(therapy.id)).map((i) => i.text), ["synthetic private worry"]);
  });

  it("keeps discreet series' names out of the launch receipt", async () => {
    await store.putSeries({ ...coaching, discreet: true });
    await store.putJournalRecord({ journalId: "jrnl-synthetic-7777", at: new Date(Date.now() - 3_600_000).toISOString(), kind: "start", status: "filed", seriesId: coaching.id });
    const said = spoken((await runAlexa(envelope(launchRequest()), config)).response);
    assert.match(said, /^Got it: session started /);
    assert.ok(!said.includes("Coaching"), said);
  });
});
