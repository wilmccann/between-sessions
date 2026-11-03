// Throwaway spike for docs/ALEXA_PLAN.md, step 1: does a development-stage
// skill open on the phone, and how well does Alexa hear free text? Paste over
// lambda/index.js in an Alexa-hosted (Node.js) skill. It only echoes what it
// heard, stores nothing, logs nothing and sends no cards. Use synthetic phrases.
const Alexa = require("ask-sdk-core");

const MORE = "Try another, or say stop.";
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slot = (input, name) => escape(Alexa.getSlotValue(input.requestEnvelope, name) || "nothing");
const isIntent = (input, ...names) =>
  Alexa.getRequestType(input.requestEnvelope) === "IntentRequest" &&
  names.includes(Alexa.getIntentName(input.requestEnvelope));
const say = (input, speech, reprompt) => {
  const r = input.responseBuilder.speak(speech);
  return (reprompt ? r.reprompt(reprompt) : r.withShouldEndSession(true)).getResponse();
};

const handlers = [
  {
    canHandle: (input) => Alexa.getRequestType(input.requestEnvelope) === "LaunchRequest",
    handle: (input) => say(input, "Hello spike is working. Say: add the work trip to my agenda.", MORE),
  },
  {
    canHandle: (input) => isIntent(input, "HelloIntent"),
    handle: (input) => say(input, "Hi from the spike.", MORE),
  },
  {
    canHandle: (input) => isIntent(input, "AgendaIntent"),
    handle: (input) => say(input, `Agenda. I heard: ${slot(input, "item")}.`, MORE),
  },
  {
    canHandle: (input) => isIntent(input, "TakeawayIntent"),
    handle: (input) => say(input, `Takeaway. I heard: ${slot(input, "takeaway")}.`, MORE),
  },
  {
    canHandle: (input) => isIntent(input, "AMAZON.HelpIntent"),
    handle: (input) => say(input, "Say: add something to my agenda, or save a takeaway, then what it is.", MORE),
  },
  {
    canHandle: (input) => isIntent(input, "AMAZON.FallbackIntent"),
    handle: (input) => say(input, "That didn't match an agenda or takeaway phrase.", MORE),
  },
  {
    canHandle: (input) => isIntent(input, "AMAZON.StopIntent", "AMAZON.CancelIntent", "AMAZON.NavigateHomeIntent"),
    handle: (input) => say(input, "Bye."),
  },
  {
    canHandle: (input) => Alexa.getRequestType(input.requestEnvelope) === "SessionEndedRequest",
    handle: (input) => input.responseBuilder.getResponse(),
  },
];

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(...handlers)
  .addErrorHandlers({
    canHandle: () => true,
    handle: (input) => say(input, "The spike hit an error.", MORE),
  })
  .lambda();
