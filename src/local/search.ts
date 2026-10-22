// The review page's search, on the server so text never has to reach the
// page to be searched. Three modes:
// - exact: every row on both tabs, over its hidden text and visible fields.
//   Answers with row keys and where each matched ("note text", "reason"),
//   never the text.
// - keyword: `bee search` (conversations, dailies and facts).
// - neural: `bee search --neural` (conversations, by meaning).
// Bee search hits keep their snippets and summaries in memory for "show".
import { refId } from "../review.js";
import type { SessionStore } from "../store/types.js";
import { BeeCliError, type BeeData, type BeeRow, iso, martyJoin, parts, rowKey, runBee, str, type TextPart } from "./bee-data.js";
import { beeConversation, type Lookup } from "./lookups.js";
import type { ReviewState } from "./review-ui.js";

export const MAX_QUERY = 200;
const KEYWORD_LIMIT = 50;
const SESSIONS_PER_SERIES = 20; // as on the page

// Lowercase, no punctuation or symbols, single spaces.
export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

// Terms split on whitespace; "-word" excludes rows containing it.
export function parseQuery(q: string) {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of q.trim().split(/\s+/)) {
    const negative = raw.length > 1 && raw.startsWith("-");
    const term = normalize(negative ? raw.slice(1) : raw);
    if (term) (negative ? exclude : include).push(term);
  }
  return { include, exclude };
}

export interface Field {
  label: string;
  value: string | number | null | undefined;
}
export interface Doc {
  key: string;
  fields: Field[];
}

// Each positive term must be a substring of some field (so "mart" finds
// "Marty" and "Smarty"); no field may contain an excluded term.
export function matchDocs(docs: Doc[], q: string) {
  const { include, exclude } = parseQuery(q);
  if (!include.length && !exclude.length) return [];
  const matches: { key: string; matchedIn: string[] }[] = [];
  for (const doc of docs) {
    const fields = doc.fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== "").map((f) => ({ label: f.label, value: normalize(String(f.value)) }));
    if (exclude.some((t) => fields.some((f) => f.value.includes(t)))) continue;
    if (!include.every((t) => fields.some((f) => f.value.includes(t)))) continue;
    const matchedIn = [...new Set(fields.filter((f) => include.some((t) => f.value.includes(t))).map((f) => f.label))];
    matches.push({ key: doc.key, matchedIn });
  }
  return matches;
}

const textFields = (parts: TextPart[] | undefined): Field[] => (parts ?? []).map((p) => ({ label: p.label, value: p.text }));

// Row keys, the same on the page: "session:<id>", "review:<id>",
// "marker:<journalId>", "note:<journalId>", "agenda:<seriesId>@<at>",
// "series:<id>", and the Bee data tab's own keys ("journal:<id>", ...).
export async function exactSearch(q: string, state: ReviewState, store: SessionStore, beeData: BeeData) {
  // Without Bee (the CLI failed), it still searches the stored rows.
  let beeError: string | undefined;
  let beeRows: BeeRow[] = [];
  let texts = new Map<string, TextPart[]>();
  try {
    beeRows = (await beeData.rows()).rows;
    texts = await beeData.allTexts();
  } catch (err) {
    if (!(err instanceof BeeCliError)) throw err;
    beeError = err.message;
  }
  const journalText = (id: string) => textFields(texts.get(rowKey("journal", id)));
  const conversationText = (ids: string[]) => ids.flatMap((id) => textFields(texts.get(rowKey("conversation", id))));
  const ids = (xs: string[]): Field[] => xs.map((value) => ({ label: "id", value }));
  const stored = new Map<string, string[]>();
  for (const s of state.series) {
    for (const v of await store.listSessions(s.id, SESSIONS_PER_SERIES)) stored.set(refId(v), v.parts.map((p) => p.shortSummary));
  }

  const docs: Doc[] = [
    ...state.series.map((s) => ({
      key: `series:${s.id}`,
      fields: [{ label: "id", value: s.id }, { label: "series", value: s.name }, ...s.spokenNames.map((value) => ({ label: "spoken name", value }))],
    })),
    ...state.sessions.flatMap((g) =>
      g.sessions.map((x) => ({
        key: `session:${x.id}`,
        fields: [
          ...ids([x.id, ...x.beeIds]),
          { label: "series", value: g.series },
          { label: "status", value: x.tag?.status ?? "untagged" },
          { label: "reason", value: x.tag?.reason },
          ...(stored.get(x.id) ?? []).map((value) => ({ label: "short summary", value })),
          ...conversationText(x.beeIds),
        ],
      })),
    ),
    ...state.review.sessions.map((r) => ({
      key: `review:${r.id}`,
      fields: [
        ...ids([r.id, ...r.beeIds]),
        { label: "series", value: r.guess },
        { label: "reason", value: r.reason },
        ...conversationText(r.beeIds),
      ],
    })),
    ...state.markers.map((m) => ({
      key: `marker:${m.journalId}`,
      fields: [...ids([m.journalId]), { label: "kind", value: m.kind }, { label: "series", value: m.series }, ...journalText(m.journalId)],
    })),
    ...state.voiceNotes.map((n) => ({
      key: `note:${n.journalId}`,
      fields: [
        ...ids([n.journalId]),
        { label: "kind", value: n.kind },
        { label: "status", value: n.status },
        { label: "series", value: n.series },
        { label: "reason", value: n.reason },
        ...journalText(n.journalId),
      ],
    })),
    ...state.agenda.flatMap((g) =>
      g.items.map((i) => ({
        key: `agenda:${g.seriesId}@${i.at}`,
        fields: [...ids(i.journalId ? [i.journalId] : []), { label: "agenda item", value: i.text }, { label: "series", value: g.series }],
      })),
    ),
    ...beeRows.map((r) => ({
      key: r.key,
      fields: [...ids([r.id]), { label: "type", value: r.type }, { label: "state", value: r.state }, { label: "Marty", value: r.marty }, ...textFields(texts.get(r.key))],
    })),
  ];
  return { mode: "exact" as const, matches: matchDocs(docs, q), ...(beeError ? { beeError } : {}) };
}

export interface SearchRow {
  key: string;
  source: "keyword" | "neural";
  type: string; // conversation, daily or fact
  id: string;
  createdAt: string | null;
  start: string | null;
  end: string | null;
  score?: number;
  rank?: number; // 1 = most relevant
  marty: string | null;
  lookups: Lookup[];
  hasText: boolean;
  matchedIn: string[];
}

const TYPES = ["conversation", "daily", "fact"];

// `bee search` in keyword mode: every kind it covers, best score first.
export async function keywordSearch(q: string, sinceMs: number, untilMs: number, store: SessionStore, beeData: BeeData) {
  const res = await runBee<{ results?: Record<string, unknown>[] }>([
    "search",
    "--query",
    q,
    "--filter",
    "all",
    "--scope",
    "all",
    "--since",
    String(sinceMs),
    "--until",
    String(untilMs),
    "--limit",
    String(KEYWORD_LIMIT),
  ]);
  const results = Array.isArray(res.results) ? res.results : [];
  const join = await martyJoin(store, beeData.table);
  const texts = new Map<string, TextPart[]>();
  const rows: SearchRow[] = results.map((r) => {
    const type = TYPES.includes(str(r.type)) ? str(r.type) : "other";
    const id = str(r.id);
    const key = rowKey(type, id, "keyword");
    texts.set(key, parts(["title snippet", r.title_snippet], ["snippet", r.snippet], ["summary", r.summary]));
    const m = type === "conversation" ? join.conversation(Number(id)) : { marty: null, db: [] };
    return {
      key,
      source: "keyword",
      type,
      id,
      createdAt: iso(r.created_at),
      start: null,
      end: null,
      score: typeof r.score === "number" ? r.score : 0,
      marty: m.marty,
      lookups: type === "conversation" ? [beeConversation(id), ...m.db] : [],
      hasText: texts.get(key)!.length > 0,
      matchedIn: ["Bee keyword search"],
    };
  });
  rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  beeData.rememberSearch("keyword", texts);
  return { mode: "keyword" as const, rows, cutShort: results.length >= KEYWORD_LIMIT };
}

// `bee search --neural`: conversations by meaning, in Bee's relevance order.
// Links and locations are never read.
export async function neuralSearch(q: string, sinceMs: number, untilMs: number, store: SessionStore, beeData: BeeData) {
  const res = await runBee<{ results?: Record<string, unknown>[] }>(["search", "--query", q, "--neural", "--since", String(sinceMs), "--until", String(untilMs)]);
  const results = Array.isArray(res.results) ? res.results : [];
  const join = await martyJoin(store, beeData.table);
  const texts = new Map<string, TextPart[]>();
  const rows: SearchRow[] = results.map((r, i) => {
    const id = str(r.id);
    const key = rowKey("conversation", id, "neural");
    texts.set(key, parts(["short summary", r.short_summary], ["summary", r.detailed_summary]));
    const m = join.conversation(Number(id));
    return {
      key,
      source: "neural",
      type: "conversation",
      id,
      createdAt: null,
      start: iso(r.started_at),
      end: iso(r.stopped_at),
      rank: i + 1,
      marty: m.marty,
      lookups: [beeConversation(id), ...m.db],
      hasText: texts.get(key)!.length > 0,
      matchedIn: ["Bee semantic search"],
    };
  });
  beeData.rememberSearch("neural", texts);
  return { mode: "neural" as const, rows };
}
