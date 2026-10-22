// The voice-note watcher (`yarn watch`): reads Bee's realtime stream and
// prints, for each voice note, what Bee heard and what the collector will do
// with it, using the same parser. A local testing probe only: the stream is
// at-most-once, so the product never depends on it. Prints to the terminal
// and keeps nothing; conversation titles and summaries are never printed.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CollectorResult } from "./aws/collector.js";
import { commandWords, readNote, type Command } from "./commands.js";
import { matchSeriesName, type Series } from "./series.js";

// Utterance, location and todo events are never subscribed to.
export const STREAM_TYPES = [
  "journal-created",
  "journal-updated",
  "journal-text",
  "journal-deleted",
  "new-conversation",
  "update-conversation",
  "delete-conversation",
];

export interface StreamJournal {
  id: string;
  state?: string;
  text?: string;
  cleanedUpText?: string;
}

export type StreamEvent =
  // "journal" when the payload doesn't say whether it was created or updated.
  | { kind: "journal-created" | "journal-updated" | "journal"; journal: StreamJournal }
  | { kind: "journal-text"; journalId: string; text: string }
  | { kind: "journal-deleted"; journalId: string; reason?: string }
  | { kind: "new-conversation" | "update-conversation" | "delete-conversation"; conversationId: string; state?: string }
  | { kind: "unknown"; keys: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

// Bee's payloads have no event name; they're told apart by their keys. An
// `event` or `type` field, if one shows up, is used as a hint (with the
// payload under `data` or at the top level).
export function classifyStreamEvent(obj: unknown): StreamEvent {
  if (!isObject(obj)) return { kind: "unknown", keys: [] };
  const hint = str(obj.event) ?? str(obj.type);
  const body = hint && isObject(obj.data) ? obj.data : obj;

  if (isObject(body.journal) && str(body.journal.id)) {
    const j = body.journal;
    const ai = isObject(j.aiResponse) ? j.aiResponse : {};
    const kind = hint === "journal-created" || hint === "journal-updated" ? hint : "journal";
    return {
      kind,
      journal: { id: str(j.id)!, state: str(j.state), text: str(j.text), cleanedUpText: str(ai.cleanedUpText) },
    };
  }
  const journalId = str(body.journalId);
  if (journalId) {
    if (hint === "journal-deleted" || (!("text" in body) && "reason" in body)) {
      return { kind: "journal-deleted", journalId, reason: str(body.reason) };
    }
    if (typeof body.text === "string") return { kind: "journal-text", journalId, text: body.text };
  }
  if (isObject(body.conversation) && str(body.conversation.id)) {
    const c = body.conversation;
    const kinds = ["new-conversation", "update-conversation", "delete-conversation"] as const;
    const hinted = kinds.find((k) => k === hint);
    const kind =
      hinted ??
      ("short_summary" in c ? "update-conversation" : "uuid" in c ? "new-conversation" : "state" in c ? "update-conversation" : "delete-conversation");
    return { kind, conversationId: str(c.id)!, state: str(c.state) };
  }
  return { kind: "unknown", keys: Object.keys(obj) };
}

type SeriesFit = "existing" | "new" | "unclear";
const fitOf = (series: Series[], name: string): SeriesFit => {
  const m = matchSeriesName(series, name);
  return m.kind === "match" ? "existing" : m.kind === "ambiguous" ? "unclear" : "new";
};

// What the collector will do with a parsed note. With `shape`, spoken series
// names are left out.
export function commandVerdict(cmd: Command | null, series: Series[], shape = false): string {
  if (!cmd) return "plain note";
  if (cmd.kind === "unfiled") return `can't file: ${cmd.reason}`;
  if (cmd.kind === "debrief") return "DEBRIEF";
  if (cmd.kind === "not-session") return "NOT A SESSION";

  const label = { start: "START", end: "END", agenda: "AGENDA", takeaway: "TAKEAWAY", drop: "DROP", retag: "RETAG" }[cmd.kind];
  if (!cmd.series) return label;
  const fit = fitOf(series, cmd.series);
  const named = shape ? "" : ` ${cmd.series}`;
  if (cmd.kind === "start" || cmd.kind === "end") {
    const what = { existing: "existing series", new: "new series", unclear: "unclear: matches more than one series" }[fit];
    return shape ? `${label} (${what})` : `${label}, series${named} (${what})`;
  }
  // Agenda, takeaway, drop and retag only file under a series you have.
  const what = { existing: "existing series", new: "no such series, can't file", unclear: "matches more than one series, can't file" }[fit];
  if (cmd.kind === "retag") return `RETAG to${shape ? " a series" : named} (${what})`;
  return `${label} (series${named}, ${what})`;
}

// The verdict for a voice note's text, the way the collector reads it; a
// dry run shows what its command would do. A command said without the
// name says so, since the collector won't act on it.
export function verdict(text: string, series: Series[], shape = false): string {
  const note = readNote(text, series);
  const unaddressed = !note.addressed && commandWords(note.words, series) !== null;
  const said = unaddressed ? 'plain note (no "Marty", so not a command)' : commandVerdict(note.command, series, shape);
  return note.test ? `Test: would be ${said}` : said;
}

const lastFour = (id: string) => `…${id.slice(-4)}`;
const quote = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function timeOf(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(ms);
}

export interface DescribeOptions {
  shape?: boolean;
  at?: number; // when the event arrived; defaults to now
  timeZone?: string; // defaults to this machine's
}

// The one line the watcher prints for an event.
export function describeEvent(event: StreamEvent, series: Series[], opts: DescribeOptions = {}): string {
  const { shape = false } = opts;
  const time = timeOf(opts.at ?? Date.now(), opts.timeZone);
  switch (event.kind) {
    case "journal-created":
    case "journal-updated":
    case "journal": {
      const { id, state, text = "", cleanedUpText } = event.journal;
      const parts = [time, event.kind, lastFour(id), state ?? "?"];
      const cleaned = cleanedUpText?.trim() && cleanedUpText.trim() !== text.trim() ? cleanedUpText : undefined;
      if (!shape && text.trim()) parts.push(`heard ${quote(text)}`);
      if (!shape && cleaned) parts.push(`cleaned ${quote(cleaned)}`);
      if (!text.trim()) {
        parts.push("-> no text yet");
        return parts.join(" ");
      }
      const raw = verdict(text, series, shape);
      parts.push(`-> ${raw}`);
      if (cleaned) {
        // Bee's cleanup drops a leading name, so put it back before comparing.
        const named = readNote(text).addressed && !readNote(cleaned).addressed ? `Marty, ${cleaned}` : cleaned;
        const other = verdict(named, series, shape);
        if (other !== raw) parts.push(`(cleanup changes the verdict: raw=${raw} cleaned=${other})`);
      }
      return parts.join(" ");
    }
    case "journal-text": {
      const line = `${time} journal-text ${lastFour(event.journalId)} ${wordCount(event.text)} words`;
      return shape ? line : `${line}: ${quote(event.text)}`;
    }
    case "journal-deleted":
      return `${time} journal-deleted ${lastFour(event.journalId)}${!shape && event.reason ? ` (${event.reason})` : ""}`;
    case "new-conversation":
    case "update-conversation":
    case "delete-conversation":
      return [time, event.kind, event.conversationId, event.state].filter(Boolean).join(" ");
    case "unknown":
      return `${time} unrecognized event (keys: ${event.keys.join(", ") || "none"})`;
  }
}

export interface LineHandlerOptions extends DescribeOptions {
  series: () => Series[];
  print: (line: string) => void;
  // Called once each time a voice note turns READY.
  onReady?: (journalId: string) => void;
}

// Turns stream lines (one JSON object each) into printed lines. Remembers
// each note's last state, in memory only, so READY fires once per note.
export function lineHandler(opts: LineHandlerOptions): (line: string) => void {
  const states = new Map<string, string | undefined>();
  return (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      opts.print(`${timeOf(opts.at ?? Date.now(), opts.timeZone)} unparsed line (${trimmed.length} characters)`);
      return;
    }
    const event = classifyStreamEvent(obj);
    opts.print(describeEvent(event, opts.series(), opts));
    if (event.kind === "journal" || event.kind === "journal-created" || event.kind === "journal-updated") {
      const { id, state } = event.journal;
      const before = states.get(id);
      states.set(id, state);
      if (state === "READY" && before !== "READY") opts.onReady?.(id);
    }
  };
}

// The collector's answer, counts only (no series ids or session times).
export function describeCollectorResult(r: Partial<CollectorResult>): string {
  const n = (v: unknown) => (typeof v === "number" ? v : "?");
  return (
    `collector: ${n(r.conversations)} conversations, ${n(r.insights)} insights, ${n(r.series)} series, ` +
    `${n(r.matched)} matched, ${n(r.replaced)} replaced, ${n(r.written)} written ` +
    `(${Array.isArray(r.writtenSessions) ? r.writtenSessions.length : "?"} sessions), ` +
    `${n(r.briefs)} briefs, ${n(r.briefsFailed)} briefs failed, config refreshed ${r.configRefreshed ? "yes" : "no"}, ` +
    `${typeof r.durationMs === "number" ? (r.durationMs / 1000).toFixed(1) : "?"}s`
  );
}

// Runs `task` one at a time: a call while it runs queues at most one more.
// The task reports its own errors.
export function oneAtATime(task: () => Promise<void>): () => void {
  let running = false;
  let queued = false;
  const go = async () => {
    running = true;
    try {
      await task();
    } catch {
      // Reported by the task.
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void go();
      }
    }
  };
  return () => {
    if (running) queued = true;
    else void go();
  };
}

// Runs `bee stream` once, feeding each stdout line to onLine. Resolves with
// the exit code when the stream ends. Stderr is passed through untouched
// (the CLI's own status messages).
export function streamOnce(bin: string, onLine: (line: string) => void, types = STREAM_TYPES): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["stream", "--json", "--types", types.join(",")], { stdio: ["ignore", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", onLine);
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}
