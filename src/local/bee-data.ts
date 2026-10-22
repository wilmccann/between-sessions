// The review page's Bee data tab: the last N days of voice notes,
// conversations and insights, read live through the Bee CLI, each with what
// Marty did with it. Rows carry ids, times and state only. Their text (note
// text, summaries, insight titles and descriptions) stays in this process's
// memory and leaves one row at a time through text(); nothing is written to
// disk or logged. Locations, links, transcripts and utterances are never read.
import { bee, type BeeConversation, type BeeInsight, type BeeJournal } from "../bee/cli.js";
import { defaultTimezone } from "../series.js";
import { itemKeys } from "../store/table-store.js";
import type { SessionStore } from "../store/types.js";
import { DAY, formatShort } from "../time.js";
import { beeConversation, beeInsight, beeJournal, dynamoGet, dynamoQuery, type Lookup } from "./lookups.js";

export const DEFAULT_DAYS = 14;
export const MAX_DAYS = 60;
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
export const INSIGHT_LIMIT = 200;
const CACHE_MS = 60_000;

// A failed `bee` run, reported by exit code only: its stderr can hold the
// query or Bee content.
export class BeeCliError extends Error {}

export async function runBee<T>(args: string[]): Promise<T> {
  try {
    return await bee<T>(args);
  } catch (err) {
    const e = err as { code?: unknown; killed?: boolean; signal?: unknown };
    const why =
      typeof e.code === "number"
        ? `exit ${e.code}`
        : e.killed || e.signal
          ? "timed out"
          : e.code === "ENOENT"
            ? "not found"
            : err instanceof SyntaxError
              ? "unreadable output"
              : "error";
    throw new BeeCliError(`Bee CLI failed (${why})`);
  }
}

export type BeeType = "journal" | "conversation" | "insight";
export type SearchSource = "keyword" | "neural";
export interface TextPart {
  label: string; // "note text", "short summary", "summary", "insight title", ...
  text: string;
}

// A row without its text, before the Marty join.
interface BaseRow {
  type: BeeType;
  id: string;
  createdAt: string | null;
  updatedAt: string | null;
  start: string | null;
  end: string | null;
  state: string | null;
}

export interface BeeRow extends BaseRow {
  key: string;
  marty: string | null; // null: not captured by Marty
  lookups: Lookup[];
  hasText: boolean;
}

interface Snapshot {
  loadedAt: number;
  days: number;
  rows: BaseRow[];
  texts: Map<string, TextPart[]>;
  cutShort: { journals: boolean; conversations: boolean; insights: boolean };
}

export const iso = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
export const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
export const rowKey = (type: string, id: string, source?: SearchSource) => (source ? `${source}:${type}:${id}` : `${type}:${id}`);
export const parts =(...xs: [string, unknown][]): TextPart[] => xs.map(([label, text]) => ({ label, text: str(text) })).filter((p) => p.text);

// Pages through `bee <resource> list` (newest first) until it reaches items
// older than sinceMs, or MAX_PAGES.
async function listWindow<T>(resource: string, timeOf: (item: T) => number, sinceMs: number) {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = [resource, "list", "--limit", String(PAGE_SIZE)];
    if (cursor) args.push("--cursor", cursor);
    const res = await runBee<Record<string, unknown>>(args);
    const batch = Array.isArray(res[resource]) ? (res[resource] as T[]) : [];
    items.push(...batch);
    cursor = typeof res.next_cursor === "string" && res.next_cursor ? res.next_cursor : undefined;
    if (!cursor || batch.length === 0 || Math.min(...batch.map(timeOf)) < sinceMs) {
      return { items: items.filter((i) => timeOf(i) >= sinceMs), cutShort: false };
    }
  }
  return { items: items.filter((i) => timeOf(i) >= sinceMs), cutShort: true };
}

// What Marty did with a voice note or conversation, from the store, and the
// table item behind it.
export interface MartyJoin {
  journal(id: string): { marty: string | null; db: Lookup[] };
  conversation(id: number): { marty: string | null; db: Lookup[] };
}

export async function martyJoin(store: SessionStore, table?: string): Promise<MartyJoin> {
  const [series, claims, reviewItems, records] = await Promise.all([
    store.listSeries(),
    store.listClaims(),
    store.listReviewItems(),
    store.listJournalRecords(),
  ]);
  const tz = defaultTimezone(series);
  const nameOf = (id: string) => series.find((s) => s.id === id)?.name ?? id;
  const recordOf = new Map(records.map((r) => [r.journalId, r])); // oldest first, so the latest wins
  return {
    journal(id) {
      const r = recordOf.get(id);
      if (!r) return { marty: null, db: [] };
      const head = [r.kind, r.status, r.seriesId ? nameOf(r.seriesId) : ""].filter(Boolean).join(", ");
      return { marty: r.reason ? `${head}: ${r.reason}` : head, db: table ? [dynamoGet(table, itemKeys.journal(r))] : [] };
    },
    conversation(id) {
      const item = reviewItems.find((i) => i.conversationIds.includes(id));
      if (item) {
        return {
          marty: item.filed ? `waiting for review: filed under ${nameOf(item.seriesId)}` : `waiting for review: guess ${nameOf(item.seriesId)}`,
          db: table ? [dynamoGet(table, itemKeys.review(item))] : [],
        };
      }
      const claim = claims.get(id);
      if (!claim) return { marty: null, db: [] };
      if (!claim.seriesId) return { marty: "not a session", db: table ? [dynamoGet(table, itemKeys.claim(id))] : [] };
      const when = formatShort(Date.parse(claim.sessionStart), series.find((s) => s.id === claim.seriesId)?.timezone || tz);
      return {
        marty: `session: ${nameOf(claim.seriesId)}, ${when}`,
        db: table ? [dynamoQuery(table, itemKeys.sessionVersions(claim.seriesId, claim.sessionStart))] : [],
      };
    },
  };
}

export interface BeeDataOptions {
  table?: string; // the DynamoDB table, for db lookups
  cacheMs?: number;
  now?: () => number;
}

export class BeeData {
  private snapshot: Snapshot | null = null;
  private loading: { days: number; promise: Promise<Snapshot> } | null = null;
  // The latest Bee search's texts, by source; replaced by the next search.
  private searchTexts: Record<SearchSource, Map<string, TextPart[]>> = { keyword: new Map(), neural: new Map() };

  constructor(
    private readonly store: SessionStore,
    private readonly opts: BeeDataOptions = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  get table() {
    return this.opts.table;
  }

  // The cached read if it's fresh and covers the same days, else a new one.
  private async load(days: number, refresh: boolean): Promise<Snapshot> {
    const s = this.snapshot;
    if (!refresh && s && s.days === days && this.now() - s.loadedAt < (this.opts.cacheMs ?? CACHE_MS)) return s;
    if (this.loading && this.loading.days === days) return this.loading.promise;
    const promise = this.read(days).finally(() => {
      if (this.loading?.promise === promise) this.loading = null;
    });
    this.loading = { days, promise };
    this.snapshot = await promise;
    return this.snapshot;
  }

  private async read(days: number): Promise<Snapshot> {
    const loadedAt = this.now();
    const since = loadedAt - days * DAY;
    // One at a time: the CLI's first call unlocks the Keychain.
    const journals = await listWindow<BeeJournal>("journals", (j) => j.created_at, since);
    const conversations = await listWindow<BeeConversation>("conversations", (c) => c.start_time ?? c.created_at, since);
    const insightPage = await runBee<{ insights?: BeeInsight[] }>(["insights", "list", "--limit", String(INSIGHT_LIMIT)]);
    const insights = Array.isArray(insightPage.insights) ? insightPage.insights : [];

    const rows: BaseRow[] = [];
    const texts = new Map<string, TextPart[]>();
    for (const j of journals.items) {
      const id = str(j.id);
      rows.push({ type: "journal", id, createdAt: iso(j.created_at), updatedAt: iso(j.updated_at), start: null, end: null, state: str(j.state) || null });
      texts.set(rowKey("journal", id), parts(["note text", j.text]));
    }
    for (const c of conversations.items) {
      const id = str(c.id);
      rows.push({
        type: "conversation",
        id,
        createdAt: iso(c.created_at),
        updatedAt: iso(c.updated_at),
        start: iso(c.start_time),
        end: iso(c.end_time),
        state: str(c.state) || null,
      });
      texts.set(rowKey("conversation", id), parts(["short summary", c.short_summary], ["summary", c.summary]));
    }
    for (const i of insights.filter((x) => x.generated_at >= since)) {
      const id = str(i.id);
      rows.push({ type: "insight", id, createdAt: iso(i.generated_at), updatedAt: iso(i.generated_at), start: null, end: null, state: null });
      texts.set(rowKey("insight", id), parts(["insight title", i.title], ["insight description", i.description]));
    }
    return {
      loadedAt,
      days,
      rows,
      texts,
      cutShort: { journals: journals.cutShort, conversations: conversations.cutShort, insights: insights.length >= INSIGHT_LIMIT },
    };
  }

  // Rows for the Bee data tab, newest first, joined with the store.
  async rows(days = DEFAULT_DAYS, refresh = false) {
    const s = await this.load(days, refresh);
    const join = await martyJoin(this.store, this.opts.table);
    const rows: BeeRow[] = s.rows.map((r) => {
      const m = r.type === "journal" ? join.journal(r.id) : r.type === "conversation" ? join.conversation(Number(r.id)) : { marty: null, db: [] };
      const bee = r.type === "journal" ? beeJournal(r.id) : r.type === "conversation" ? beeConversation(r.id) : beeInsight(r.id);
      return { key: rowKey(r.type, r.id), ...r, marty: m.marty, lookups: [bee, ...m.db], hasText: s.texts.has(rowKey(r.type, r.id)) };
    });
    rows.sort((a, b) => (b.start ?? b.createdAt ?? "").localeCompare(a.start ?? a.createdAt ?? ""));
    return { days: s.days, loadedAt: new Date(s.loadedAt).toISOString(), rows, cutShort: s.cutShort };
  }

  // Every row's text, for the server-side exact search. Never sent as is.
  async allTexts(days = DEFAULT_DAYS) {
    return (await this.load(days, false)).texts;
  }

  // One row's text. A listed row needs the Bee data read (reads it if
  // nothing is cached yet, even if stale); a search hit needs the latest
  // search of that kind.
  async text(type: string, id: string, source?: SearchSource): Promise<TextPart[] | null> {
    if (source) return this.searchTexts[source].get(rowKey(type, id, source)) ?? null;
    const s = this.snapshot ?? (await this.load(DEFAULT_DAYS, false));
    return s.texts.get(rowKey(type, id)) ?? null;
  }

  rememberSearch(source: SearchSource, texts: Map<string, TextPart[]>) {
    this.searchTexts[source] = texts;
  }
}
