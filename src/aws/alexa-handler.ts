// The Alexa skill's Lambda: invoked by the Alexa service (only our skill ID
// may invoke it; see infra/stack.ts), answered from DynamoDB by
// src/alexa/handler.ts. The handler also checks the skill ID and your Alexa
// user ID (ALEXA_SKILL_ID, ALEXA_USER_IDS comma-separated) and refuses
// everything when either is missing.
//
// One log line per request: the request type, intent name, outcome and
// duration. Never slot values, speech, summaries or user IDs.
import type { RequestEnvelope, ResponseEnvelope } from "ask-sdk-model";
import { runAlexa, type AlexaConfig } from "../alexa/handler.js";
import { dynamoStore } from "../store/dynamo-store.js";

export const userIdsFrom = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function makeHandler(config: AlexaConfig, log: (line: string) => void = console.log) {
  return async (event: RequestEnvelope): Promise<ResponseEnvelope> => {
    const started = Date.now();
    const result = await runAlexa(event, config);
    log(
      JSON.stringify({
        requestType: result.requestType,
        intent: result.intent ?? null,
        outcome: result.outcome,
        ms: Date.now() - started,
      }),
    );
    return result.response;
  };
}

export const handler = makeHandler({
  store: dynamoStore(),
  skillId: (process.env.ALEXA_SKILL_ID ?? "").trim(),
  userIds: userIdsFrom(process.env.ALEXA_USER_IDS),
});
