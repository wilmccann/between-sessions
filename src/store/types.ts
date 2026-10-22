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
  putJournalRecord(record: JournalRecord): Promise<void>;
  listJournalRecords(): Promise<JournalRecord[]>; // oldest first
  putPrepBrief(brief: PrepBrief): Promise<void>;
  getPrepBrief(seriesId: string, sessionStart: string): Promise<PrepBrief | null>;
  getSeries(id: string): Promise<Series | null>;
  listSeries(): Promise<Series[]>;
  putSeries(series: Series): Promise<void>;
}
