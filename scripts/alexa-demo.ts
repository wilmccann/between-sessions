// Prints a scripted conversation with the Alexa skill on the synthetic demo
// store, through the same handler the Lambda runs. No Alexa or AWS needed.
//
//   yarn demo:alexa              # full answers (the default)
//   yarn demo:alexa --discreet   # as if every series were discreet
//
// Seeds snapshots/demo-store.json if it's missing, then talks to a temporary
// copy of it, so the demo store never changes and every run prints the same
// conversation. --discreet changes the series in memory only.
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResponseEnvelope } from "ask-sdk-model";
import { handleAlexa, type AlexaConfig, type Attributes } from "../src/alexa/handler.js";
import { sentenceCount } from "../src/alexa/speech.js";
import { fileStore } from "../src/store/file-store.js";
import type { SessionStore } from "../src/store/types.js";
import { seedBeeTab, seedDemoDigests } from "../test/fixtures/review-seed.js";

const DEMO_STORE = process.env.STORE_FILE ?? "snapshots/demo-store.json";
const discreet = process.argv.includes("--discreet");

// Made up: the handler only answers these.
const SKILL_ID = "amzn1.ask.skill.00000000-demo";
const USER_ID = "amzn1.ask.account.DEMOUSER";

if (!existsSync(DEMO_STORE)) {
  const fresh = fileStore(DEMO_STORE);
  await seedBeeTab(fresh);
  await seedDemoDigests(fresh);
  console.log(`Wrote ${DEMO_STORE}: synthetic data only.`);
}
const dir = await mkdtemp(join(tmpdir(), "between-sessions-alexa-"));
const copy = join(dir, "store.json");
await copyFile(DEMO_STORE, copy);
const base = fileStore(copy);

// Digests, so "since last session" has something to count, even on a demo
// store seeded before demo:seed wrote them.
await seedDemoDigests(base);

// --discreet: every series reads as discreet; nothing is written.
const store: SessionStore = discreet
  ? new Proxy(base, {
      get(target, key, receiver) {
        if (key === "listSeries") return async () => (await target.listSeries()).map((s) => ({ ...s, discreet: true }));
        if (key === "getSeries") return async (id: string) => {
          const s = await target.getSeries(id);
          return s && { ...s, discreet: true };
        };
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })
  : base;

const config: AlexaConfig = { store, skillId: SKILL_ID, userIds: [USER_ID] };

type Turn = [you: string, request: { type: string; intent?: string; slots?: Record<string, string> }];
const ask = (intent: string, slots: Record<string, string> = {}) => ({ type: "IntentRequest", intent, slots });

const SCRIPT: Turn[] = [
  ["Alexa, open Between Sessions", { type: "LaunchRequest" }],
  ["What can I ask?", ask("AMAZON.HelpIntent")],
  ["Prep me for coaching", ask("PrepBriefIntent", { series: "coaching" })],
  ["What's happened since my last session?", ask("SinceLastSessionIntent")],
  ["When is my next session?", ask("NextSessionIntent")],
  ["What did we cover last session?", ask("LastSessionIntent")],
  ["Add the work trip to my agenda", ask("AddAgendaItemIntent", { item: "the work trip" })],
  ["What's on my agenda?", ask("ListAgendaIntent")],
  ["Remove number two", ask("RemoveAgendaItemIntent", { n: "2" })],
  ["Save a takeaway: delegate earlier", ask("SaveTakeawayIntent", { takeaway: "delegate earlier" })],
  ["Which sessions need review?", ask("ReviewIntent")],
  ["That was coaching", ask("RetagIntent", { series: "coaching" })],
  ["No", ask("AMAZON.NoIntent")],
  ["That wasn't a session", ask("RetagIntent")],
  ["Yes", ask("AMAZON.YesIntent")],
  ["What's the weather?", ask("AMAZON.FallbackIntent")],
  ["Stop", ask("AMAZON.StopIntent")],
];

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const spoken = (r: ResponseEnvelope) => {
  const o = r.response.outputSpeech;
  return o?.type === "SSML" ? unescape(o.ssml.replace(/^<speak>|<\/speak>$/g, "")) : "";
};

let attributes: Attributes = {};
let n = 0;
console.log(`Between Sessions on Alexa, ${discreet ? "discreet" : "full"} answers, synthetic demo store:\n`);
try {
  for (const [you, req] of SCRIPT) {
    n++;
    const application = { applicationId: SKILL_ID };
    const user = { userId: USER_ID };
    const request = {
      type: req.type,
      requestId: `amzn1.echo-api.request.demo-${n}`,
      timestamp: new Date().toISOString(),
      locale: "en-US",
      ...(req.intent && {
        dialogState: "COMPLETED",
        intent: {
          name: req.intent,
          confirmationStatus: "NONE",
          slots: Object.fromEntries(Object.entries(req.slots ?? {}).map(([name, value]) => [name, { name, value, confirmationStatus: "NONE" }])),
        },
      }),
    };
    const envelope = {
      version: "1.0",
      session: { new: n === 1, sessionId: "amzn1.echo-api.session.demo", application, user, attributes },
      context: { System: { application, user, apiEndpoint: "https://api.amazonalexa.com" } },
      request,
    };
    const res = await handleAlexa(envelope as never, config);
    attributes = (res.sessionAttributes ?? {}) as Attributes;
    const said = spoken(res);
    console.log(`You: ${you}`);
    console.log(`Alexa: ${said} (${sentenceCount(said)} sentence${sentenceCount(said) === 1 ? "" : "s"})\n`);
    if (res.response.shouldEndSession) break;
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
