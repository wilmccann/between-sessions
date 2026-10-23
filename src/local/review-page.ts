// The review page itself: inline HTML, CSS and JS only, nothing fetched from
// anywhere else. Two tabs, each with its own search bar that searches only
// that tab:
// - Marty: series, sessions, the review queue, agenda, markers and voice
//   notes from the store. Search: exact words.
// - Bee data: the last 14 days of Bee voice notes, conversations and
//   insights, read live once (until Refresh), with what Marty did with each.
//   Search: exact words, Bee keyword or Bee semantic.
// Text (summaries, note text, insight text) loads one row at a time when you
// press "show" and lives only in the page.
// Every render builds an array and passes [...].flat(2), nulls dropped, to replaceChildren:
// a nested array would print as "[object ...]", and a null as "null".
// No template literals or backslashes in the script: this is a template
// literal itself.
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Between Sessions: review</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; font-size: 14px; }
  body { margin: 1.5rem; max-width: 80rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } h3 { font-size: 1rem; margin-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #8884; vertical-align: top; }
  th { font-weight: 600; }
  .muted { opacity: .65; }
  .matched { font-size: .85em; }
  .pending { color: #b5651d; font-weight: 600; }
  .error { color: #c33; }
  .summary { white-space: pre-wrap; font-size: .9em; }
  #readback { padding: .6rem .8rem; border: 1px solid #8886; border-radius: 6px; display: none; margin-bottom: 1rem; }
  #readback.error { border-color: #c33; }
  .bar { display: flex; flex-wrap: wrap; gap: .4rem 1rem; align-items: end; padding: .6rem .8rem; border: 1px solid #8884; border-radius: 6px; margin-bottom: .6rem; }
  .bar label { display: flex; flex-direction: column; font-size: .85em; gap: .15rem; }
  .bar label.inline { flex-direction: row; align-items: center; gap: .3rem; }
  .bar input[type="search"] { min-width: 22rem; }
  .searchinfo { min-height: 1.2em; margin-bottom: .6rem; }
  #tabs { display: flex; gap: .3rem; border-bottom: 1px solid #8886; margin-bottom: 1rem; }
  .tab { border: 1px solid #8886; border-bottom: none; border-radius: 6px 6px 0 0; padding: .35rem .9rem; background: none; margin: 0; }
  .tab.active { font-weight: 600; background: #8882; }
  .ids { font-family: ui-monospace, monospace; font-size: .85em; word-break: break-all; }
  .lookup { font-size: .85em; }
  button, select, input { font: inherit; margin-right: .3rem; }
</style>
</head>
<body>
<h1>Between Sessions: review</h1>
<p><a id="nav-schedule">Schedule</a> <span class="muted">Local only (127.0.0.1). Summaries and Bee text stay hidden until you press "show". Bee data is read live and never stored.</span></p>
<div id="tabs" role="tablist"></div>
<section id="marty-tab">
<div id="marty-search" class="bar" role="search"></div>
<div id="marty-searchinfo" class="muted searchinfo" role="status"></div>
<div id="readback" role="status"></div>
<div id="filters" class="bar"></div>
<div id="app">Loading...</div>
</section>
<section id="bee-tab" hidden>
<div id="bee-search" class="bar" role="search"></div>
<div id="bee-searchinfo" class="muted searchinfo" role="status"></div>
<div id="bee-filters" class="bar"></div>
<div id="bee-app"></div>
</section>
<script>
"use strict";
const token = new URLSearchParams(location.search).get("token") || "";
document.getElementById("nav-schedule").setAttribute("href", "/schedule?token=" + encodeURIComponent(token));
let state = null; // the Marty tab
let bee = null; // the Bee data tab, read the first time it's opened
let beeLoading = false;
let beeError = "";
let tab = "marty";
// Each tab's latest search. Exact words keeps the matching row keys and
// where they matched; Bee keyword and semantic (Bee data tab only) keep
// their result rows.
const blankSearch = () => ({ q: "", ran: "", busy: false, error: "", matches: null, rows: null, beeError: "", beeText: true, cutShort: false });
const searches = { marty: blankSearch(), bee: blankSearch() };
const searchSeq = { marty: 0, bee: 0 };
// Text you pressed "show" for, by row key. Kept in this page only.
const shownText = new Map();

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

// rows: arrays of cells; classes: one class per row (optional).
function table(headers, rows, classes) {
  if (!rows.length) return el("p", { class: "muted" }, "None.");
  return el("table", {}, el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map((r, i) => el("tr", { class: (classes && classes[i]) || "" }, r.map((c) => el("td", {}, c))))));
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

// --- Bee text, one row at a time ---------------------------------------
async function fetchText(type, id, source) {
  const p = new URLSearchParams({ type: type, id: id });
  if (source) p.set("source", source);
  return (await api("/api/bee/text?" + p.toString())).parts;
}
const textBlock = (parts) => parts.length
  ? el("div", { class: "summary" }, parts.map((p) => el("div", {}, el("span", { class: "muted" }, p.label + ": "), p.text)))
  : el("span", { class: "muted" }, "(no text)");
function textCell(key, type, id, source) {
  if (shownText.has(key)) return textBlock(shownText.get(key));
  const out = el("div", {});
  const button = el("button", { onclick: async () => {
    try {
      shownText.set(key, await fetchText(type, id, source));
      out.replaceChildren(...[textBlock(shownText.get(key))].flat(2).filter((x) => x != null));
      button.remove();
    } catch (err) { out.textContent = err.message; }
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

// --- Search, one per tab -------------------------------------------------
const MODES = {
  marty: [["exact", "Exact words"]],
  bee: [["exact", "Exact words"], ["keyword", "Bee keyword"], ["neural", "Bee semantic"]],
};
const MODE_NAMES = { exact: "Exact words", keyword: "Bee keyword search", neural: "Bee semantic search" };
const HINTS = {
  marty: "Searches this tab, note text included once Bee data has been read; -word excludes.",
  bee: "Exact words filters the Bee data below (-word excludes); Bee keyword and semantic ask Bee and list its results here.",
};
const exactOn = (t) => searches[t].matches !== null;
const beeSearchOn = () => searches.bee.rows !== null;
// With an exact search on, a row shows only if it matched.
const searchKeep = (t, key) => !exactOn(t) || searches[t].matches.has(key);
const matchLabel = (r) => r.rank ? "#" + r.rank : "score " + r.score;
const matchedLine = (text) => el("div", { class: "muted matched" }, "matched: " + text);
// The muted "matched: ..." line under a row's first cell.
function matched(t, key) {
  if (!exactOn(t)) return null;
  const where = searches[t].matches.get(key);
  return where && where.length ? matchedLine(where.join(", ")) : null;
}

function renderSearchBar(t) {
  const input = el("input", { type: "search", id: t + "-q", maxlength: "200", "aria-label": "Search",
    placeholder: t === "bee" ? "Words, an id, or a question for Bee" : "Words or an id",
    onkeydown: (e) => { if (e.key === "Enter") runSearch(t); } });
  const mode = MODES[t].length > 1
    ? el("label", {}, "Mode", el("select", { id: t + "-mode", "aria-label": "Search mode" }, MODES[t].map(([v, x]) => el("option", { value: v }, x))))
    : null;
  document.getElementById(t + "-search").replaceChildren(...[
    el("label", {}, "Search", input),
    mode,
    el("button", { onclick: () => runSearch(t) }, "Search"),
    el("button", { onclick: () => clearSearch(t) }, "Clear"),
    el("span", { class: "muted" }, HINTS[t]),
  ].flat(2).filter((x) => x != null));
}

function renderSearchInfo(t) {
  const s = searches[t];
  const quoted = '"' + s.q + '"';
  let parts = [];
  if (s.busy) parts = [t === "bee" ? "Searching... (the first Bee call can take about 20 s)" : "Searching..."];
  else if (s.error) parts = [el("span", { class: "error" }, s.error)];
  else if (exactOn(t)) parts = ["Exact words " + quoted + ": " + s.matches.size + " matching rows.",
    s.beeText ? null : " Note text wasn't searched: open the Bee data tab once to read it.",
    s.beeError ? el("span", { class: "error" }, " Bee data not searched: " + s.beeError) : null];
  else if (t === "bee" && beeSearchOn()) parts = [MODE_NAMES[s.ran] + " " + quoted + ": " + s.rows.length + " results.",
    s.cutShort ? " May be cut short (Bee returns 50 at most)." : null];
  document.getElementById(t + "-searchinfo").replaceChildren(...[parts].flat(2).filter((x) => x != null));
}

function renderTab(t) {
  if (t === "marty") { if (state) render(); }
  else renderBee();
}

async function runSearch(t) {
  const q = document.getElementById(t + "-q").value.trim();
  const modeSelect = document.getElementById(t + "-mode");
  const mode = modeSelect ? modeSelect.value : "exact";
  if (!q) return clearSearch(t);
  const s = searches[t];
  const seq = ++searchSeq[t];
  Object.assign(s, { q: q, busy: true, error: "" });
  renderSearchInfo(t);
  const params = new URLSearchParams({ q: q, mode: mode });
  if (mode === "exact") params.set("scope", t);
  // Bee searches use the Bee data tab's time range, if set.
  if (mode !== "exact" && beeFilters.from) params.set("from", new Date(beeFilters.from).toISOString());
  if (mode !== "exact" && beeFilters.to) params.set("to", new Date(beeFilters.to).toISOString());
  let result = null;
  let error = "";
  try { result = await api("/api/search?" + params.toString()); } catch (err) { error = err.message; }
  if (seq !== searchSeq[t]) return; // a newer search started
  Object.assign(s, blankSearch(), { q: q, ran: mode, error: error });
  if (result && mode === "exact") {
    s.matches = new Map(result.matches.map((m) => [m.key, m.matchedIn]));
    s.beeError = result.beeError || "";
    s.beeText = result.beeText !== false;
  } else if (result) {
    s.rows = result.rows;
    s.cutShort = !!result.cutShort;
  }
  renderSearchInfo(t);
  renderTab(t);
}

function clearSearch(t) {
  searchSeq[t]++;
  document.getElementById(t + "-q").value = "";
  Object.assign(searches[t], blankSearch());
  renderSearchInfo(t);
  renderTab(t);
}

// --- Tabs ----------------------------------------------------------------
function renderTabs() {
  const button = (id, label) => el("button", { role: "tab", "aria-selected": String(tab === id), class: tab === id ? "tab active" : "tab", onclick: () => showTab(id) }, label);
  document.getElementById("tabs").replaceChildren(...[button("marty", "Marty"), button("bee", "Bee data")].flat(2).filter((x) => x != null));
  document.getElementById("marty-tab").hidden = tab !== "marty";
  document.getElementById("bee-tab").hidden = tab !== "bee";
}

function showTab(id) {
  tab = id;
  renderTabs();
  if (id === "bee" && !bee && !beeLoading) loadBee(false);
}

// --- Marty tab -----------------------------------------------------------
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
  document.getElementById("filters").replaceChildren(...[
    choose("series", "Series", [...s.series.map((x) => [x.id, x.name]), ["(none)", "None named"]]),
    choose("kind", "Kind", kinds.map((k) => [k, k])),
    choose("status", "Status", statuses.map((k) => [k, k])),
    date("from", "From"),
    date("to", "To"),
    el("button", { onclick: () => { Object.assign(filters, { series: "", kind: "", status: "", from: "", to: "" }); renderFilters(); render(); } }, "Clear"),
    el("span", { class: "muted" }, "Kind applies to markers and voice notes; status to sessions and voice notes."),
  ].flat(2).filter((x) => x != null));
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
// Row keys, the same as the server's search: see src/local/search.ts.
const agendaKey = (g, i) => "agenda:" + g.seriesId + "@" + i.at;

function render() {
  const s = state;
  const found = (key) => searchKeep("marty", key);
  const review = s.review.sessions.filter((r) => keep(r, { series: r.seriesId }) && found("review:" + r.id));
  const seriesRows = s.series.filter((x) => found("series:" + x.id));
  const markers = s.markers.filter((m) => keep(m, { series: m.seriesId, kind: m.kind }) && found("marker:" + m.journalId));
  const notes = s.voiceNotes.filter((n) => keep(n, { series: n.seriesId, kind: n.kind, status: n.status }) && found("note:" + n.journalId));
  const bySeries = (g) => !filters.series || filters.series === g.seriesId;
  const sessions = s.sessions.filter(bySeries).map((g) => ({ ...g, rows: g.sessions.filter((x) => keep(x, { status: x.tag ? x.tag.status : "untagged" }) && found("session:" + x.id)) }));
  const agenda = s.agenda.filter(bySeries).map((g) => ({ ...g, rows: g.items.filter((i) => keep(i, {}) && found(agendaKey(g, i))) }));
  const allSessions = s.sessions.flatMap((g) => g.sessions);
  const allAgenda = s.agenda.flatMap((g) => g.items);
  // The per-series sections are nested arrays; .flat(2) makes them one list.
  document.getElementById("app").replaceChildren(...[
    shown("Review queue", s.review.sessions, review),
    el("p", {}, s.review.line || "Nothing to review."),
    table(["Id", "When", "Minutes", "Guess", "Filed", "Reason", "Bee ids", "Expires in", "Look up", ""],
      review.map((r) => [[el("code", {}, r.id), matched("marty", "review:" + r.id)], r.when, r.durationMinutes, r.guess, r.filed ? "yes" : "no", r.reason, ids(r.beeIds), r.expiresInDays + " days", lookups(r.lookups), reviewActions(r)])),
    shown("Series", s.series, seriesRows),
    table(["Id", "Name", "Schedule", "Spoken names"], seriesRows.map((x) => [[el("code", {}, x.id), matched("marty", "series:" + x.id)], x.name, x.schedule, x.spokenNames.join(", ")])),
    shown("Sessions", allSessions, sessions.flatMap((g) => g.rows)),
    sessions.map((g) => [
      el("h3", {}, g.series),
      table(["When", "Minutes", "Parts", "Bee ids", "Tag", "Summary", "Look up", ""],
        g.rows.map((x) => [[x.when, matched("marty", "session:" + x.id)], x.minutes, x.parts, ids(x.beeIds), tagText(x.tag), summaryButton(x.id), lookups(x.lookups), sessionActions(x, g)])),
    ]),
    shown("Open agenda", allAgenda, agenda.flatMap((g) => g.rows)),
    agenda.map((g) => [
      el("h3", {}, g.series),
      table(["Item", "From", "Added", "Look up", ""], g.rows.map((i) => [[i.text, matched("marty", agendaKey(g, i))], i.source, i.added, lookups(i.lookups), agendaActions(i, g)])),
    ]),
    shown("Markers", s.markers, markers),
    table(["When", "Kind", "Series", "Voice note", "Look up"], markers.map((m) => [[m.when, matched("marty", "marker:" + m.journalId)], m.kind, m.series, ids([m.journalId]), lookups(m.lookups)])),
    shown("Voice notes", s.voiceNotes, notes),
    table(["When", "Kind", "Status", "Series", "Reason", "Voice note", "Text", "Look up"],
      notes.map((n) => [[n.when, matched("marty", "note:" + n.journalId)], n.kind, n.status, n.series || "", n.reason || "", ids([n.journalId]),
        textCell("journal:" + n.journalId, "journal", n.journalId), lookups(n.lookups)])),
  ].flat(2).filter((x) => x != null));
}

async function load() {
  try { state = await api("/api/state"); renderFilters(); render(); }
  catch (err) { document.getElementById("app").textContent = "Couldn't load: " + err.message; }
}

// --- Bee data tab --------------------------------------------------------
const BEE_TYPES = ["journal", "conversation", "insight", "daily", "fact"];
const beeFilters = { type: "", from: "", to: "", notCaptured: false };

async function loadBee(refresh) {
  beeLoading = true;
  beeError = "";
  renderBee();
  try { bee = await api("/api/bee" + (refresh ? "?refresh=1" : "")); }
  catch (err) { beeError = err.message; }
  beeLoading = false;
  renderBee();
}

function renderBeeFilters() {
  const type = el("select", { onchange: () => { beeFilters.type = type.value; renderBee(); } },
    el("option", { value: "" }, "All"), BEE_TYPES.map((t) => el("option", { value: t }, t)));
  type.value = beeFilters.type;
  const when = (key, label) => {
    const input = el("input", { type: "datetime-local", value: beeFilters[key], onchange: () => { beeFilters[key] = input.value; renderBee(); } });
    return el("label", {}, label, input);
  };
  const box = el("input", { type: "checkbox", onchange: () => { beeFilters.notCaptured = box.checked; renderBee(); } });
  box.checked = beeFilters.notCaptured;
  document.getElementById("bee-filters").replaceChildren(...[
    el("label", {}, "Type", type),
    when("from", "From"),
    when("to", "To"),
    el("label", { class: "inline" }, box, "Only not captured by Marty"),
    el("button", { onclick: () => { Object.assign(beeFilters, { type: "", from: "", to: "", notCaptured: false }); renderBeeFilters(); renderBee(); } }, "Clear filters"),
    el("button", { onclick: () => loadBee(true) }, "Refresh"),
    el("button", { onclick: showAll }, "Show all text"),
    el("span", { class: "muted", id: "bee-status" }),
  ].flat(2).filter((x) => x != null));
}

// The rows on screen: Bee search results while a Bee search is on, else the
// Bee data read; then the type, time range, "not captured" and exact search.
function beeRowsShown() {
  const source = beeSearchOn() ? searches.bee.rows : bee ? bee.rows : [];
  const from = beeFilters.from ? new Date(beeFilters.from).getTime() : -Infinity;
  const to = beeFilters.to ? new Date(beeFilters.to).getTime() + 60000 : Infinity;
  return source.filter((r) => {
    if (beeFilters.type && r.type !== beeFilters.type) return false;
    if (beeFilters.notCaptured && r.marty !== null) return false;
    if (!searchKeep("bee", r.key)) return false;
    const t = Date.parse(r.start || r.createdAt || "");
    if ((beeFilters.from || beeFilters.to) && !(t >= from && t < to)) return false;
    return true;
  });
}

const fmt = (iso) => iso ? new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const startEnd = (r) => !r.start ? "" : fmt(r.start) + " to " + (r.end ? new Date(r.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "(in progress)");
const martyCell = (r) => r.marty === null ? el("span", { class: "muted" }, "not captured") : r.marty;

function renderBee() {
  const searching = beeSearchOn();
  const found = searches.bee;
  if (!searching && (beeLoading || beeError || !bee)) {
    const message = beeLoading ? el("p", { class: "muted" }, "Loading Bee data (the first call can take about 20 s)...")
      : beeError ? el("p", { class: "error" }, "Couldn't read Bee data: " + beeError) : null;
    document.getElementById("bee-app").replaceChildren(...[message].flat(2).filter((x) => x != null));
    return;
  }
  const all = searching ? found.rows : bee.rows;
  const rows = beeRowsShown();
  const notes = [];
  if (searching && found.cutShort) notes.push(el("p", { class: "pending" }, "May be cut short: Bee returned its limit of 50 results."));
  if (!searching && (bee.cutShort.journals || bee.cutShort.conversations || bee.cutShort.insights)) notes.push(el("p", { class: "pending" }, "May be cut short: stopped after 30 pages."));
  // Bee's semantic search gives start and end only, so no Created or Updated.
  const dated = !(searching && found.ran === "neural");
  const headers = ["Type", "Id"].concat(dated ? ["Created", "Updated"] : [], ["Start and end", "State", "Marty", "Text", "Look up"]);
  document.getElementById("bee-app").replaceChildren(...[
    el("h2", {}, searching ? MODE_NAMES[found.ran] + ' results for "' + found.q + '"' : "Bee data, last " + bee.days + " days",
      el("span", { class: "muted" }, " (" + rows.length + " of " + all.length + ")")),
    el("p", { class: "muted" }, searching
      ? (found.ran === "neural" ? "Most relevant first. " : "Best score first. ") + "Clear the search to see all Bee data."
      : "Read from Bee at " + fmt(bee.loadedAt) + " and kept until Refresh; nothing is stored. Text stays hidden until you press show."),
    notes,
    table(searching ? ["Match"].concat(headers) : headers, rows.map((r) => (searching ? [matchLabel(r)] : []).concat(
      [r.type, [el("span", { class: "ids" }, r.id), r.matchedIn ? matchedLine(r.matchedIn.join(", ")) : matched("bee", r.key)]],
      dated ? [fmt(r.createdAt), fmt(r.updatedAt)] : [],
      [
        startEnd(r),
        r.state || "",
        martyCell(r),
        r.hasText ? textCell(r.key, r.type, r.id, r.source) : el("span", { class: "muted" }, "(no text)"),
        lookups(r.lookups),
      ],
    ))),
  ].flat(2).filter((x) => x != null));
}

// Fetches the text of the rows on screen, one row at a time.
async function showAll() {
  const todo = beeRowsShown().filter((r) => r.hasText && !shownText.has(r.key));
  const status = () => document.getElementById("bee-status");
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i];
    status().textContent = "Loading text " + (i + 1) + " of " + todo.length + "...";
    try { shownText.set(r.key, await fetchText(r.type, r.id, r.source)); }
    catch (err) { status().textContent = err.message; renderBee(); return; }
  }
  status().textContent = "";
  renderBee();
}

renderSearchBar("marty");
renderSearchBar("bee");
renderTabs();
renderBeeFilters();
load();
</script>
</body>
</html>
`;
