// Local review page (`yarn review-ui [--store file]`): series, sessions with
// their tags, markers, voice notes, the review queue and open agenda items,
// on 127.0.0.1 only. Every request needs the right Host header (no DNS
// rebinding) and the random token made at launch. Summaries stay out of the
// page's state; one session's short summary loads only when you ask for it.
// Inline HTML, CSS and JS only: nothing is fetched from anywhere else.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { minutes } from "../mcp/tool.js";
import reviewSessions from "../mcp/tools/review-sessions.js";
import { parseRefId, refId } from "../review.js";
import { defaultTimezone, hasSchedule, type Series } from "../series.js";
import { openAgenda } from "../store/agenda.js";
import { dynamoStore } from "../store/dynamo-store.js";
import { fileStore } from "../store/file-store.js";
import type { SessionStore } from "../store/types.js";
import { formatShort } from "../time.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SESSIONS_PER_SERIES = 20;
const LOG_LIMIT = 50; // markers and voice notes, newest first
const last4 = (id: string | number) => String(id).slice(-4);

const schedule = (s: Series) => (hasSchedule(s) ? `${WEEKDAYS[s.weekday]} ${s.windowStart} to ${s.windowEnd}` : "unscheduled");

// Everything the page shows, without any summary.
export async function reviewState(store: SessionStore) {
  const series = await store.listSeries();
  const tz = defaultTimezone(series);
  const byId = new Map(series.map((s) => [s.id, s]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const when = (iso: string, seriesId?: string) => formatShort(Date.parse(iso), (seriesId && byId.get(seriesId)?.timezone) || tz);

  const [sessions, agenda, markers, notes, review] = await Promise.all([
    Promise.all(
      series.map(async (s) => ({
        seriesId: s.id,
        series: s.name,
        sessions: (await store.listSessions(s.id, SESSIONS_PER_SERIES)).map((v) => ({
          id: refId(v),
          when: when(v.start, s.id),
          minutes: minutes(v.start, v.end),
          parts: v.parts.length,
          beeIds: v.parts.map((p) => last4(p.id)),
          versions: v.versions,
          tag: v.tag ? { source: v.tag.source, confidence: v.tag.confidence, status: v.tag.status, reason: v.tag.reason } : null,
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
          added: when(i.createdAt, s.id),
        })),
      })),
    ),
    store.listMarkers(),
    store.listJournalRecords(),
    reviewSessions.call({}, { store }),
  ]);
  const reviewText = review.content[0]?.type === "text" ? review.content[0].text : "";
  const queue = reviewText.startsWith("{") ? JSON.parse(reviewText) : { line: null, sessions: [] };

  return {
    series: series.map((s) => ({ id: s.id, name: s.name, schedule: schedule(s), spokenNames: s.spokenNames })),
    sessions,
    markers: markers
      .slice(-LOG_LIMIT)
      .reverse()
      .map((m) => ({
        when: when(m.at, m.seriesId),
        kind: m.kind,
        series: m.seriesId ? nameOf(m.seriesId) : m.unclear ? "unclear" : "none named",
        journal: last4(m.journalId),
      })),
    voiceNotes: notes
      .slice(-LOG_LIMIT)
      .reverse()
      .map((r) => ({
        when: when(r.at, r.seriesId),
        kind: r.kind,
        status: r.status,
        series: r.seriesId ? nameOf(r.seriesId) : null,
        reason: r.reason ?? null,
        journal: last4(r.journalId),
      })),
    review: { line: queue.line as string | null, sessions: queue.sessions as unknown[] },
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

// The review page's HTTP server. Listen on 127.0.0.1 only.
export function reviewServer(store: SessionStore, token: string): Server {
  const expected = digest(token);
  const server = createServer(async (req, res) => {
    try {
      const port = (server.address() as AddressInfo).port;
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "Wrong host");
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const header = req.headers["x-review-token"];
      const presented = (typeof header === "string" ? header : undefined) ?? url.searchParams.get("token") ?? "";
      if (!timingSafeEqual(digest(presented), expected)) throw new HttpError(401, "Missing or wrong token");
      await route(store, req, res, url);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error("review page request failed:", (err as Error).name);
      send(res, 500, { error: "Something went wrong" });
    }
  });
  return server;
}

async function route(store: SessionStore, req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname;
  if (req.method === "GET" && path === "/") return send(res, 200, PAGE);
  if (req.method === "GET" && path === "/api/state") return send(res, 200, await reviewState(store));
  if (req.method === "GET" && path === "/api/summary") {
    const summary = await sessionSummary(store, url.searchParams.get("id") ?? "");
    if (!summary) throw new HttpError(404, "No stored session with that id");
    return send(res, 200, summary);
  }
  throw new HttpError(404, "Not found");
}

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
  button, select { font: inherit; margin-right: .3rem; }
</style>
</head>
<body>
<h1>Between Sessions: review</h1>
<p class="muted">Local only (127.0.0.1). Summaries stay hidden unless you press "show".</p>
<div id="readback" role="status"></div>
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

function sessionActions() { return null; }
function reviewActions() { return null; }
function agendaActions() { return null; }

function render() {
  const s = state;
  const app = document.getElementById("app");
  app.replaceChildren(
    el("h2", {}, "Review queue"),
    el("p", {}, s.review.line || "Nothing to review."),
    table(["Id", "When", "Minutes", "Guess", "Filed", "Reason", "Bee id", "Expires in", ""],
      s.review.sessions.map((r) => [el("code", {}, r.id), r.when, r.durationMinutes, r.guess, r.filed ? "yes" : "no", r.reason, r.beeId, r.expiresInDays + " days", reviewActions(r)])),
    el("h2", {}, "Series"),
    table(["Id", "Name", "Schedule", "Spoken names"], s.series.map((x) => [el("code", {}, x.id), x.name, x.schedule, x.spokenNames.join(", ")])),
    el("h2", {}, "Sessions"),
    s.sessions.map((g) => [
      el("h3", {}, g.series),
      table(["When", "Minutes", "Parts", "Bee ids", "Tag", "Summary", ""],
        g.sessions.map((x) => [x.when, x.minutes, x.parts, x.beeIds.join(", "), tagText(x.tag), summaryButton(x.id), sessionActions(x, g)])),
    ]),
    el("h2", {}, "Open agenda"),
    s.agenda.map((g) => [
      el("h3", {}, g.series),
      table(["Item", "From", "Added", ""], g.items.map((i) => [i.text, i.source, i.added, agendaActions(i, g)])),
    ]),
    el("h2", {}, "Markers"),
    table(["When", "Kind", "Series", "Voice note"], s.markers.map((m) => [m.when, m.kind, m.series, m.journal])),
    el("h2", {}, "Voice notes"),
    table(["When", "Kind", "Status", "Series", "Reason", "Voice note"],
      s.voiceNotes.map((n) => [n.when, n.kind, n.status, n.series || "", n.reason || "", n.journal])),
  );
}

async function load() {
  try { state = await api("/api/state"); render(); }
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
  const server = reviewServer(store, token);
  server.listen(Number(process.env.REVIEW_PORT ?? 8789), "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    console.log(`Between Sessions review page (${storeArg === "file" ? "file store" : "DynamoDB"}), local only. Open:`);
    console.log(`http://127.0.0.1:${port}/?token=${token}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
