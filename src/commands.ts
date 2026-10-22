// Reads a Bee voice note (a journal) as a command. Notes come through speech
// recognition, so command words are matched forgivingly ("and session" for
// "end session", "the brief" for "debrief"), and series names go through
// the fuzzy matcher. A note that isn't a command returns null and is never
// stored; a note that starts like a command but can't be used is "unfiled",
// so it can be reported instead of dropped.
import { matchSeriesName, type Series } from "./series.js";

export type Command =
  | { kind: "start" | "end"; series?: string }
  | { kind: "debrief"; text: string }
  | { kind: "agenda"; text: string; series?: string }
  | { kind: "takeaway"; text: string; series?: string }
  | { kind: "drop"; text: string; series?: string }
  | { kind: "retag"; series: string }
  | { kind: "not-session" }
  | { kind: "unfiled"; reason: string };

const SEP = String.raw`[\s,.:;!-]*`;
const SESSION_WORD = /\b(sessions?|meetings?|calls?|interviews?|appointments?)\b/i;
const FILLER_WORDS = /\b(a|an|the|my|new|with|for|now|please|this|our|last|that|it|as|to|is|was)\b/gi;

// The user's own words after a command: trimmed, one trailing period off.
const words = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.!]$/, "").trim();

// A series name from the rest of a start or end note: "coaching session."
// is "coaching"; "session: Acme interview" is "Acme interview".
function nameFrom(rest: string): string {
  const name = rest
    .replace(/\b(sessions?|meetings?|um+|uh+|er+|hmm+)\b/gi, " ")
    .replace(FILLER_WORDS, " ")
    .replace(/[:.,;!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Too short to be a name: treat it as no name rather than create a series.
  return name.replace(/\s/g, "").length < 3 ? "" : name;
}

const knows = (series: Series[], name: string) => name !== "" && matchSeriesName(series, name).kind !== "none";
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function parseCommand(raw: string, series: Series[] = []): Command | null {
  const text = raw.replace(/^\s*(?:(?:okay|ok|um+|uh+|so|hey bee)\b[\s,.]*)+/i, "").trim();

  let m = /^not an? session\b|^(?:that|this|it) (?:was not|wasn'?t|is not|isn'?t) an? (?:session|meeting)\b|^no session\b/i.exec(text);
  if (m) return { kind: "not-session" };

  // Start and end: short, and either say "session" or name a series.
  m = new RegExp(String.raw`^(start(?:s|ed|ing)?|stat|stark|tart|begin(?:ning)?)\b${SEP}(.*)$`, "is").exec(text);
  const e = new RegExp(String.raw`^(end(?:s|ed|ing)?|and|stop(?:ped)?|finish(?:ed)?|done with)\b${SEP}(.*)$`, "is").exec(text);
  for (const [match, kind] of [
    [m, "start"],
    [e, "end"],
  ] as const) {
    if (!match) continue;
    const rest = match[2];
    if (wordCount(rest) > 6) return null;
    const name = nameFrom(rest);
    const saysSession = SESSION_WORD.test(rest);
    // "And" is a common first word, so it needs "session" to count.
    if (match[1].toLowerCase() === "and" && !/\b(sessions?|meetings?)\b/i.test(rest)) return null;
    if (!saysSession && !knows(series, name)) return null;
    return name ? { kind, series: name } : { kind };
  }

  m = new RegExp(String.raw`^(?:de-?\s?brief(?:ing|ed)?|the brief)\b${SEP}(.*)$`, "is").exec(text);
  if (m) {
    const body = words(m[1]);
    return body ? { kind: "debrief", text: body } : { kind: "unfiled", reason: "debrief with nothing after it" };
  }

  // "Agenda: x", "Agenda for therapy: x", "Add x to my therapy agenda".
  m = new RegExp(String.raw`^(?:add to (?:my |the )?)?(?:agenda|a genda|the agenda)(?: item)?(?:\s+for\s+([^:,.]{1,40}?)\s*[:,;.-]|${SEP})(.*)$`, "is").exec(text);
  if (m) {
    const body = words(m[2]);
    if (!body) return { kind: "unfiled", reason: "agenda with nothing after it" };
    return m[1] ? { kind: "agenda", text: body, series: m[1].trim() } : { kind: "agenda", text: body };
  }
  m = /^add (.+?) to (?:my |the )?(?:([\w ]{1,40}?) )?agenda\W*$/is.exec(text);
  if (m) return m[2] ? { kind: "agenda", text: words(m[1]), series: m[2].trim() } : { kind: "agenda", text: words(m[1]) };

  m = new RegExp(String.raw`^(?:take ?-?aways?)(?:\s+for\s+([^:,.]{1,40}?)\s*[:,;.-]|${SEP})(.*)$`, "is").exec(text);
  if (m) {
    const body = words(m[2]);
    if (!body) return { kind: "unfiled", reason: "takeaway with nothing after it" };
    return m[1] ? { kind: "takeaway", text: body, series: m[1].trim() } : { kind: "takeaway", text: body };
  }

  m = /^(?:drop|remove|delete|scratch|cross off)\s+(.+?)\s+(?:from|off)\s+(?:my |the )?(?:([\w ]{1,40}?) )?agenda\W*$/is.exec(text);
  if (m) return m[2] ? { kind: "drop", text: words(m[1]), series: m[2].trim() } : { kind: "drop", text: words(m[1]) };

  // "For therapy: x" is an agenda item only when "therapy" is a series.
  m = /^for ([^:,.]{1,40})[:,]\s*(.+)$/is.exec(text);
  if (m && knows(series, m[1].trim())) return { kind: "agenda", text: words(m[2]), series: m[1].trim() };

  m = new RegExp(String.raw`^re-?\s?tag\b${SEP}(.*)$`, "is").exec(text);
  if (m) {
    const name = nameFrom(m[1]);
    return name ? { kind: "retag", series: name } : { kind: "unfiled", reason: "retag without a series" };
  }
  m = /^(?:that|this|it) (?:was|is) (?:an? |my )?(.+?)\W*$/is.exec(text);
  if (m) {
    const name = nameFrom(m[1]);
    if (wordCount(name) <= 4 && (knows(series, name) || SESSION_WORD.test(m[1]))) return { kind: "retag", series: name };
  }
  return null;
}
