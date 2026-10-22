// Local review page (`yarn review-ui [--store file]`): series, sessions with
// their tags, markers, voice notes, the review queue and open agenda items,
// on 127.0.0.1 only. Every request needs the right Host header (no DNS
// rebinding) and the random token made at launch. Summaries stay out of the
// page's state; one session's short summary loads only when you ask for it.
// Edits (retag, not a session, confirm, remove an agenda item) run the same
// code as the MCP tools and show the same read-back; they need JSON, so a
// plain cross-site form can't send one.
// The Bee data tab (/api/bee) reads Bee live through the CLI and keeps text
// in memory only, one row at a time through /api/bee/text; /api/search
// searches on the server (see search.ts).
// Inline HTML, CSS and JS only (review-page.ts): nothing is fetched from
// anywhere else.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { minutes } from "../mcp/tool.js";
import removeAgendaItem from "../mcp/tools/remove-agenda-item.js";
import retagSession from "../mcp/tools/retag-session.js";
import reviewSessions from "../mcp/tools/review-sessions.js";
import { parseRefId, refId } from "../review.js";
import { defaultTimezone, hasSchedule, type Series } from "../series.js";
import { openAgenda } from "../store/agenda.js";
import { dynamoStore, TABLE_NAME } from "../store/dynamo-store.js";
import { fileStore } from "../store/file-store.js";
import { itemKeys } from "../store/table-store.js";
import type { SessionStore } from "../store/types.js";
import { DAY, formatShort } from "../time.js";
import { BeeCliError, BeeData, DEFAULT_DAYS, MAX_DAYS } from "./bee-data.js";
import { beeConversation, beeJournal, dynamoGet, dynamoQuery, type Lookup } from "./lookups.js";
import { PAGE } from "./review-page.js";
import { exactSearch, keywordSearch, MAX_QUERY, neuralSearch } from "./search.js";
import { scheduleRoute } from "./schedule-ui.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SESSIONS_PER_SERIES = 20;
const LOG_LIMIT = 50; // markers and voice notes, newest first

const schedule = (s: Series) => (hasSchedule(s) ? `${WEEKDAYS[s.weekday]} ${s.windowStart} to ${s.windowEnd}` : "unscheduled");

export { shellQuote, type Lookup } from "./lookups.js";

export interface ReviewStateOptions {
  table?: string; // the DynamoDB table; no db lookups without one (the file store)
}

// Everything the page shows, without any summary. Each row carries its time
// (`at`, ISO) and series id for the page's filters, full Bee ids, and lookups.
export async function reviewState(store: SessionStore, opts: ReviewStateOptions = {}) {
  const { table } = opts;
  const db = <K>(f: (t: string, k: K) => Lookup, key: K) => (table ? [f(table, key)] : []);
  const series = await store.listSeries();
  const tz = defaultTimezone(series);
  const byId = new Map(series.map((s) => [s.id, s]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const when = (iso: string, seriesId?: string) => formatShort(Date.parse(iso), (seriesId && byId.get(seriesId)?.timezone) || tz);

  const [sessions, agenda, markers, notes, review, reviewItems] = await Promise.all([
    Promise.all(
      series.map(async (s) => ({
        seriesId: s.id,
        series: s.name,
        sessions: (await store.listSessions(s.id, SESSIONS_PER_SERIES)).map((v) => ({
          id: refId(v),
          at: v.start,
          when: when(v.start, s.id),
          minutes: minutes(v.start, v.end),
          parts: v.parts.length,
          beeIds: v.parts.map((p) => String(p.id)),
          versions: v.versions,
          tag: v.tag ? { source: v.tag.source, confidence: v.tag.confidence, status: v.tag.status, reason: v.tag.reason } : null,
          lookups: [...v.parts.map((p) => beeConversation(p.id)), ...db(dynamoQuery, itemKeys.sessionVersions(s.id, v.start))],
        })),
      })),
    ),
    Promise.all(
      series.map(async (s) => ({
        seriesId: s.id,
        series: s.name,
        items: openAgenda(await store.listAgenda(s.id), await store.getLatestSession(s.id)).map((i) => ({
          text: i.text,
          source: i.source ?? "you",
          at: i.createdAt,
          added: when(i.createdAt, s.id),
          journalId: i.journalId ?? null,
          lookups: [...(i.journalId ? [beeJournal(i.journalId)] : []), ...db(dynamoGet, itemKeys.agenda(i))],
        })),
      })),
    ),
    store.listMarkers(),
    store.listJournalRecords(),
    reviewSessions.call({}, { store }),
    store.listReviewItems(),
  ]);
  const reviewText = review.content[0]?.type === "text" ? review.content[0].text : "";
  const queue = reviewText.startsWith("{") ? JSON.parse(reviewText) : { line: null, sessions: [] };
  const itemsById = new Map(reviewItems.map((i) => [refId(i), i]));

  return {
    series: series.map((s) => ({ id: s.id, name: s.name, schedule: schedule(s), spokenNames: s.spokenNames })),
    sessions,
    markers: markers
      .slice(-LOG_LIMIT)
      .reverse()
      .map((m) => ({
        at: m.at,
        when: when(m.at, m.seriesId),
        kind: m.kind,
        seriesId: m.seriesId ?? null,
        series: m.seriesId ? nameOf(m.seriesId) : m.unclear ? "unclear" : "none named",
        journalId: m.journalId,
        lookups: [beeJournal(m.journalId), ...db(dynamoGet, itemKeys.marker(m))],
      })),
    voiceNotes: notes
      .slice(-LOG_LIMIT)
      .reverse()
      .map((r) => ({
        at: r.at,
        when: when(r.at, r.seriesId),
        kind: r.kind,
        status: r.status,
        seriesId: r.seriesId ?? null,
        series: r.seriesId ? nameOf(r.seriesId) : null,
        reason: r.reason ?? null,
        journalId: r.journalId,
        lookups: [beeJournal(r.journalId), ...db(dynamoGet, itemKeys.journal(r))],
      })),
    review: {
      line: queue.line as string | null,
      sessions: (queue.sessions as { id: string; guess: string; reason: string }[]).map((r) => {
        const item = itemsById.get(r.id);
        return {
          ...r,
          seriesId: item?.seriesId ?? null,
          at: item?.start ?? null,
          beeIds: item ? item.conversationIds.map(String) : [],
          lookups: item ? [...item.conversationIds.map(beeConversation), ...db(dynamoGet, itemKeys.review(item))] : [],
        };
      }),
    },
    agenda,
  };
}

export type ReviewState = Awaited<ReturnType<typeof reviewState>>;

// One session's short summary, for the "show" button.
export async function sessionSummary(store: SessionStore, id: string) {
  const ref = parseRefId(id);
  if (!ref) return null;
  const v = (await store.listSessions(ref.seriesId, 50)).find((x) => x.start === ref.start);
  return v ? { id: refId(v), shortSummary: v.parts.map((p) => p.shortSummary).filter(Boolean).join("\n") } : null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: unknown) {
  const isHtml = typeof body === "string";
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": isHtml ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
  });
  res.end(isHtml ? body : JSON.stringify(body));
}

export interface ReviewServerOptions extends ReviewStateOptions {
  bee?: BeeData; // the Bee data reader and its memory cache; one per server by default
}

// The review page's HTTP server. Listen on 127.0.0.1 only.
export function reviewServer(store: SessionStore, token: string, opts: ReviewServerOptions = {}): Server {
  const expected = digest(token);
  const beeData = opts.bee ?? new BeeData(store, { table: opts.table });
  const server = createServer(async (req, res) => {
    try {
      const port = (server.address() as AddressInfo).port;
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "Wrong host");
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const header = req.headers["x-review-token"];
      const presented = (typeof header === "string" ? header : undefined) ?? url.searchParams.get("token") ?? "";
      if (!timingSafeEqual(digest(presented), expected)) throw new HttpError(401, "Missing or wrong token");
      await route(store, beeData, req, res, url, opts);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof BeeCliError) return send(res, 502, { error: err.message });
      console.error("review page request failed:", (err as Error).name);
      send(res, 500, { error: "Something went wrong" });
    }
  });
  return server;
}

const TEXT_TYPES = ["journal", "conversation", "insight", "daily", "fact"];

async function route(store: SessionStore, beeData: BeeData, req: IncomingMessage, res: ServerResponse, url: URL, opts: ReviewStateOptions) {
  const path = url.pathname;
  if (path === "/schedule" || path.startsWith("/api/schedule")) {
    const reply = await scheduleRoute(store, req.method ?? "GET", url, () => readJson(req));
    if (reply) return send(res, reply.status, reply.body);
  }
  const q = url.searchParams;
  if (req.method === "GET" && path === "/") return send(res, 200, PAGE);
  if (req.method === "GET" && path === "/api/state") return send(res, 200, await reviewState(store, opts));
  if (req.method === "GET" && path === "/api/bee") {
    const days = Number(q.get("days") ?? DEFAULT_DAYS);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new HttpError(400, `days must be a whole number from 1 to ${MAX_DAYS}`);
    return send(res, 200, await beeData.rows(days, q.get("refresh") === "1"));
  }
  if (req.method === "GET" && path === "/api/bee/text") {
    const type = q.get("type") ?? "";
    const id = q.get("id") ?? "";
    const source = q.get("source") || undefined;
    if (!TEXT_TYPES.includes(type) || !id || (source !== undefined && source !== "keyword" && source !== "neural")) {
      throw new HttpError(400, "Send type, id and (for a search hit) source");
    }
    const parts = await beeData.text(type, id, source);
    if (!parts) throw new HttpError(404, "That row isn't in the Bee data read (try Refresh or search again)");
    return send(res, 200, { type, id, parts });
  }
  if (req.method === "GET" && path === "/api/search") {
    const text = (q.get("q") ?? "").trim();
    const mode = q.get("mode") ?? "exact";
    if (!text) throw new HttpError(400, "Type something to search for");
    if (text.length > MAX_QUERY) throw new HttpError(400, `Keep a search under ${MAX_QUERY} characters`);
    if (mode === "exact") {
      const scope = q.get("scope") ?? "marty";
      if (scope !== "marty" && scope !== "bee") throw new HttpError(400, "scope is marty or bee");
      return send(res, 200, await exactSearch(text, scope, await reviewState(store, opts), store, beeData));
    }
    if (mode !== "keyword" && mode !== "neural") throw new HttpError(400, "mode is exact, keyword or neural");
    // Bee would read a leading "-" as an option.
    if (text.startsWith("-")) throw new HttpError(400, "A Bee search can't start with -");
    const now = Date.now();
    const to = q.get("to") ? Date.parse(q.get("to")!) : now;
    const from = q.get("from") ? Date.parse(q.get("from")!) : to - DEFAULT_DAYS * DAY;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new HttpError(400, "from and to are ISO times, from before to");
    return send(res, 200, await (mode === "keyword" ? keywordSearch : neuralSearch)(text, from, to, store, beeData));
  }
  if (req.method === "GET" && path === "/api/summary") {
    const summary = await sessionSummary(store, url.searchParams.get("id") ?? "");
    if (!summary) throw new HttpError(404, "No stored session with that id");
    return send(res, 200, summary);
  }
  const edit = EDITS[path];
  if (req.method === "POST" && edit) {
    const body = await readJson(req);
    let result: CallToolResult;
    try {
      result = await edit(store, body);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof ZodError) throw new HttpError(400, "Invalid request");
      throw err;
    }
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    if (result.isError) throw new HttpError(400, text);
    return send(res, 200, { readback: text });
  }
  throw new HttpError(404, "Not found");
}

const MAX_BODY = 16 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Send JSON (Content-Type: application/json)");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {
    // Falls through to the error below.
  }
  throw new HttpError(400, "Send a JSON object");
}

// The edits run the same code as the retag_session and remove_agenda_item
// tools, and answer with the same read-back.
type Edit = (store: SessionStore, body: Record<string, unknown>) => Promise<CallToolResult>;
const EDITS: Record<string, Edit> = {
  "/api/retag": (store, { id, series, notASession }) => retagSession.call({ id, series, notASession }, { store }),
  "/api/confirm": (store, { id }) => {
    const ref = typeof id === "string" ? parseRefId(id) : null;
    if (!ref) throw new HttpError(400, "Send the session id to confirm");
    return retagSession.call({ id, series: ref.seriesId }, { store });
  },
  "/api/agenda/remove": (store, { series, text }) => removeAgendaItem.call({ series, text }, { store }),
};


async function main() {
  const args = process.argv.slice(2);
  const storeArg = args.find((a) => a.startsWith("--store="))?.slice(8) ?? (args.includes("--store") ? args[args.indexOf("--store") + 1] : "dynamo");
  const store = storeArg === "file" ? fileStore() : dynamoStore();
  const token = newToken();
  const server = reviewServer(store, token, storeArg === "file" ? {} : { table: TABLE_NAME });
  server.listen(Number(process.env.REVIEW_PORT ?? 8789), "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    console.log(`Between Sessions review page (${storeArg === "file" ? "file store" : "DynamoDB"}), local only. Open:`);
    console.log(`http://127.0.0.1:${port}/?token=${token}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
