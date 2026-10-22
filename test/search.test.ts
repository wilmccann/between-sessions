import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { newToken } from "../src/local/review-ui.js";
import { matchDocs, normalize, parseQuery } from "../src/local/search.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import { writeBeeTabData } from "./fixtures/bee-tab.js";
import { fakeBee } from "./fixtures/index.js";
import { ACME_GUESS, argvLines, call, COACHING, OTHER, seedBeeTab, startServer, THERAPY } from "./fixtures/review-seed.js";

process.env.BEE_BIN = fakeBee;

describe("search: terms", () => {
  it("normalizes case, punctuation and whitespace", () => {
    assert.equal(normalize("  Marty,   START\tcoaching!  "), "marty start coaching");
    assert.equal(normalize("don't"), "dont");
    assert.equal(normalize("jrnl-synthetic-1111"), "jrnlsynthetic1111");
  });

  it("splits terms on whitespace; a leading - excludes", () => {
    assert.deepEqual(parseQuery("Mart  -Cat - x!"), { include: ["mart", "x"], exclude: ["cat"] });
    assert.deepEqual(parseQuery("   "), { include: [], exclude: [] });
  });

  it("matches partial words in any field, and names where", () => {
    const docs = [
      { key: "a", fields: [{ label: "note text", value: "Marty, start." }, { label: "id", value: "a-1" }] },
      { key: "b", fields: [{ label: "summary", value: "Martin came by" }, { label: "reason", value: "Thu slot" }] },
      { key: "c", fields: [{ label: "note text", value: "Smarty the cat" }] },
      { key: "d", fields: [{ label: "note text", value: "Nothing here" }, { label: "reason", value: null }] },
    ];
    assert.deepEqual(matchDocs(docs, "mart"), [
      { key: "a", matchedIn: ["note text"] },
      { key: "b", matchedIn: ["summary"] },
      { key: "c", matchedIn: ["note text"] },
    ]);
    assert.deepEqual(matchDocs(docs, "MART -cat"), [
      { key: "a", matchedIn: ["note text"] },
      { key: "b", matchedIn: ["summary"] },
    ]);
    assert.deepEqual(matchDocs(docs, "mart thu"), [{ key: "b", matchedIn: ["summary", "reason"] }]);
    assert.deepEqual(matchDocs(docs, "a1"), [{ key: "a", matchedIn: ["id"] }]);
    assert.deepEqual(matchDocs(docs, "-mart"), [{ key: "d", matchedIn: [] }]);
    assert.deepEqual(matchDocs(docs, " "), []);
  });
});

let store: TableStore;
let server: Server;
let port: number;
let argvFile: string;
let fixtureDir: string;
const token = newToken();

beforeEach(async () => {
  store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-search-")), "store.json"));
  await seedBeeTab(store);
  ({ dir: fixtureDir, argvFile } = await writeBeeTabData());
  process.env.FAKE_BEE_DIR = fixtureDir;
  process.env.FAKE_BEE_ARGV = argvFile;
  delete process.env.FAKE_BEE_FAIL;
  ({ server, port } = await startServer(store, token));
});
afterEach(async () => {
  server.close();
  await rm(fixtureDir, { recursive: true, force: true });
});

const search = async (params: Record<string, string>) => call(port, `/api/search?${new URLSearchParams(params)}`, { token });
const exact = async (q: string, scope: "marty" | "bee") => {
  const res = await search({ q, mode: "exact", scope });
  assert.equal(res.status, 200, res.body);
  assert.doesNotMatch(res.body, /Synthetic|Fake Street|synthetic\.example/);
  return Object.fromEntries((res.json().matches as { key: string; matchedIn: string[] }[]).map((m) => [m.key, m.matchedIn]));
};

describe("search: exact words", () => {
  it("searches one tab's rows by their hidden text, without sending it", async () => {
    // The Marty tab never starts a Bee read: before one, no note text.
    const before = await search({ q: "garden", mode: "exact", scope: "marty" });
    assert.deepEqual(before.json().matches, []);
    assert.equal(before.json().beeText, false);
    assert.deepEqual(await argvLines(argvFile), []);

    const mart = await exact("mart", "bee");
    for (const id of ["6666", "5555", "1111", "7777"]) assert.deepEqual(mart[`journal:jrnl-synthetic-${id}`], ["note text"], id);
    assert.ok(Object.keys(mart).every((k) => /^(journal|conversation|insight):/.test(k)), "Bee data rows only");
    const noCat = await exact("mart -cat", "bee");
    assert.equal(noCat["journal:jrnl-synthetic-7777"], undefined);
    assert.deepEqual(noCat["journal:jrnl-synthetic-6666"], ["note text"]);
    assert.deepEqual(Object.keys(await exact("GARDEN.", "bee")), ["journal:jrnl-synthetic-3333"]);

    // Once Bee has been read, the Marty tab searches note text too, from the same read.
    const reads = (await argvLines(argvFile)).length;
    const martyMart = await exact("mart", "marty");
    assert.deepEqual(martyMart["note:jrnl-synthetic-1111"], ["note text"]);
    assert.deepEqual(martyMart["marker:jrnl-synthetic-1111"], ["note text"]);
    assert.equal(martyMart["note:jrnl-synthetic-3333"], undefined);
    assert.ok(Object.keys(martyMart).every((k) => !/^(journal|conversation|insight):/.test(k)), "Marty rows only");
    assert.deepEqual(Object.keys(await exact("GARDEN.", "marty")), ["note:jrnl-synthetic-3333"]);
    assert.equal((await argvLines(argvFile)).length, reads);
  });

  it("searches sessions by stored short summaries and their Bee conversations", async () => {
    // Stored ("Synthetic short") and Bee's ("Synthetic: short").
    assert.deepEqual(Object.keys(await exact("synthetic short 900111", "bee")), ["conversation:900111"]);
    const short = await exact("synthetic short 900111", "marty");
    assert.deepEqual(Object.keys(short), [`session:coaching@${COACHING}`]);
    assert.deepEqual(short[`session:coaching@${COACHING}`], ["id", "short summary", "summary"]);
    // The long summary comes from Bee only.
    const long = await exact("long summary 900222", "marty");
    assert.deepEqual(Object.keys(long), [`session:therapy@${THERAPY}`]);
    assert.ok(long[`session:therapy@${THERAPY}`].includes("summary"));
    const title = await exact("title 2101", "bee");
    assert.deepEqual(Object.keys(title), ["insight:2101"]);
    assert.ok(title["insight:2101"].includes("insight title"));
    assert.ok((await exact("description 2102", "bee"))["insight:2102"].includes("insight description"));
  });

  it("searches visible fields: reason, series, status, kind, Marty", async () => {
    const acme = await exact("keyword acme", "marty");
    assert.deepEqual(Object.keys(acme), [`review:acme-interview@${ACME_GUESS}`]);
    assert.deepEqual(acme[`review:acme-interview@${ACME_GUESS}`], ["id", "series", "reason"]);
    assert.deepEqual((await exact("dont know", "bee"))["journal:jrnl-synthetic-5555"], ["Marty"]);
    assert.ok((await exact("pending", "marty"))[`session:other@${OTHER}`].includes("status"));
    assert.ok((await exact("not a session", "bee"))["conversation:900555"].includes("Marty"));
    assert.ok((await exact("start", "marty"))["marker:jrnl-synthetic-1111"].includes("kind"));
    assert.deepEqual((await exact("weekly", "marty"))["series:therapy"], ["series"]);
    assert.ok((await exact("ignored", "marty"))["note:jrnl-synthetic-3333"].includes("status"));
  });

  it("reports a Bee failure on the Bee data tab; the Marty tab doesn't call Bee", async () => {
    process.env.FAKE_BEE_FAIL = "5";
    const marty = await search({ q: "acme", mode: "exact", scope: "marty" });
    assert.equal(marty.status, 200);
    assert.equal(marty.json().beeError, undefined);
    assert.ok(marty.json().matches.some((m: { key: string }) => m.key === `review:acme-interview@${ACME_GUESS}`));
    const bee = await search({ q: "acme", mode: "exact", scope: "bee" });
    assert.equal(bee.status, 200);
    assert.equal(bee.json().beeError, "Bee CLI failed (exit 5)");
    assert.deepEqual(bee.json().matches, []);
  });

  it("refuses an unknown scope", async () => {
    assert.equal((await search({ q: "acme", mode: "exact", scope: "both" })).status, 400);
  });
});

describe("search: Bee keyword and semantic", () => {
  it("runs bee search in keyword mode with the exact arguments", async () => {
    const from = "2026-10-08T00:00:00.000Z";
    const to = "2026-10-22T13:00:00.000Z";
    const res = await search({ q: "offsite budget", mode: "keyword", from, to });
    assert.equal(res.status, 200, res.body);
    assert.deepEqual((await argvLines(argvFile)).at(-1), [
      "search",
      "--query",
      "offsite budget",
      "--filter",
      "all",
      "--scope",
      "all",
      "--since",
      String(Date.parse(from)),
      "--until",
      String(Date.parse(to)),
      "--limit",
      "50",
      "--json",
    ]);
    const body = res.json();
    assert.equal(body.mode, "keyword");
    assert.equal(body.cutShort, false);
    assert.deepEqual(
      body.rows.map((r: { type: string; id: string; score: number; marty: string | null; matchedIn: string[] }) => [r.type, r.id, r.score, r.marty, r.matchedIn]),
      [
        ["fact", "3002", 9, null, ["Bee keyword search"]],
        ["conversation", "900111", 7.5, "session: Coaching, Thu, Oct 15, 4:02 PM", ["Bee keyword search"]],
        ["daily", "3001", 3.25, null, ["Bee keyword search"]],
      ],
    );
    assert.doesNotMatch(res.body, /Synthetic|snippet|summary/);
    // Each hit's text, one at a time.
    const text = await call(port, "/api/bee/text?type=conversation&id=900111&source=keyword", { token });
    assert.deepEqual(text.json().parts, [
      { label: "title snippet", text: "Synthetic: keyword title 900111" },
      { label: "snippet", text: "Synthetic: keyword snippet 900111" },
      { label: "summary", text: "Synthetic: keyword summary 900111" },
    ]);
    assert.deepEqual((await call(port, "/api/bee/text?type=fact&id=3002&source=keyword", { token })).json().parts, [{ label: "snippet", text: "Synthetic: fact snippet" }]);
    assert.equal((await call(port, "/api/bee/text?type=conversation&id=900111&source=neural", { token })).status, 404);
  });

  it("runs bee search --neural with the exact arguments, ranked, without links or locations", async () => {
    const before = Date.now();
    const res = await search({ q: "when did I feel stretched?", mode: "neural" });
    assert.equal(res.status, 200, res.body);
    const argv = (await argvLines(argvFile)).at(-1)!;
    assert.deepEqual(argv.slice(0, 5), ["search", "--query", "when did I feel stretched?", "--neural", "--since"]);
    assert.deepEqual([argv[6], argv[8], argv.length], ["--until", "--json", 9]);
    // From and to default to the last 14 days.
    const [since, until] = [Number(argv[5]), Number(argv[7])];
    assert.equal(until - since, 14 * 24 * 3_600_000);
    assert.ok(until >= before && until <= Date.now());

    const body = res.json();
    assert.deepEqual(
      body.rows.map((r: { type: string; id: string; rank: number; marty: string | null; end: string | null; matchedIn: string[] }) => [
        r.type,
        r.id,
        r.rank,
        r.marty,
        r.end === null,
        r.matchedIn,
      ]),
      [
        ["conversation", "900333", 1, "waiting for review: filed under Other", false, ["Bee semantic search"]],
        ["conversation", "900666", 2, null, true, ["Bee semantic search"]],
      ],
    );
    assert.doesNotMatch(res.body, /Synthetic|Fake Street|synthetic\.example|link|location/i);
    const text = await call(port, "/api/bee/text?type=conversation&id=900333&source=neural", { token });
    assert.deepEqual(text.json().parts, [
      { label: "short summary", text: "Synthetic: neural short 900333" },
      { label: "summary", text: "Synthetic: neural detailed 900333" },
    ]);
    assert.doesNotMatch(text.body, /Fake Street|synthetic\.example|link|location/i);
  });

  it("passes a query with shell characters as one argument", async () => {
    const q = "x; rm -rf / $(id) `id` | cat 'a' \"b\"";
    for (const mode of ["keyword", "neural"]) {
      assert.equal((await search({ q, mode })).status, 200, mode);
      const argv = (await argvLines(argvFile)).at(-1)!;
      assert.equal(argv[1], "--query");
      assert.equal(argv[2], q);
    }
  });

  it("caps the query at 200 characters and refuses a leading -", async () => {
    assert.equal((await search({ q: "a".repeat(200), mode: "keyword" })).status, 200);
    const calls = (await argvLines(argvFile)).length;
    for (const mode of ["exact", "keyword", "neural"]) {
      const res = await search({ q: "a".repeat(201), mode });
      assert.equal(res.status, 400, mode);
      assert.match(res.json().error, /200 characters/);
    }
    assert.equal((await search({ q: "--help", mode: "keyword" })).status, 400);
    assert.equal((await search({ q: "-x", mode: "neural" })).status, 400);
    assert.equal((await argvLines(argvFile)).length, calls);
  });

  it("rejects bad requests", async () => {
    assert.equal((await search({ q: "", mode: "exact" })).status, 400);
    assert.equal((await search({ q: "x", mode: "fuzzy" })).status, 400);
    assert.equal((await search({ q: "x", mode: "keyword", from: "yesterday" })).status, 400);
    assert.equal((await search({ q: "x", mode: "keyword", from: "2026-10-22T00:00:00Z", to: "2026-10-21T00:00:00Z" })).status, 400);
  });

  it("reports a failed Bee search by exit code only", async () => {
    process.env.FAKE_BEE_FAIL = "4";
    const res = await search({ q: "x", mode: "neural" });
    assert.equal(res.status, 502);
    assert.deepEqual(res.json(), { error: "Bee CLI failed (exit 4)" });
  });

  it("needs the token and the right host", async () => {
    const path = "/api/search?q=x&mode=keyword";
    assert.equal((await call(port, path)).status, 401);
    assert.equal((await call(port, path, { token: "wrong" })).status, 401);
    assert.equal((await call(port, path, { token, host: "evil.example" })).status, 403);
    assert.deepEqual(await argvLines(argvFile), []);
  });
});
