import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { newToken, reviewServer } from "../src/local/review-ui.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import type { SessionInput, SessionTag } from "../src/store/types.js";
import { acme, coaching, other, therapy } from "./fixtures/meeting-types.js";

// All synthetic, October 2026 in New York.
const session = (start: string, end: string, id: number, tag: SessionTag): SessionInput => ({
  start,
  end,
  parts: [{ id, start, end, shortSummary: `Synthetic short ${id}`, summary: `Synthetic long summary ${id}` }],
  insights: [],
  tag,
});
const COACHING = "2026-10-15T20:02:00.000Z";
const THERAPY = "2026-10-20T21:00:00.000Z";
const OTHER = "2026-10-21T18:00:00.000Z";
const ACME_GUESS = "2026-10-19T15:00:00.000Z";

export async function seed(store: TableStore) {
  for (const s of [therapy, coaching, acme, other]) await store.putSeries(s);
  await store.recordSession(
    coaching.id,
    session(COACHING, "2026-10-15T20:55:00.000Z", 900111, { source: "schedule", confidence: "high", status: "auto", reason: "Thu 16:00 to 17:00 slot" }),
    "2026-10-15T21:30:00.000Z",
  );
  await store.recordSession(
    therapy.id,
    session(THERAPY, "2026-10-20T22:00:00.000Z", 900222, { source: "marker", confidence: "certain", status: "auto", reason: "Your markers" }),
    "2026-10-20T22:30:00.000Z",
  );
  await store.recordSession(
    other.id,
    session(OTHER, "2026-10-21T18:30:00.000Z", 900333, { source: "marker", confidence: "low", status: "pending", reason: "Unnamed start marker" }),
    "2026-10-21T19:00:00.000Z",
  );
  await store.putReviewItem({
    seriesId: other.id,
    start: OTHER,
    end: "2026-10-21T18:30:00.000Z",
    conversationIds: [900333],
    source: "marker",
    reason: "Unnamed start marker",
    filed: true,
    dropsAt: "2026-11-04T18:00:00.000Z",
  });
  await store.putReviewItem({
    seriesId: acme.id,
    start: ACME_GUESS,
    end: "2026-10-19T15:45:00.000Z",
    conversationIds: [900444],
    source: "keyword",
    reason: "Keyword acme",
    filed: false,
    dropsAt: "2026-11-02T15:00:00.000Z",
  });
  await store.putMarker({ journalId: "jrnl-synthetic-1111", kind: "start", at: OTHER });
  await store.putMarker({ journalId: "jrnl-synthetic-2222", kind: "end", at: "2026-10-21T18:30:00.000Z" });
  await store.putJournalRecord({ journalId: "jrnl-synthetic-1111", at: OTHER, kind: "start", status: "filed" });
  await store.putJournalRecord({ journalId: "jrnl-synthetic-3333", at: "2026-10-21T19:00:00.000Z", kind: "note", status: "ignored" });
  await store.addAgendaItem(coaching.id, "Synthetic: bring up the trip", { source: "bee", journalId: "jrnl-synthetic-4444", createdAt: "2026-10-21T12:00:00.000Z" });
  await store.addAgendaItem(therapy.id, "Synthetic: sleep", { createdAt: "2026-10-21T13:00:00.000Z" });
  await store.saveTakeaway(other.id, OTHER, "Synthetic takeaway", { createdAt: "2026-10-21T18:40:00.000Z" });
}

export interface Reply {
  status: number;
  type: string;
  body: string;
  json: () => any;
}

export function call(
  port: number,
  path: string,
  { method = "GET", host = `127.0.0.1:${port}`, token, body, contentType = "application/json" }: { method?: string; host?: string; token?: string; body?: unknown; contentType?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: host };
    if (token !== undefined) headers["X-Review-Token"] = token;
    if (body !== undefined) headers["Content-Type"] = contentType;
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), body: data, json: () => JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

export async function startServer(store: TableStore, token: string): Promise<{ server: Server; port: number }> {
  const server = reviewServer(store, token);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

// Every key in a JSON value, at any depth.
const keysOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];

let store: TableStore;
let server: Server;
let port: number;
const token = newToken();
beforeEach(async () => {
  store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-review-ui-")), "store.json"));
  await seed(store);
  ({ server, port } = await startServer(store, token));
});
afterEach(() => server.close());

describe("review page: access", () => {
  it("makes long random tokens", () => {
    assert.ok(token.length >= 32);
    assert.notEqual(newToken(), token);
  });

  it("refuses a wrong Host with 403", async () => {
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1"]) {
      assert.equal((await call(port, "/api/state", { host, token })).status, 403, host);
      assert.equal((await call(port, `/?token=${token}`, { host })).status, 403, host);
    }
    assert.equal((await call(port, "/api/state", { host: `localhost:${port}`, token })).status, 200);
  });

  it("refuses a missing or wrong token with 401", async () => {
    for (const path of ["/", "/api/state", "/api/summary?id=x", "/nope"]) {
      assert.equal((await call(port, path)).status, 401, path);
      assert.equal((await call(port, path, { token: `${token}x` })).status, 401, path);
      assert.equal((await call(port, `${path}${path.includes("?") ? "&" : "?"}token=wrong`)).status, 401, path);
    }
  });

  it("serves one self-contained page", async () => {
    const page = await call(port, `/?token=${token}`);
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /<script>/);
    assert.doesNotMatch(page.body, /\bsrc=|\bhref=|https?:\/\/|@import/);
    assert.equal((await call(port, "/nope", { token })).status, 404);
  });
});

describe("review page: state", () => {
  it("lists series, sessions, markers, voice notes, the review queue and open agenda", async () => {
    const res = await call(port, "/api/state", { token });
    assert.equal(res.status, 200);
    const state = res.json();
    assert.deepEqual(Object.keys(state).sort(), ["agenda", "markers", "review", "series", "sessions", "voiceNotes"]);
    assert.deepEqual(state.series.find((s: { id: string }) => s.id === "therapy"), {
      id: "therapy",
      name: "Weekly therapy",
      schedule: "Tue 17:00 to 18:00",
      spokenNames: ["therapy"],
    });
    assert.equal(state.series.find((s: { id: string }) => s.id === "acme-interview").schedule, "unscheduled");

    const coachingSessions = state.sessions.find((g: { seriesId: string }) => g.seriesId === "coaching").sessions;
    assert.deepEqual(coachingSessions, [
      {
        id: `coaching@${COACHING}`,
        when: "Thu, Oct 15, 4:02 PM",
        minutes: 53,
        parts: 1,
        beeIds: ["0111"],
        versions: 1,
        tag: { source: "schedule", confidence: "high", status: "auto", reason: "Thu 16:00 to 17:00 slot" },
      },
    ]);
    assert.deepEqual(state.markers.map((m: { kind: string; series: string; journal: string }) => [m.kind, m.series, m.journal]), [
      ["end", "none named", "2222"],
      ["start", "none named", "1111"],
    ]);
    assert.deepEqual(state.voiceNotes.map((n: { kind: string; status: string; journal: string }) => [n.kind, n.status, n.journal]), [
      ["note", "ignored", "3333"],
      ["start", "filed", "1111"],
    ]);
    assert.equal(state.review.line, "2 sessions to review.");
    assert.deepEqual(
      state.review.sessions.map((r: { id: string; guess: string; filed: boolean; beeId: string }) => [r.id, r.guess, r.filed, r.beeId]),
      [
        [`acme-interview@${ACME_GUESS}`, "Acme interview", false, "0444"],
        [`other@${OTHER}`, "Other", true, "0333"],
      ],
    );
    const agenda = Object.fromEntries(state.agenda.map((g: { seriesId: string; items: unknown[] }) => [g.seriesId, g.items]));
    assert.deepEqual(agenda.coaching, [{ text: "Synthetic: bring up the trip", source: "bee", added: "Wed, Oct 21, 8:00 AM" }]);
    assert.deepEqual(agenda.therapy, [{ text: "Synthetic: sleep", source: "you", added: "Wed, Oct 21, 9:00 AM" }]);
  });

  it("holds no summaries", async () => {
    const res = await call(port, "/api/state", { token });
    assert.ok(!keysOf(res.json()).some((k) => /summary/i.test(k)));
    assert.doesNotMatch(res.body, /Synthetic short|Synthetic long/);
  });

  it("gives one session's short summary on request", async () => {
    const res = await call(port, `/api/summary?id=${encodeURIComponent(`therapy@${THERAPY}`)}`, { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { id: `therapy@${THERAPY}`, shortSummary: "Synthetic short 900222" });
    assert.doesNotMatch(res.body, /900111|900333|long summary/);
    assert.equal((await call(port, "/api/summary?id=therapy@2026-01-01T00:00:00.000Z", { token })).status, 404);
    assert.equal((await call(port, "/api/summary?id=nonsense", { token })).status, 404);
  });
});

describe("yarn review-ui", () => {
  it("starts on 127.0.0.1 and prints the URL with its token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bs-review-ui-main-"));
    const fresh = fileStore(join(dir, "store.json"));
    await seed(fresh);
    const child = spawn(process.execPath, ["--import", "tsx", "src/local/review-ui.ts", "--store", "file"], {
      env: { ...process.env, REVIEW_PORT: "0", STORE_FILE: join(dir, "store.json") },
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      let out = "";
      const url = await new Promise<URL>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no URL printed: ${out}`)), 20_000);
        child.stdout.on("data", (chunk) => {
          out += chunk;
          const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]{32,}/.exec(out);
          if (m) {
            clearTimeout(timer);
            resolve(new URL(m[0]));
          }
        });
      });
      const p = Number(url.port);
      const t = url.searchParams.get("token")!;
      const res = await call(p, "/api/state", { token: t });
      assert.equal(res.status, 200);
      assert.equal(res.json().series.length, 4);
      assert.equal((await call(p, "/api/state", { token })).status, 401);
    } finally {
      child.kill();
    }
  });
});
