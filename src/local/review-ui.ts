// Local review page (`yarn review-ui [--store file]`): series, sessions with
// their tags, markers, voice notes, the review queue and open agenda items,
// on 127.0.0.1 only. Every request needs the right Host header (no DNS
// rebinding) and the random token made at launch. Summaries stay out of the
// page's state; one session's short summary loads only when you ask for it.
// Edits (retag, not a session, confirm, remove an agenda item) run the same
// code as the MCP tools and show the same read-back; they need JSON, so a
// plain cross-site form can't send one.
// Inline HTML, CSS and JS only: nothing is fetched from anywhere else.
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
import { formatShort } from "../time.js";
import { BeeCliError, BeeData, DEFAULT_DAYS, MAX_DAYS } from "./bee-data.js";
import { beeConversation, beeJournal, dynamoGet, dynamoQuery, type Lookup } from "./lookups.js";

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
      sessions: (queue.sessions as { id: string }[]).map((r) => {
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

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Between Sessions: review</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; font-size: 14px; }
  body { margin: 1.5rem; max-width: 72rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } h3 { font-size: 1rem; margin-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #8884; vertical-align: top; }
  th { font-weight: 600; }
  .muted { opacity: .65; }
  .pending { color: #b5651d; font-weight: 600; }
  .summary { white-space: pre-wrap; font-size: .9em; }
  #readback { padding: .6rem .8rem; border: 1px solid #8886; border-radius: 6px; display: none; margin-bottom: 1rem; }
  #readback.error { border-color: #c33; }
  #filters { display: flex; flex-wrap: wrap; gap: .4rem 1rem; align-items: end; padding: .6rem .8rem; border: 1px solid #8884; border-radius: 6px; }
  #filters label { display: flex; flex-direction: column; font-size: .85em; gap: .15rem; }
  .ids { font-family: ui-monospace, monospace; font-size: .85em; word-break: break-all; }
  .lookup { font-size: .85em; }
  button, select { font: inherit; margin-right: .3rem; }
</style>
</head>
<body>
<h1>Between Sessions: review</h1>
<p class="muted">Local only (127.0.0.1). Summaries stay hidden unless you press "show".</p>
<div id="readback" role="status"></div>
<div id="filters"></div>
<div id="app">Loading...</div>
<script>
"use strict";
const token = new URLSearchParams(location.search).get("token") || "";
let state = null;

async function api(path, body) {
  const init = body === undefined
    ? { headers: { "X-Review-Token": token } }
    : { method: "POST", headers: { "X-Review-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c));
  return e;
}

function table(headers, rows) {
  if (!rows.length) return el("p", { class: "muted" }, "None.");
  return el("table", {}, el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, c))))));
}

function showReadback(text, isError) {
  const box = document.getElementById("readback");
  box.textContent = text;
  box.className = isError ? "error" : "";
  box.style.display = "block";
}

function summaryButton(id) {
  const out = el("div", { class: "summary" });
  const button = el("button", { onclick: async () => {
    try { out.textContent = (await api("/api/summary?id=" + encodeURIComponent(id))).shortSummary || "(no summary)"; button.remove(); }
    catch (err) { out.textContent = err.message; }
  } }, "show");
  return el("span", {}, button, out);
}

const tagText = (t) => t ? [t.source + ", " + t.confidence + ", ", el("span", { class: t.status === "pending" ? "pending" : "" }, t.status), el("div", { class: "muted" }, t.reason)] : el("span", { class: "muted" }, "untagged");

async function edit(path, body) {
  try { showReadback((await api(path, body)).readback, false); }
  catch (err) { showReadback(err.message, true); }
  await load();
}

// Move to another series, confirm the current one, or say it wasn't a session.
function retagControls(id, currentSeriesId, confirmed) {
  // Starts on a blank choice, so a stray click on Move does nothing.
  const select = el("select", { "aria-label": "Move to series" }, el("option", { value: "" }, "Move to..."),
    state.series.filter((x) => x.id !== currentSeriesId).map((x) => el("option", { value: x.id }, x.name)));
  return el("span", {},
    select,
    el("button", { onclick: () => { if (select.value) edit("/api/retag", { id, series: select.value }); } }, "Move"),
    confirmed ? null : el("button", { onclick: () => edit("/api/confirm", { id }) }, "Confirm"),
    el("button", { onclick: () => {
      if (confirm("Mark this as not a session? Its stored summaries are deleted; your notes are kept.")) edit("/api/retag", { id, notASession: true });
    } }, "Not a session"),
  );
}

function sessionActions(x, g) { return retagControls(x.id, g.seriesId, x.tag && x.tag.status === "confirmed"); }
function reviewActions(r) { return retagControls(r.id, r.id.slice(0, r.id.lastIndexOf("@")), false); }
function agendaActions(i, g) {
  return el("button", { onclick: () => edit("/api/agenda/remove", { series: g.seriesId, text: i.text }) }, "Remove");
}

// Filters apply to the sections that have the field: kind to markers and
// voice notes, status to sessions (their tag) and voice notes.
const filters = { series: "", kind: "", status: "", from: "", to: "" };
const dayStart = (d) => new Date(d + "T00:00").getTime();
function keep(row, fields) {
  if (filters.series && fields.series !== undefined && (fields.series || "(none)") !== filters.series) return false;
  if (filters.kind && fields.kind !== undefined && fields.kind !== filters.kind) return false;
  if (filters.status && fields.status !== undefined && fields.status !== filters.status) return false;
  const t = row.at ? Date.parse(row.at) : NaN;
  if (filters.from && !(t >= dayStart(filters.from))) return false;
  if (filters.to && !(t < dayStart(filters.to) + 86400000)) return false;
  return true;
}

function renderFilters() {
  const s = state;
  const distinct = (xs) => [...new Set(xs.filter(Boolean))].sort();
  const kinds = distinct([...s.markers, ...s.voiceNotes].map((r) => r.kind));
  const statuses = distinct([...s.voiceNotes.map((n) => n.status), ...s.sessions.flatMap((g) => g.sessions.map((x) => x.tag ? x.tag.status : "untagged"))]);
  const choose = (key, label, options) => {
    const select = el("select", { onchange: () => { filters[key] = select.value; render(); } },
      el("option", { value: "" }, "All"), options.map(([v, text]) => el("option", { value: v }, text)));
    select.value = filters[key];
    return el("label", {}, label, select);
  };
  const date = (key, label) => {
    const input = el("input", { type: "date", value: filters[key], onchange: () => { filters[key] = input.value; render(); } });
    return el("label", {}, label, input);
  };
  document.getElementById("filters").replaceChildren(
    choose("series", "Series", [...s.series.map((x) => [x.id, x.name]), ["(none)", "None named"]]),
    choose("kind", "Kind", kinds.map((k) => [k, k])),
    choose("status", "Status", statuses.map((k) => [k, k])),
    date("from", "From"),
    date("to", "To"),
    el("button", { onclick: () => { Object.assign(filters, { series: "", kind: "", status: "", from: "", to: "" }); renderFilters(); render(); } }, "Clear"),
    el("span", { class: "muted" }, "Kind applies to markers and voice notes; status to sessions and voice notes."),
  );
}

// One button per lookup: copies the command; hover shows it.
function lookups(list) {
  return el("span", { class: "lookup" }, (list || []).map((l) => {
    const b = el("button", { title: l.command, onclick: async () => {
      try { await navigator.clipboard.writeText(l.command); b.textContent = "copied"; setTimeout(() => { b.textContent = l.label; }, 1200); }
      catch { window.prompt("Copy this command:", l.command); }
    } }, l.label);
    return b;
  }));
}

const ids = (xs) => el("span", { class: "ids" }, xs.join(", "));
const shown = (title, all, rows) => el("h2", {}, title, all.length ? el("span", { class: "muted" }, " (" + rows.length + " of " + all.length + ")") : null);

function render() {
  const s = state;
  const app = document.getElementById("app");
  const review = s.review.sessions.filter((r) => keep(r, { series: r.seriesId }));
  const markers = s.markers.filter((m) => keep(m, { series: m.seriesId, kind: m.kind }));
  const notes = s.voiceNotes.filter((n) => keep(n, { series: n.seriesId, kind: n.kind, status: n.status }));
  const bySeries = (g) => !filters.series || filters.series === g.seriesId;
  const sessions = s.sessions.filter(bySeries).map((g) => ({ ...g, rows: g.sessions.filter((x) => keep(x, { status: x.tag ? x.tag.status : "untagged" })) }));
  const agenda = s.agenda.filter(bySeries).map((g) => ({ ...g, rows: g.items.filter((i) => keep(i, {})) }));
  const allSessions = s.sessions.flatMap((g) => g.sessions);
  const allAgenda = s.agenda.flatMap((g) => g.items);
  // The per-series sections are nested arrays; replaceChildren would print them as text.
  app.replaceChildren(...[
    shown("Review queue", s.review.sessions, review),
    el("p", {}, s.review.line || "Nothing to review."),
    table(["Id", "When", "Minutes", "Guess", "Filed", "Reason", "Bee ids", "Expires in", "Look up", ""],
      review.map((r) => [el("code", {}, r.id), r.when, r.durationMinutes, r.guess, r.filed ? "yes" : "no", r.reason, ids(r.beeIds), r.expiresInDays + " days", lookups(r.lookups), reviewActions(r)])),
    el("h2", {}, "Series"),
    table(["Id", "Name", "Schedule", "Spoken names"], s.series.map((x) => [el("code", {}, x.id), x.name, x.schedule, x.spokenNames.join(", ")])),
    shown("Sessions", allSessions, sessions.flatMap((g) => g.rows)),
    sessions.map((g) => [
      el("h3", {}, g.series),
      table(["When", "Minutes", "Parts", "Bee ids", "Tag", "Summary", "Look up", ""],
        g.rows.map((x) => [x.when, x.minutes, x.parts, ids(x.beeIds), tagText(x.tag), summaryButton(x.id), lookups(x.lookups), sessionActions(x, g)])),
    ]),
    shown("Open agenda", allAgenda, agenda.flatMap((g) => g.rows)),
    agenda.map((g) => [
      el("h3", {}, g.series),
      table(["Item", "From", "Added", "Look up", ""], g.rows.map((i) => [i.text, i.source, i.added, lookups(i.lookups), agendaActions(i, g)])),
    ]),
    shown("Markers", s.markers, markers),
    table(["When", "Kind", "Series", "Voice note", "Look up"], markers.map((m) => [m.when, m.kind, m.series, ids([m.journalId]), lookups(m.lookups)])),
    shown("Voice notes", s.voiceNotes, notes),
    table(["When", "Kind", "Status", "Series", "Reason", "Voice note", "Look up"],
      notes.map((n) => [n.when, n.kind, n.status, n.series || "", n.reason || "", ids([n.journalId]), lookups(n.lookups)])),
  ].flat(2));
}

async function load() {
  try { state = await api("/api/state"); renderFilters(); render(); }
  catch (err) { document.getElementById("app").textContent = "Couldn't load: " + err.message; }
}
load();
</script>
</body>
</html>
`;

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
