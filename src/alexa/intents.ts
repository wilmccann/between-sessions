// Every intent the skill handles. The handler has one route per name (the
// compiler checks it), and a test checks the interaction model has exactly
// these.
export const INTENT_NAMES = [
  "PrepBriefIntent",
  "SinceLastSessionIntent",
  "NextSessionIntent",
  "LastSessionIntent",
  "AddAgendaItemIntent",
  "ListAgendaIntent",
  "RemoveAgendaItemIntent",
  "SaveTakeawayIntent",
  "ReviewIntent",
  "RetagIntent",
  "AMAZON.HelpIntent",
  "AMAZON.StopIntent",
  "AMAZON.CancelIntent",
  "AMAZON.NavigateHomeIntent",
  "AMAZON.FallbackIntent",
  "AMAZON.YesIntent",
  "AMAZON.NoIntent",
] as const;

export type IntentName = (typeof INTENT_NAMES)[number];

// The custom slot type for series. The model holds only generic values; your
// own series names arrive per session as dynamic entities.
export const SERIES_TYPE = "SERIES";
