import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { newToken, reviewServer, shellQuote } from "../src/local/review-ui.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import type { SessionTag } from "../src/store/types.js";
import { coaching, other, therapy } from "./fixtures/meeting-types.js";
import { ACME_GUESS, call, COACHING, OTHER, seed, startServer, THERAPY } from "./fixtures/review-seed.js";

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
        at: COACHING,
        when: "Thu, Oct 15, 4:02 PM",
        minutes: 53,
        parts: 1,
        beeIds: ["900111"],
        versions: 1,
        tag: { source: "schedule", confidence: "high", status: "auto", reason: "Thu 16:00 to 17:00 slot" },
        // The file store has no table, so no db lookup.
        lookups: [{ label: "bee 900111", command: "bee conversations get '900111' --json" }],
      },
    ]);
    assert.deepEqual(state.markers.map((m: { kind: string; series: string; journalId: string }) => [m.kind, m.series, m.journalId]), [
      ["end", "none named", "jrnl-synthetic-2222"],
      ["start", "none named", "jrnl-synthetic-1111"],
    ]);
    assert.equal(state.markers[1].at, OTHER);
    assert.deepEqual(state.markers[1].lookups, [{ label: "bee", command: "bee journals get 'jrnl-synthetic-1111' --json" }]);
    assert.deepEqual(state.voiceNotes.map((n: { kind: string; status: string; journalId: string }) => [n.kind, n.status, n.journalId]), [
      ["note", "ignored", "jrnl-synthetic-3333"],
      ["start", "filed", "jrnl-synthetic-1111"],
    ]);
    assert.equal(state.review.line, "2 sessions to review.");
    assert.deepEqual(
      state.review.sessions.map((r: { id: string; seriesId: string; at: string; guess: string; filed: boolean; beeIds: string[] }) => [
        r.id,
        r.seriesId,
        r.at,
        r.guess,
        r.filed,
        r.beeIds,
      ]),
      [
        [`acme-interview@${ACME_GUESS}`, "acme-interview", ACME_GUESS, "Acme interview", false, ["900444"]],
        [`other@${OTHER}`, "other", OTHER, "Other", true, ["900333"]],
      ],
    );
    const agenda = Object.fromEntries(state.agenda.map((g: { seriesId: string; items: unknown[] }) => [g.seriesId, g.items]));
    assert.deepEqual(agenda.coaching, [
      {
        text: "Synthetic: bring up the trip",
        source: "bee",
        at: "2026-10-21T12:00:00.000Z",
        added: "Wed, Oct 21, 8:00 AM",
        journalId: "jrnl-synthetic-4444",
        lookups: [{ label: "bee", command: "bee journals get 'jrnl-synthetic-4444' --json" }],
      },
    ]);
    assert.deepEqual(agenda.therapy, [
      { text: "Synthetic: sleep", source: "you", at: "2026-10-21T13:00:00.000Z", added: "Wed, Oct 21, 9:00 AM", journalId: null, lookups: [] },
    ]);
  });

  it("gives DynamoDB lookups for each row when it knows the table", async () => {
    const withTable = reviewServer(store, token, { table: "synthetic-table" });
    await new Promise<void>((r) => withTable.listen(0, "127.0.0.1", r));
    try {
      const state = (await call((withTable.address() as AddressInfo).port, "/api/state", { token })).json();
      const db = (lookups: { label: string; command: string }[]) => lookups.find((l) => l.label === "db")!.command;
      // The key JSON inside the single quotes, as DynamoDB gets it.
      const json = (command: string) => JSON.parse(/'(\{.*\})'/.exec(command)![1]);
      const session = state.sessions.find((g: { seriesId: string }) => g.seriesId === "coaching").sessions[0];
      assert.match(db(session.lookups), /^aws dynamodb query --table-name 'synthetic-table' --key-condition-expression 'PK = :pk AND begins_with\(SK, :sk\)' /);
      assert.deepEqual(json(db(session.lookups)), { ":pk": { S: "SERIES#coaching" }, ":sk": { S: `SESSION#${COACHING}#V#` } });
      assert.match(db(state.markers[1].lookups), /^aws dynamodb get-item --table-name 'synthetic-table' --key '/);
      assert.deepEqual(json(db(state.markers[1].lookups)), { PK: { S: "MARKERS" }, SK: { S: `M#${OTHER}#jrnl-synthetic-1111` } });
      assert.deepEqual(json(db(state.voiceNotes[1].lookups)), { PK: { S: "JOURNALS" }, SK: { S: `J#${OTHER}#jrnl-synthetic-1111` } });
      assert.deepEqual(json(db(state.review.sessions[0].lookups)), { PK: { S: "REVIEW" }, SK: { S: `R#${ACME_GUESS}#acme-interview` } });
      const agenda = state.agenda.find((g: { seriesId: string }) => g.seriesId === "therapy").items[0];
      assert.equal(json(db(agenda.lookups)).PK.S, "SERIES#therapy");
      assert.match(json(db(agenda.lookups)).SK.S, /^AGENDA#2026-10-21T13:00:00\.000Z#/);
      // Each key is the stored item's key.
      const items = await store.listAgenda(therapy.id);
      assert.equal(json(db(agenda.lookups)).SK.S, `AGENDA#${items[0].createdAt}#${items[0].id}`);
    } finally {
      withTable.close();
    }
  });

  it("quotes lookup arguments for the shell", () => {
    assert.equal(shellQuote("plain-123"), "'plain-123'");
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
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

describe("review page: edits", () => {
  const post = (path: string, body: unknown, opts: { contentType?: string; token?: string } = {}) =>
    call(port, path, { method: "POST", token: opts.token ?? token, body, contentType: opts.contentType });
  const state = async () => (await call(port, "/api/state", { token })).json();
  const sessionsOf = (s: { sessions: { seriesId: string; sessions: { id: string }[] }[] }, id: string) =>
    s.sessions.find((g) => g.seriesId === id)!.sessions;

  it("retag moves a session and its takeaway to another series", async () => {
    const res = await post("/api/retag", { id: `other@${OTHER}`, series: "coaching" });
    assert.equal(res.status, 200);
    assert.match(res.json().readback, /^Moved the Wed, Oct 21, 2:00 PM session from Other to Coaching\./);
    const s = await state();
    assert.deepEqual(sessionsOf(s, "other"), []);
    assert.equal(sessionsOf(s, "coaching")[0].id, `coaching@${OTHER}`);
    assert.deepEqual((await store.listTakeaways(coaching.id, OTHER)).map((t) => t.text), ["Synthetic takeaway"]);
    assert.deepEqual(await store.listTakeaways(other.id), []);
    assert.equal(s.review.line, "1 session to review.");
  });

  it("not a session keeps your notes under Other", async () => {
    await store.saveTakeaway(therapy.id, THERAPY, "Synthetic therapy takeaway", { createdAt: "2026-10-20T22:10:00.000Z" });
    const res = await post("/api/retag", { id: `therapy@${THERAPY}`, notASession: true });
    assert.equal(res.status, 200);
    assert.match(res.json().readback, /^Marked the Weekly therapy session on .* as not a session\..* Your 1 note from it was kept under Other\.$/);
    assert.deepEqual(sessionsOf(await state(), "therapy"), []);
    assert.deepEqual((await store.listTakeaways(other.id, THERAPY)).map((t) => t.text), ["Synthetic therapy takeaway"]);
  });

  it("confirm changes the tag's status, and files a waiting guess", async () => {
    const res = await post("/api/confirm", { id: `coaching@${COACHING}` });
    assert.equal(res.status, 200);
    assert.equal(res.json().readback, "Confirmed: the Thu, Oct 15, 4:02 PM session is Coaching.");
    const tag = sessionsOf(await state(), "coaching").find((x) => x.id === `coaching@${COACHING}`) as unknown as { tag: SessionTag };
    assert.deepEqual(tag.tag, { source: "you", confidence: "certain", status: "confirmed", reason: "You confirmed it" });

    const guess = await post("/api/confirm", { id: `acme-interview@${ACME_GUESS}` });
    assert.match(guess.json().readback, /^Filed the Mon, Oct 19, 11:00 AM conversation under Acme interview\./);
    assert.equal((await state()).review.line, "1 session to review.");
  });

  it("remove closes an agenda item", async () => {
    const res = await post("/api/agenda/remove", { series: "coaching", text: "Synthetic: bring up the trip" });
    assert.equal(res.status, 200);
    assert.equal(res.json().readback, "Removed: Synthetic: bring up the trip. You have 0 open items.");
    const agenda = (await state()).agenda.find((g: { seriesId: string }) => g.seriesId === "coaching");
    assert.deepEqual(agenda.items, []);
    const again = await post("/api/agenda/remove", { series: "coaching", text: "Synthetic: bring up the trip" });
    assert.equal(again.status, 400);
    assert.match(again.json().error, /Nothing on your Coaching agenda matches/);
  });

  it("needs JSON, the token and the right host, and reports bad requests", async () => {
    const body = { id: `coaching@${COACHING}` };
    assert.equal((await post("/api/confirm", body, { contentType: "text/plain" })).status, 415);
    assert.equal((await post("/api/confirm", "id=x", { contentType: "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await post("/api/confirm", body, { token: "wrong" })).status, 401);
    assert.equal((await call(port, "/api/confirm", { method: "POST", host: "evil.example", token, body })).status, 403);
    assert.equal((await post("/api/confirm", "not json")).status, 400);
    assert.equal((await post("/api/confirm", { id: "nonsense" })).status, 400);
    assert.equal((await post("/api/retag", { id: `coaching@${COACHING}` })).status, 400);
    assert.equal((await post("/api/retag", { id: 42, series: "coaching" })).status, 400);
    assert.match((await post("/api/retag", { id: "therapy@2026-01-01T00:00:00.000Z", series: "coaching" })).json().error, /can't find/);
    assert.equal((await call(port, "/api/retag", { token })).status, 404);
    // Nothing changed.
    assert.equal(sessionsOf(await state(), "coaching").length, 1);
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

