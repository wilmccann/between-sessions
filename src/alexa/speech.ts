// What the Alexa skill says: one renderer per answer, from the JSON views the
// tools already return. At most three sentences, numbers and dates spoken
// naturally, every write read back, and Bee's text only as one sentence of a
// session's short summary, cut to 20 words. The text is SSML-escaped; the
// handler wraps it in <speak>.
//
// Discreet mode: Alexa+ keeps a text transcript of every exchange for 30 days
// after a chat goes quiet, so a discreet series is spoken as times and counts
// only ("your Tuesday session"), never its name, item text, topics, insight
// titles or summaries. Off by default; turn it on per series with
// `"discreet": true` in its config.
import { BOUNDARY, CAPABILITIES } from "../mcp/capabilities.js";
import type { PrepBriefView, SessionView } from "../mcp/views.js";
import { parseRefId } from "../review.js";
import type { Series } from "../series.js";
import { DAY, localParts, nextSession } from "../time.js";

export const DISCREET_BY_DEFAULT = false;

export const isDiscreet = (series: Pick<Series, "discreet">) => series.discreet ?? DISCREET_BY_DEFAULT;

export interface Speech {
  speech: string; // SSML-escaped, without <speak>
  reprompt?: string; // a short question that keeps the session open
}

// The tools' JSON answers that have no exported view type.
export interface SinceView {
  series: string;
  summary: string;
  lastSessionEndedLocal: string | null;
  conversations: number;
  topics: { word: string; count: number }[];
  insightTitles: string[];
}

export interface AgendaView {
  series: string;
  items: { text: string; createdAt: string; from: string }[];
}

export interface ReviewView {
  line: string | null;
  sessions: {
    id: string;
    when: string;
    durationMinutes: number;
    guess: string;
    filed: boolean;
    expiresInDays: number;
  }[];
}

// --- Building blocks -------------------------------------------------------

export const escapeSsml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// How many sentences a speech has: its ".", "?" and "!" endings.
export const sentenceCount = (s: string) => (s.match(/[.?!](?=\s|$)/g) ?? []).length;

const MAX_SENTENCES = 3;
const MAX_WORDS = 20;

// Free text (an agenda item, a takeaway, a summary) as part of one sentence:
// no sentence endings inside, at most 20 words.
export function phrase(text: string, maxWords = MAX_WORDS): string {
  const words = text
    .replace(/\s+/g, " ")
    .replace(/[.?!]+(?=\s)/g, ",")
    .trim()
    .split(" ")
    .filter(Boolean);
  return words
    .slice(0, maxWords)
    .join(" ")
    .replace(/[\s.?!,;:]+$/, "");
}

// The "paraphrase" of a session: the first sentence of its first short
// summary, cut to 20 words. Never the full summary.
export function paraphrase(shortSummary: string | null | undefined): string {
  const first = (shortSummary ?? "").split(" / ")[0].trim();
  const sentence = first.match(/^.*?[.?!](?=\s|$)/)?.[0] ?? first;
  return phrase(sentence);
}

// Body sentences (each ending in ".", "?" or "!"), then the next step as a
// question when there's room for it. The question is always the reprompt.
function answer(body: (string | null | undefined | false)[], next?: string): Speech {
  const lines = body.filter((l): l is string => Boolean(l));
  if (next && lines.length < MAX_SENTENCES) lines.push(next);
  return { speech: escapeSsml(lines.slice(0, MAX_SENTENCES).join(" ")), reprompt: next ? escapeSsml(next) : undefined };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "5 PM", "4:30 PM", "12 PM".
export function spokenTime(ms: number, timeZone: string): string {
  const { minutes } = localParts(ms, timeZone);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hour = h % 12 || 12;
  return `${m ? `${hour}:${String(m).padStart(2, "0")}` : hour} ${h < 12 ? "AM" : "PM"}`;
}

const dayNumber = (ms: number, timeZone: string) => {
  const p = localParts(ms, timeZone);
  return Math.round(Date.UTC(p.year, p.month - 1, p.day) / DAY);
};

// "today", "tomorrow", "yesterday", "Tuesday" within a week, else
// "Tuesday, November 10".
export function spokenDay(ms: number, timeZone: string, now: number): string {
  const diff = dayNumber(ms, timeZone) - dayNumber(now, timeZone);
  const p = localParts(ms, timeZone);
  const weekday = WEEKDAYS[p.weekday];
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (Math.abs(diff) <= 6) return weekday;
  return `${weekday}, ${MONTHS[p.month - 1]} ${p.day}`;
}

// "Tuesday at 5 PM".
export const spokenWhen = (ms: number, timeZone: string, now: number) =>
  `${spokenDay(ms, timeZone, now)} at ${spokenTime(ms, timeZone)}`;

// Our own short dates ("Thu, Oct 22, 4:32 PM", from formatShort) with the
// day and month spelled out. Only for text we generate, never user text.
export function speakable(s: string): string {
  const full = (names: string[]) => (short: string) => names.find((n) => n.startsWith(short))!;
  return s
    .replace(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/g, full(WEEKDAYS))
    .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, full(MONTHS));
}

// "Thursday, October 15" from formatLocal's "Thursday, October 15, 2026 at 4:02 PM".
const dayOfLocal = (local: string) => local.match(/^[A-Za-z]+, [A-Za-z]+ \d+/)?.[0] ?? local;

// What a series is called in full answers: its first spoken name ("therapy"
// for "Weekly therapy"), else its name.
export const spokenName = (series: Series) => series.spokenNames[0] ?? series.name;

// What a discreet series is called: "your Tuesday session", from its next
// session's weekday, or "your next session" when none is scheduled.
export function discreetLabel(series: Series, now: number): string {
  const next = nextSession(series, now);
  return next ? `your ${WEEKDAYS[localParts(next.start, series.timezone).weekday]} session` : "your next session";
}

// "Your Tuesday session is at 5 PM." Says the day only when the label's
// weekday doesn't already: today, tomorrow, or more than a week out.
function discreetNext(series: Series, nextAt: string | null, now: number): string {
  if (!nextAt) return "Your next session isn't scheduled.";
  const ms = Date.parse(nextAt);
  const label = `your ${WEEKDAYS[localParts(ms, series.timezone).weekday]} session`;
  const day = spokenDay(ms, series.timezone, now);
  const when = WEEKDAYS.includes(day) ? `at ${spokenTime(ms, series.timezone)}` : `${day} at ${spokenTime(ms, series.timezone)}`;
  return `${capital(label)} is ${when}.`;
}

const IN_CLAUDE = "The details are in Claude.";

// --- Menu, help, boundary --------------------------------------------------

// The spoken menu in one sentence, from the capabilities in the menu.
export function menuSentence(): string {
  const labels = CAPABILITIES.filter((c) => c.inMenu).map((c) => c.label);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}` : labels[0];
  return `You can ask me to ${list}.`;
}

const WHAT_NEXT = "What would you like to do?";

export function renderHelp(): Speech {
  return answer([menuSentence()], WHAT_NEXT);
}

export function renderFallback(): Speech {
  return answer([BOUNDARY], "Want to hear what you can ask?");
}

export const REFUSAL = "This skill isn't set up for this account.";
export const GOODBYE = "Goodbye.";

export function renderError(): Speech {
  return answer(["Sorry, something went wrong on my side."], "Want to try again?");
}

// When no series could be picked. `ask` is choose()'s question, which names
// your series; with any discreet series, a question that doesn't.
export function renderWhichSeries(ask: string, anyDiscreet: boolean): Speech {
  const reprompt = escapeSsml("Which series is it?");
  if (anyDiscreet) return { speech: escapeSsml("I'm not sure which series you mean. Which series is it?"), reprompt };
  const sentences = speakable(ask).match(/[^.?!]+[.?!]/g) ?? [ask];
  return { speech: escapeSsml(sentences.slice(0, MAX_SENTENCES).join(" ").replace(/\s+/g, " ").trim()), reprompt };
}

export function renderUnknownSeries(heard: string): Speech {
  return answer([`I don't know a series called ${phrase(heard, 6)}.`], "Which series is it?");
}

// --- Launch ----------------------------------------------------------------

// The Bee button receipt (counts and times only) in one sentence, the next
// session, and the menu.
export function renderLaunch(receipt: string | null, next: { series: Series; nextAt: string | null } | null, now = Date.now()): Speech {
  const receiptLine = receipt ? speakable(receipt).replace(/\.\s+(?=\S)/g, "; ") : null;
  let nextLine: string | null = null;
  if (next && isDiscreet(next.series)) nextLine = discreetNext(next.series, next.nextAt, now);
  else if (next?.nextAt) nextLine = `Your next session is ${spokenName(next.series)}, ${spokenWhen(Date.parse(next.nextAt), next.series.timezone, now)}.`;
  return answer([receiptLine, nextLine, menuSentence()], WHAT_NEXT);
}

// --- Reads -----------------------------------------------------------------

const agendaCount = (n: number) => (n ? `You have ${plural(n, "agenda item")}` : "Your agenda is empty");
const stripBee = (item: string) => item.replace(/ \(from Bee\)$/, "");

export function renderPrepBrief(view: PrepBriefView, series: Series, discreet: boolean, next?: string, now = Date.now()): Speech {
  const n = view.openAgenda.length;
  if (discreet) return answer([discreetNext(series, view.nextSessionAt, now), `${agendaCount(n)}.`, IN_CLAUDE], next);
  const name = spokenName(series);
  const gist = paraphrase(view.shortSummary);
  const last = view.lastSessionLocal
    ? `Your last ${name} session was ${dayOfLocal(view.lastSessionLocal)}${gist ? `: ${gist}` : ""}.`
    : `There's no ${name} session recorded yet.`;
  const first = n ? phrase(stripBee(view.openAgenda[0])) : "";
  const agenda = n === 0 ? "Your agenda is empty." : n === 1 ? `You have 1 agenda item: ${first}.` : `You have ${n} agenda items, starting with ${first}.`;
  return answer([last, agenda], next);
}

export function renderNextSession(view: PrepBriefView, series: Series, discreet: boolean, next?: string, now = Date.now()): Speech {
  if (discreet) return answer([discreetNext(series, view.nextSessionAt, now)], next);
  const name = spokenName(series);
  if (!view.nextSessionAt) return answer([`${capital(name)} has no session scheduled.`], next);
  return answer([`Your next ${name} session is ${spokenWhen(Date.parse(view.nextSessionAt), series.timezone, now)}.`], next);
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

// `view` is null when there's no digest yet.
export function renderSinceLastSession(view: SinceView | null, series: Series, discreet: boolean, next?: string, now = Date.now()): Speech {
  const label = discreet ? discreetLabel(series, now) : spokenName(series);
  if (!view || !view.lastSessionEndedLocal) return answer([`There's nothing to count yet for ${label}.`], next);
  const counts = paraphrase(view.summary.match(/^It's been .*?\.(?=\s|$)/)?.[0] ?? "") || `${plural(view.conversations, "conversation")} so far`;
  if (discreet) return answer([`${counts}.`], next);
  const topics = view.topics.slice(0, 3).map((t) => `${phrase(t.word, 3)} ${times(t.count)}`);
  const joined = topics.length > 1 ? `${topics.slice(0, -1).join(", ")} and ${topics.at(-1)}` : topics[0];
  return answer([`${counts}.`, topics.length ? `From last session, ${joined} came up again.` : null], next);
}

export function renderSinceOff(): Speech {
  return answer(["The since-last-session count is off for Other, because it isn't a recurring series."], "Which series is it?");
}

// `view` is null when the series has no session yet.
export function renderLastSession(view: SessionView | null, series: Series, discreet: boolean, next?: string): Speech {
  if (!view) return answer([discreet ? "There's no session recorded yet." : `There's no ${spokenName(series)} session recorded yet.`], next);
  const day = dayOfLocal(view.startedAtLocal);
  if (discreet) return answer([`It was on ${day}.`, "The summary is in Claude."], next);
  const gist = paraphrase(view.shortSummary);
  const length = view.durationMinutes > 0 ? `, for ${plural(view.durationMinutes, "minute")}` : "";
  return answer([`Your last ${spokenName(series)} session was ${day}${length}${gist ? `: ${gist}` : ""}.`], next);
}

const ORDINALS = ["one", "two", "three"];

// `view` is null when the agenda is empty.
export function renderAgendaList(view: AgendaView | null, series: Series, discreet: boolean, next?: string): Speech {
  const n = view?.items.length ?? 0;
  const where = discreet ? "your agenda" : `your ${spokenName(series)} agenda`;
  if (!n) return answer([`${capital(where)} is empty.`], next);
  const count = `You have ${plural(n, "item")} on ${where}.`;
  if (discreet) return answer([count], next);
  const items = view!.items.slice(0, 3).map((i, k) => `${n > 1 ? `number ${ORDINALS[k]}, ` : ""}${phrase(i.text)}`);
  return answer([count, `${capital(items.join("; "))}.`], next);
}

// `view` is null when nothing is waiting.
export function renderReview(view: ReviewView | null, all: Series[], discreet: boolean, next?: string, now = Date.now()): Speech {
  const n = view?.sessions.length ?? 0;
  if (!n) return answer(["Nothing needs review."], WHAT_NEXT);
  if (discreet) return answer([`${n === 1 ? "One session needs" : `${n} sessions need`} review.`, IN_CLAUDE], next);
  const first = view!.sessions[0];
  const what = `a ${first.durationMinutes}-minute conversation on ${reviewWhen(first, all, now)}, ${first.filed ? "filed under" : "guessed as"} ${phrase(first.guess, 6)}`;
  const intro = n === 1 ? `One guess is waiting: ${what}.` : `${n} guesses are waiting; the first is ${what}.`;
  const d = first.expiresInDays;
  return answer([intro, d === 0 ? "It expires today." : `It expires in ${plural(d, "day")}.`], next);
}

function reviewWhen(item: { id: string; when: string }, all: Series[], now: number): string {
  const ref = parseRefId(item.id);
  if (!ref) return speakable(item.when);
  const zone = all.find((s) => s.id === ref.seriesId)?.timezone ?? all[0]?.timezone ?? "UTC";
  return spokenWhen(Date.parse(ref.start), zone, now);
}

// --- Writes, each read back ------------------------------------------------

export function renderAgendaAdded(item: string, series: Series, discreet: boolean, next?: string): Speech {
  return answer([discreet ? "Added to your agenda." : `Added to ${spokenName(series)}: ${phrase(item)}.`], next);
}

export function renderAgendaRemoved(item: string, series: Series, discreet: boolean, next?: string): Speech {
  return answer([discreet ? "Removed from your agenda." : `Removed from ${spokenName(series)}: ${phrase(item)}.`], next);
}

export function renderTakeawaySaved(takeaway: string, series: Series, discreet: boolean, next?: string): Speech {
  return answer([discreet ? "Saved your takeaway." : `Saved for ${spokenName(series)}: ${phrase(takeaway)}.`], next);
}

// --- Write errors ----------------------------------------------------------

export function renderMissingText(what: "agenda" | "takeaway"): Speech {
  return what === "agenda"
    ? answer(["I didn't catch the item."], "What should I add to your agenda?")
    : answer(["I didn't catch the takeaway."], "What's your takeaway?");
}

export function renderNotOnAgenda(heard: string, series: Series, discreet: boolean): Speech {
  return answer(
    [discreet ? "Nothing on your agenda matches that." : `Nothing on your ${spokenName(series)} agenda matches ${phrase(heard, 8)}.`],
    "Want to hear your agenda?",
  );
}

export function renderNoAgendaList(): Speech {
  return answer(["Ask what's on your agenda first, so I can number the items."], "Want to hear your agenda?");
}

export function renderNoSuchNumber(n: number): Speech {
  return answer([`There's no number ${n} on the list I read.`], "Want to hear your agenda again?");
}

export function renderAlreadyRemoved(): Speech {
  return answer(["That item is no longer on your agenda."], "Want to hear what's left?");
}

export function renderNoTakeawaySession(series: Series, discreet: boolean): Speech {
  return answer(
    [discreet ? "There's no session to attach a takeaway to yet." : `There's no ${spokenName(series)} session to attach a takeaway to yet.`],
    WHAT_NEXT,
  );
}

// --- Retag (phase 1b), with confirmation -----------------------------------

export interface RetagTarget {
  id: string;
  durationMinutes: number;
}

export function renderRetagConfirm(
  target: RetagTarget,
  to: Series | "not-session",
  all: Series[],
  discreet: boolean,
  now = Date.now(),
): Speech {
  const ref = parseRefId(target.id);
  const zone = all.find((s) => s.id === ref?.seriesId)?.timezone ?? all[0]?.timezone ?? "UTC";
  const what = `the ${target.durationMinutes}-minute conversation${ref ? ` on ${spokenWhen(Date.parse(ref.start), zone, now)}` : ""}`;
  const question =
    to === "not-session"
      ? `Mark ${what} as not a session?`
      : `Move ${what} to ${discreet ? "the series you named" : spokenName(to)}?`;
  return { speech: escapeSsml(question), reprompt: escapeSsml(question) };
}

// `readBack` is retag_session's answer; only its first sentence is spoken.
export function renderRetagDone(readBack: string, to: Series | "not-session", discreet: boolean, next?: string): Speech {
  if (discreet) return answer([to === "not-session" ? "Done: it's marked as not a session." : "Done: it's moved."], next);
  const first = speakable(readBack).match(/^.*?\.(?=\s|$)/)?.[0] ?? speakable(readBack);
  return answer([`${phrase(first, 30)}.`], next);
}

export function renderRetagKept(): Speech {
  return answer(["OK, I left it as it was."], "Anything else to review?");
}

export function renderNothingToConfirm(): Speech {
  return answer(["There's nothing waiting for a yes or no."], WHAT_NEXT);
}

export function renderRetagStale(): Speech {
  return answer(["That guess has changed since I read it, so I left it alone."], "Want to hear which sessions need review?");
}

export function renderNoReviewList(): Speech {
  return answer(["Ask which sessions need review first, so I know which one you mean."], "Want to hear which sessions need review?");
}

export function renderRetagFailed(): Speech {
  return answer(["I couldn't change that session."], "Want to hear which sessions need review?");
}
