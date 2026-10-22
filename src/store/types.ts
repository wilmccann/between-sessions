// What the cloud keeps: matched sessions (as versions), their first insight
// batch, and the user's own agenda items, takeaways and prep briefs. Never
// every Bee conversation, and never utterances.
import type { Series } from "../series.js";

export interface SessionPart {
  id: number;
  start: string; // ISO
  end: string;
  shortSummary: string;
  summary: string;
}

export interface SessionInsight {
  id: number;
  title: string;
  description: string;
  generatedAt: string; // ISO
}

// Why a session is filed under its series. `source` is the evidence that
// placed it; `status` is whether you've seen it.
export type TagSource = "marker" | "schedule" | "keyword" | "pattern" | "model" | "you";
export type TagStatus = "auto" | "pending" | "confirmed" | "rejected";
export interface SessionTag {
  source: TagSource;
  confidence: "certain" | "high" | "low";
  status: TagStatus;
  reason: string; // short, no Bee content: "Tue 17:00 to 18:00 slot"
}

// Which session holds a Bee conversation, so no conversation is stored in
// two sessions. A rejected conversation ("not a session") keeps only this.
export interface Claim {
  conversationId: number;
  seriesId: string; // "" when rejected
  sessionStart: string; // "" when rejected
  source: TagSource;
  status: TagStatus;
}

export interface SessionRef {
  seriesId: string;
  start: string;
}

// A guess waiting for you: either a session filed under its best guess
// (`filed`), or a candidate not filed until you confirm it. Holds times,
// length, Bee ids and the reason; never a summary.
export interface ReviewItem {
  seriesId: string; // the guess
  start: string;
  end: string;
  conversationIds: number[];
  source: TagSource;
  reason: string;
  filed: boolean;
  dropsAt: string; // when Bee's 14-day history drops the conversations
}

// One session as Bee described it at collection time.
export interface SessionInput {
  start: string; // ISO; identifies the session within its series
  end: string;
  parts: SessionPart[];
  insights: SessionInsight[];
  tag?: SessionTag; // missing on versions stored before tags existed
}

export interface SessionVersion extends SessionInput {
  seriesId: string;
  hash: string; // over the summaries and insight ids
  collectedAt: string;
  versions: number; // how many versions of this session exist, this one included
}

// Who added something: you, typing, or your Bee button (a voice note).
export type ItemSource = "you" | "bee";
export interface FromBee {
  source?: ItemSource;
  journalId?: string;
  createdAt?: string; // a voice note's own time, not when it was filed
}

export interface AgendaItem {
  id: string;
  seriesId: string;
  text: string;
  createdAt: string;
  source?: ItemSource; // missing means "you"
  journalId?: string;
}

export interface Takeaway {
  id: string;
  seriesId: string;
  sessionStart: string; // the session it belongs to
  text: string;
  createdAt: string;
  source?: ItemSource;
  journalId?: string;
}

// Your debrief, in your words, from a "Debrief: ..." voice note.
export interface Debrief {
  id: string; // the journal id
  seriesId: string;
  sessionStart: string;
  text: string;
  createdAt: string;
}

// A Bee button "start session" or "end session", at the voice note's time.
export interface Marker {
  journalId: string;
  kind: "start" | "end";
  at: string; // ISO
  seriesId?: string; // missing when no series was named
  unclear?: boolean; // a name was given but matched more than one series
}

// What happened to each Bee voice note, so each is used once and the next
// brief can say what was filed. Holds no note text.
export interface JournalRecord {
  journalId: string;
  at: string; // the note's time
  kind: string; // a command kind, or "note" for anything else
  status: "filed" | "unfiled" | "ignored";
  seriesId?: string;
  reason?: string; // why it couldn't be filed
}

// A running record of one UTC day, kept by the collector so the digest can
// count past Bee's 14-day history. Ids, times and topic-word hits only:
// no summaries, no todo text.
export interface DayTally {
  date: string; // YYYY-MM-DD, UTC
  conversations: { id: number; start: number }[];
  todos: { id: number; createdAt: number }[];
  topicHits: Record<string, number[]>; // topic word -> conversation ids
}

// What has happened since a series' last session, precomputed by the
// collector so get_since_last_session reads one item.
export interface Digest {
  seriesId: string;
  computedAt: string;
  since: string | null; // the last session's end
  conversations: number;
  todos: number;
  insightTitles: string[]; // newest first, at most 5
  topics: { word: string; count: number }[]; // from the last session, that came up again
  // The tallies don't reach back to `since`, so counts may be low.
  partial: boolean;
}

export interface PrepBrief {
  seriesId: string;
  sessionStart: string; // the session it was written after
  note: string; // session note, under 200 words
  bullets: string[]; // things to bring up next time
  relevantInsightIds: number[];
  model: string;
  generatedAt: string;
}

export interface SessionStore {
  // Writes a new version only when the content hash changed. Returns the
  // latest version and whether it was just written.
  putSessionVersion(
    seriesId: string,
    session: SessionInput,
    collectedAt?: string,
  ): Promise<{ version: SessionVersion; written: boolean }>;
  // putSessionVersion, plus: claims the session's conversations, and takes
  // over the sessions in `replaces` (their takeaways and debriefs move to
  // this one, their versions are deleted), all in one transaction.
  recordSession(
    seriesId: string,
    session: SessionInput,
    collectedAt: string,
    replaces?: SessionRef[],
  ): Promise<{ version: SessionVersion; written: boolean }>;
  listClaims(): Promise<Map<number, Claim>>;
  putClaims(claims: Claim[]): Promise<void>;
  hasSession(ref: SessionRef): Promise<boolean>;
  // Moves every version, takeaway and debrief of a session to another
  // series (same start), with a new tag, in one transaction.
  moveSession(from: SessionRef, toSeriesId: string, tag: SessionTag): Promise<void>;
  // Deletes a session's versions and brief, marks its conversations
  // rejected, and moves its takeaways and debriefs to `keepOn` (or deletes
  // them), in one transaction. Returns how many takeaways and debriefs moved.
  rejectSession(ref: SessionRef, keepOn: SessionRef | null): Promise<number>;
  listReviewItems(): Promise<ReviewItem[]>; // oldest first
  putReviewItem(item: ReviewItem): Promise<void>;
  deleteReviewItem(item: ReviewItem): Promise<void>;
  // Points or removes the Bee button markers at these times.
  updateMarkers(atTimes: string[], seriesId: string | null): Promise<void>;
  getLatestSession(seriesId: string): Promise<SessionVersion | null>;
  // Latest version of each session, newest session first.
  listSessions(seriesId: string, limit: number): Promise<SessionVersion[]>;
  addAgendaItem(seriesId: string, text: string, from?: FromBee): Promise<AgendaItem>;
  listAgenda(seriesId: string): Promise<AgendaItem[]>;
  removeAgendaItem(item: AgendaItem): Promise<void>;
  saveTakeaway(seriesId: string, sessionStart: string, text: string, from?: FromBee): Promise<Takeaway>;
  listTakeaways(seriesId: string, sessionStart?: string): Promise<Takeaway[]>;
  saveDebrief(debrief: Debrief): Promise<void>;
  listDebriefs(seriesId: string, sessionStart: string): Promise<Debrief[]>;
  putMarker(marker: Marker): Promise<void>;
  listMarkers(): Promise<Marker[]>; // oldest first
  listTallies(): Promise<DayTally[]>; // oldest first
  putTallies(tallies: DayTally[]): Promise<void>;
  putDigest(digest: Digest): Promise<void>;
  getDigest(seriesId: string): Promise<Digest | null>;
  putJournalRecord(record: JournalRecord): Promise<void>;
  listJournalRecords(): Promise<JournalRecord[]>; // oldest first
  putPrepBrief(brief: PrepBrief): Promise<void>;
  getPrepBrief(seriesId: string, sessionStart: string): Promise<PrepBrief | null>;
  getSeries(id: string): Promise<Series | null>;
  listSeries(): Promise<Series[]>;
  putSeries(series: Series): Promise<void>;
  // Deletes only the series' config; the caller checks it has nothing stored.
  deleteSeries(id: string): Promise<void>;
}
