import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { INTENT_NAMES, SERIES_TYPE } from "../src/alexa/intents.js";

interface ModelIntent {
  name: string;
  slots?: { name: string; type: string }[];
  samples: string[];
}

const MODEL_FILE = "alexa/skill-package/interactionModels/custom/en-US.json";
const model = JSON.parse(readFileSync(MODEL_FILE, "utf8")).interactionModel.languageModel as {
  invocationName: string;
  intents: ModelIntent[];
  types: { name: string; values: { id: string; name: { value: string; synonyms?: string[] } }[] }[];
};
const custom = model.intents.filter((i) => !i.name.startsWith("AMAZON."));
const slotsIn = (sample: string) => [...sample.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

describe("Alexa interaction model", () => {
  it("is named between sessions", () => {
    assert.equal(model.invocationName, "between sessions");
  });

  it("has exactly the intents the handler handles", () => {
    assert.deepEqual(model.intents.map((i) => i.name).sort(), [...INTENT_NAMES].sort());
  });

  it("has 8 to 15 samples for every custom intent", () => {
    for (const i of custom) assert.ok(i.samples.length >= 8 && i.samples.length <= 15, `${i.name}: ${i.samples.length}`);
  });

  it("declares every slot a sample uses on its intent", () => {
    for (const i of model.intents) {
      const declared = new Set((i.slots ?? []).map((s) => s.name));
      for (const s of i.samples) for (const slot of slotsIn(s)) assert.ok(declared.has(slot), `${i.name}: "${s}"`);
    }
  });

  it("never puts a phrase slot with another slot in one sample", () => {
    for (const i of model.intents) {
      const phrase = new Set((i.slots ?? []).filter((s) => s.type === "AMAZON.SearchQuery").map((s) => s.name));
      for (const s of i.samples) {
        const used = slotsIn(s);
        if (used.some((u) => phrase.has(u))) assert.equal(used.length, 1, `${i.name}: "${s}"`);
        if (used.some((u) => phrase.has(u))) assert.ok(s.replace(/\{\w+\}/g, "").trim().length > 0, `${i.name}: "${s}" needs a carrier phrase`);
      }
    }
  });

  it("has no bare takeaway sample (it failed by voice in spike 2)", () => {
    for (const i of model.intents) for (const s of i.samples) assert.ok(!/^takeaway \{/i.test(s), `${i.name}: "${s}"`);
  });

  it("holds only generic series values", () => {
    const series = model.types.find((t) => t.name === SERIES_TYPE)!;
    assert.deepEqual(series.values.map((v) => v.id).sort(), ["coaching", "interview", "other", "therapy"]);
    assert.deepEqual(series.values.map((v) => v.name.value).sort(), ["coaching", "interview", "other", "therapy"]);
  });

  it("uses samples only once across intents, in plain words", () => {
    const seen = new Map<string, string>();
    for (const i of model.intents) {
      for (const s of i.samples) {
        const key = s.toLowerCase();
        assert.ok(!seen.has(key), `"${s}" is in ${seen.get(key)} and ${i.name}`);
        seen.set(key, i.name);
        assert.match(s, /^[a-z' {}]+$/i, `${i.name}: "${s}"`);
      }
    }
  });

  it("removes by number and by words in separate samples", () => {
    const remove = model.intents.find((i) => i.name === "RemoveAgendaItemIntent")!;
    assert.ok(remove.samples.includes("remove number {n}"));
    assert.ok(remove.samples.includes("remove {item} from my agenda"));
    assert.deepEqual(Object.fromEntries((remove.slots ?? []).map((s) => [s.name, s.type])), { n: "AMAZON.NUMBER", item: "AMAZON.SearchQuery" });
  });

  it("has a skill manifest with a placeholder endpoint and no account linking", () => {
    const skill = JSON.parse(readFileSync("alexa/skill-package/skill.json", "utf8")).manifest;
    assert.equal(skill.publishingInformation.locales["en-US"].name, "Between Sessions");
    assert.equal(skill.apis.custom.endpoint.uri, "REPLACE_WITH_AlexaFunctionArn");
    assert.equal(skill.accountLinking, undefined);
  });
});
