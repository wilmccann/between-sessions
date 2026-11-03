import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BetweenSessionsStack } from "../infra/stack.js";
import { targets } from "../src/aws/kill-switch.js";
import { fileStore } from "../src/store/file-store.js";
import { envelope, intentRequest, SKILL_ID, USER_ID } from "./fixtures/alexa.js";
import { seed } from "./fixtures/review-seed.js";

const SYNTHETIC_SKILL = "amzn1.ask.skill.00000000-synthetic-stack";
const SYNTHETIC_USERS = "amzn1.ask.account.SYNTHETIC1,amzn1.ask.account.SYNTHETIC2";

// No asset bundling, so it runs fast and offline.
function synth(context: Record<string, string> = {}) {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [], ...context } });
  const stack = new BetweenSessionsStack(app, "BetweenSessions", { env: { account: "111111111111", region: "us-east-1" } });
  return Template.fromStack(stack);
}

const alexaFunctions = (t: Template) => t.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "between-sessions-alexa" } });

describe("Alexa infrastructure", () => {
  const saved = { skill: process.env.ALEXA_SKILL_ID, users: process.env.ALEXA_USER_IDS };
  beforeEach(() => {
    delete process.env.ALEXA_SKILL_ID;
    delete process.env.ALEXA_USER_IDS;
  });
  afterEach(() => {
    if (saved.skill === undefined) delete process.env.ALEXA_SKILL_ID;
    else process.env.ALEXA_SKILL_ID = saved.skill;
    if (saved.users === undefined) delete process.env.ALEXA_USER_IDS;
    else process.env.ALEXA_USER_IDS = saved.users;
  });

  it("adds no Alexa function without a skill ID", () => {
    const t = synth();
    assert.equal(Object.keys(alexaFunctions(t)).length, 0);
    assert.equal(Object.keys(t.findOutputs("AlexaFunctionArn")).length, 0);
    t.resourcePropertiesCountIs("AWS::Lambda::Permission", { Principal: "alexa-appkit.amazon.com" }, 0);
  });

  it("adds the function, its environment, the skill-only permission and the output from context", () => {
    const t = synth({ alexaSkillId: SYNTHETIC_SKILL, alexaUserIds: SYNTHETIC_USERS });
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "between-sessions-alexa",
      MemorySize: 256,
      Timeout: 7,
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Environment: {
        Variables: Match.objectLike({ ALEXA_SKILL_ID: SYNTHETIC_SKILL, ALEXA_USER_IDS: SYNTHETIC_USERS, TABLE_NAME: Match.anyValue() }),
      },
    });
    t.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "alexa-appkit.amazon.com",
      EventSourceToken: SYNTHETIC_SKILL,
    });
    assert.equal(Object.keys(t.findOutputs("AlexaFunctionArn")).length, 1);
    // Granted the table, like the MCP server.
    const [logicalId] = Object.keys(alexaFunctions(t));
    const role = (alexaFunctions(t)[logicalId].Properties.Role["Fn::GetAtt"] as string[])[0];
    const policies = t.findResources("AWS::IAM::Policy", { Properties: { Roles: [{ Ref: role }] } });
    const actions = JSON.stringify(Object.values(policies).map((p) => p.Properties.PolicyDocument));
    assert.match(actions, /dynamodb:PutItem/);
    assert.match(actions, /dynamodb:Query/);
  });

  it("reads the IDs from the environment when no context is given", () => {
    process.env.ALEXA_SKILL_ID = SYNTHETIC_SKILL;
    process.env.ALEXA_USER_IDS = SYNTHETIC_USERS;
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Permission", { Principal: "alexa-appkit.amazon.com", EventSourceToken: SYNTHETIC_SKILL });
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "between-sessions-alexa",
      Environment: { Variables: Match.objectLike({ ALEXA_USER_IDS: SYNTHETIC_USERS }) },
    });
  });

  it("is covered by the kill switch's prefix", () => {
    assert.deepEqual(targets(["between-sessions-alexa", "unrelated"], ["between-sessions-"]), ["between-sessions-alexa"]);
  });
});

describe("Alexa Lambda entry", () => {
  it("logs one JSON line per request without slot values, speech or user IDs", async () => {
    const { makeHandler, userIdsFrom } = await import("../src/aws/alexa-handler.js");
    assert.deepEqual(userIdsFrom(" a, b ,,c "), ["a", "b", "c"]);
    assert.deepEqual(userIdsFrom(undefined), []);
    const store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-alexa-entry-")), "store.json"));
    await seed(store);
    const lines: string[] = [];
    const handler = makeHandler({ store, skillId: SKILL_ID, userIds: [USER_ID] }, (l) => lines.push(l));
    const secret = "synthetic secret agenda words";
    const res = await handler(envelope(intentRequest("AddAgendaItemIntent", { item: secret }), { attributes: { series: "coaching" } }));
    assert.ok(JSON.stringify(res).includes(secret), "the answer reads it back");
    await handler(envelope(intentRequest("ListAgendaIntent"), { userId: "amzn1.ask.account.STRANGER" }));
    assert.equal(lines.length, 2);
    const [ok, refused] = lines.map((l) => JSON.parse(l));
    assert.deepEqual(Object.keys(ok).sort(), ["intent", "ms", "outcome", "requestType"]);
    assert.equal(ok.intent, "AddAgendaItemIntent");
    assert.equal(ok.outcome, "ok");
    assert.equal(refused.outcome, "refused");
    for (const l of lines) {
      assert.ok(!l.includes(secret) && !l.includes("Added") && !l.includes(USER_ID) && !l.includes("STRANGER"), l);
    }
  });
});
