import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommand } from "../src/commands.js";
import { meetingTypes } from "./fixtures/meeting-types.js";

const parse = (text: string) => parseCommand(text, meetingTypes);

describe("parseCommand: session markers", () => {
  it("reads start and end, with or without a series", () => {
    assert.deepEqual(parse("Start session."), { kind: "start" });
    assert.deepEqual(parse("Start coaching session."), { kind: "start", series: "coaching" });
    assert.deepEqual(parse("Start session: Acme interview"), { kind: "start", series: "Acme interview" });
    assert.deepEqual(parse("start session akme interview"), { kind: "start", series: "akme interview" });
    assert.deepEqual(parse("Start coaching"), { kind: "start", series: "coaching" });
    assert.deepEqual(parse("End coaching session."), { kind: "end", series: "coaching" });
    assert.deepEqual(parse("End session"), { kind: "end" });
  });

  it("forgives transcription slips", () => {
    assert.deepEqual(parse("And session."), { kind: "end" });
    assert.deepEqual(parse("Um, ending the session"), { kind: "end" });
    assert.deepEqual(parse("Stat session"), { kind: "start" });
    assert.deepEqual(parse("Okay. Start a new session with Globex."), { kind: "start", series: "Globex" });
  });

  it("leaves ordinary notes alone", () => {
    assert.equal(parse("Start the dishwasher when you get home"), null);
    assert.equal(parse("And then we went to the synthetic park"), null);
    assert.equal(parse("Stop by the store for milk"), null);
    assert.equal(parse("Start thinking about what the session next week should cover for real"), null);
    assert.equal(parse("Remember to call the plumber"), null);
    assert.equal(parse("That was fun"), null);
  });
});

describe("parseCommand: filing", () => {
  it("reads debriefs, agenda items and takeaways in your words", () => {
    assert.deepEqual(parse("Debrief: it went well, synthetic notes."), { kind: "debrief", text: "it went well, synthetic notes" });
    assert.deepEqual(parse("The brief, short synthetic one"), { kind: "debrief", text: "short synthetic one" });
    assert.deepEqual(parse("Agenda: the work trip."), { kind: "agenda", text: "the work trip" });
    assert.deepEqual(parse("Agenda for therapy: sleep"), { kind: "agenda", text: "sleep", series: "therapy" });
    assert.deepEqual(parse("For therapy: the synthetic move"), { kind: "agenda", text: "the synthetic move", series: "therapy" });
    assert.deepEqual(parse("Add the offsite to my coaching agenda"), { kind: "agenda", text: "the offsite", series: "coaching" });
    assert.deepEqual(parse("Takeaway: delegate earlier."), { kind: "takeaway", text: "delegate earlier" });
    assert.deepEqual(parse("Take away for Acme: ask about team size"), { kind: "takeaway", text: "ask about team size", series: "Acme" });
  });

  it("reads removals", () => {
    assert.deepEqual(parse("Drop the work trip from my agenda"), { kind: "drop", text: "the work trip" });
    assert.deepEqual(parse("Remove sleep from my therapy agenda."), { kind: "drop", text: "sleep", series: "therapy" });
  });

  it("reports a command word with nothing after it", () => {
    assert.equal(parse("Agenda.")?.kind, "unfiled");
    assert.equal(parse("Debrief")?.kind, "unfiled");
    assert.equal(parse("Takeaway:")?.kind, "unfiled");
  });

  it("only treats 'For x:' as agenda when x is a series", () => {
    assert.equal(parse("For dinner: synthetic pasta"), null);
  });
});

describe("parseCommand: review", () => {
  it("reads retags and rejections", () => {
    assert.deepEqual(parse("Retag: last session coaching"), { kind: "retag", series: "coaching" });
    assert.deepEqual(parse("That was Acme."), { kind: "retag", series: "Acme" });
    assert.deepEqual(parse("That was an Acme interview"), { kind: "retag", series: "Acme interview" });
    assert.deepEqual(parse("Not a session."), { kind: "not-session" });
    assert.deepEqual(parse("That wasn't a session"), { kind: "not-session" });
    assert.equal(parse("Retag")?.kind, "unfiled");
  });
});
