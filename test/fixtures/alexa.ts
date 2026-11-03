// Synthetic Alexa request envelopes, shaped like the console simulator's
// JSON Input, and a conversation helper that carries session attributes
// from one response to the next request. Made-up IDs only.
import type { RequestEnvelope, ResponseEnvelope, Slot } from "ask-sdk-model";
import { handleAlexa, type AlexaConfig, type Attributes } from "../../src/alexa/handler.js";

export const SKILL_ID = "amzn1.ask.skill.00000000-synthetic-skill";
export const USER_ID = "amzn1.ask.account.SYNTHETICUSER";

type SlotInput = string | Partial<Slot>;

export interface EnvelopeOptions {
  attributes?: Attributes;
  isNew?: boolean;
  skillId?: string;
  userId?: string;
}

let counter = 0;
const meta = () => ({ requestId: `amzn1.echo-api.request.synthetic-${++counter}`, timestamp: new Date().toISOString(), locale: "en-US" });

export const launchRequest = () => ({ type: "LaunchRequest", ...meta() });
export const endedRequest = () => ({ type: "SessionEndedRequest", reason: "USER_INITIATED", ...meta() });

export function intentRequest(name: string, slots: Record<string, SlotInput> = {}) {
  const full = Object.fromEntries(
    Object.entries(slots).map(([slot, v]) => [
      slot,
      typeof v === "string" ? { name: slot, value: v, confirmationStatus: "NONE" } : { name: slot, confirmationStatus: "NONE", ...v },
    ]),
  );
  return { type: "IntentRequest", dialogState: "COMPLETED", intent: { name, confirmationStatus: "NONE", slots: full }, ...meta() };
}

// A series slot resolved to a dynamic entity (your own series) or a static
// value from the model.
export const dynamicSlot = (value: string, id: string): Partial<Slot> => ({
  value,
  resolutions: {
    resolutionsPerAuthority: [
      { authority: `amzn1.er-authority.echo-sdk.dynamic.${SKILL_ID}.SERIES`, status: { code: "ER_SUCCESS_MATCH" }, values: [{ value: { id, name: value } }] },
      { authority: `amzn1.er-authority.echo-sdk.${SKILL_ID}.SERIES`, status: { code: "ER_SUCCESS_NO_MATCH" }, values: [] },
    ],
  },
});
export const staticSlot = (value: string, name: string): Partial<Slot> => ({
  value,
  resolutions: {
    resolutionsPerAuthority: [
      { authority: `amzn1.er-authority.echo-sdk.dynamic.${SKILL_ID}.SERIES`, status: { code: "ER_SUCCESS_NO_MATCH" }, values: [] },
      { authority: `amzn1.er-authority.echo-sdk.${SKILL_ID}.SERIES`, status: { code: "ER_SUCCESS_MATCH" }, values: [{ value: { id: name, name } }] },
    ],
  },
});

export function envelope(request: object, { attributes = {}, isNew = false, skillId = SKILL_ID, userId = USER_ID }: EnvelopeOptions = {}): RequestEnvelope {
  const application = { applicationId: skillId };
  const user = { userId };
  return {
    version: "1.0",
    session: { new: isNew, sessionId: "amzn1.echo-api.session.synthetic", application, user, attributes },
    context: { System: { application, user, device: { deviceId: "synthetic-device", supportedInterfaces: {} }, apiEndpoint: "https://api.amazonalexa.com" } },
    request,
  } as unknown as RequestEnvelope;
}

// The spoken text of a response, without <speak>.
export const spoken = (r: ResponseEnvelope) => {
  const speech = r.response.outputSpeech;
  return speech?.type === "SSML" ? speech.ssml.replace(/^<speak>|<\/speak>$/g, "") : "";
};

// A conversation: each request carries the attributes the last response set.
export function conversation(config: AlexaConfig, start: Attributes = {}) {
  let attributes: Attributes = start;
  let first = true;
  const responses: ResponseEnvelope[] = [];
  const send = async (request: object) => {
    const res = await handleAlexa(envelope(request, { attributes, isNew: first }), config);
    first = false;
    attributes = (res.sessionAttributes ?? {}) as Attributes;
    responses.push(res);
    return res;
  };
  return {
    send,
    say: async (name: string, slots: Record<string, SlotInput> = {}) => spoken(await send(intentRequest(name, slots))),
    get attributes() {
      return attributes;
    },
    responses,
  };
}
