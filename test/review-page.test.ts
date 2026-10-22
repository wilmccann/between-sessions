// The review page's script, run against a small stand-in DOM and the real
// server (with the fake bee), so the tabs, search and "show" are exercised
// without a browser.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { newToken } from "../src/local/review-ui.js";
import { fileStore } from "../src/store/file-store.js";
import { writeBeeTabData } from "./fixtures/bee-tab.js";
import { fakeBee } from "./fixtures/index.js";
import { call, OTHER, seedBeeTab, startServer } from "./fixtures/review-seed.js";

process.env.BEE_BIN = fakeBee;

class FakeNode {
  parent: FakeElement | null = null;
  get textContent(): string {
    return "";
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}
class FakeText extends FakeNode {
  constructor(readonly data: string) {
    super();
  }
  override get textContent() {
    return this.data;
  }
}
class FakeElement extends FakeNode {
  children: FakeNode[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, ((e: unknown) => unknown)[]>();
  className = "";
  hidden = false;
  value = "";
  checked = false;
  style: Record<string, string> = {};
  constructor(readonly tagName: string) {
    super();
  }
  get id() {
    return this.attrs.get("id") ?? "";
  }
  setAttribute(k: string, v: unknown) {
    this.attrs.set(k, String(v));
    if (k === "value") this.value = String(v);
  }
  addEventListener(type: string, f: (e: unknown) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }
  // As the DOM does: anything that isn't a node becomes text, so a stray
  // array shows up as "[object Object]".
  append(...nodes: unknown[]) {
    for (const n of nodes) {
      const node = n instanceof FakeNode ? n : new FakeText(String(n));
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: unknown[]) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  override get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.replaceChildren(v);
  }
  fire(type: string, event: unknown = {}) {
    return Promise.all((this.listeners.get(type) ?? []).map((f) => f(event)));
  }
  all(pred: (e: FakeElement) => boolean): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [...(pred(c) ? [c] : []), ...c.all(pred)] : []));
  }
}

const STATIC_IDS = ["nav-schedule", "tabs", "marty-tab", "marty-search", "marty-searchinfo", "readback", "filters", "app", "bee-tab", "bee-search", "bee-searchinfo", "bee-filters", "bee-app"];

let server: Server;
let port: number;
let fixtureDir: string;
const token = newToken();
beforeEach(async () => {
  const store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-review-page-")), "store.json"));
  await seedBeeTab(store);
  ({ dir: fixtureDir } = await writeBeeTabData());
  process.env.FAKE_BEE_DIR = fixtureDir;
  delete process.env.FAKE_BEE_ARGV;
  delete process.env.FAKE_BEE_FAIL;
  ({ server, port } = await startServer(store, token));
});
afterEach(async () => {
  server.close();
  await rm(fixtureDir, { recursive: true, force: true });
});

const scriptOf = (page: string) => /<script>([\s\S]*)<\/script>/.exec(page)![1];

// Runs the page script; returns the stand-in document and the API paths it fetched.
async function openPage() {
  const page = (await call(port, `/?token=${token}`)).body;
  const root = new FakeElement("body");
  for (const id of STATIC_IDS) {
    const e = new FakeElement("div");
    e.setAttribute("id", id);
    root.append(e);
  }
  root.all((e) => e.id === "bee-tab")[0].hidden = true;
  const fetched: string[] = [];
  const document = {
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) => root.all((e) => e.id === id)[0] ?? null,
  };
  const fetchLocal = (path: string, init: RequestInit) => {
    fetched.push(path);
    return fetch(`http://127.0.0.1:${port}${path}`, init);
  };
  const run = new Function("document", "location", "fetch", "Node", "navigator", "window", "confirm", scriptOf(page));
  run(document, { search: `?token=${token}` }, fetchLocal, FakeNode, {}, {}, () => false);
  const byId = (id: string) => document.getElementById(id)!;
  return { root, byId, fetched };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const buttonIn = (e: FakeElement, label: string) => e.all((b) => b.tagName === "button" && b.textContent === label)[0];
// The table row holding this text.
const rowWith = (e: FakeElement, text: string) => e.all((r) => r.tagName === "tr" && r.textContent.includes(text))[0];
const bodyRows = (e: FakeElement) => e.all((r) => r.tagName === "tbody").flatMap((b) => b.children);

describe("review page: script", () => {
  it("serves HTML with no [object, and renders every section with [...].flat(2) minus nulls", async () => {
    const page = (await call(port, `/?token=${token}`)).body;
    assert.doesNotMatch(page, /\[object/);
    const script = scriptOf(page);
    const calls = script.match(/replaceChildren\(/g) ?? [];
    assert.ok(calls.length >= 9, String(calls.length));
    assert.equal((script.match(/replaceChildren\(\.\.\.\[/g) ?? []).length, calls.length);
    assert.equal((script.match(/\]\.flat\(2\)\.filter\(\(x\) => x != null\)\);/g) ?? []).length, calls.length);
    for (const id of ["tabs", "filters", "app", "bee-filters", "bee-app"]) {
      assert.ok(script.includes(`document.getElementById("${id}").replaceChildren(...[`), id);
    }
    assert.doesNotThrow(() => new Function(script));
  });

  it("shows the Marty tab, with voice-note text only after show", async () => {
    const { root, byId, fetched } = await openPage();
    await until(() => byId("app").textContent.includes("Voice notes"), "the Marty tab");
    assert.equal(byId("marty-tab").hidden, false);
    assert.equal(byId("bee-tab").hidden, true);
    // Agenda items are your own words and show; Bee's text doesn't.
    assert.doesNotMatch(root.textContent, /\[object|undefined|\bnull\b|Synthetic: (a plain|Marty|short|long)/);
    const note = rowWith(byId("app"), "jrnl-synthetic-3333");
    assert.ok(note.textContent.includes("note"));
    await buttonIn(note, "show").fire("click");
    await until(() => byId("app").textContent.includes("Synthetic: a plain thought about the garden."), "the note text");
    assert.ok(fetched.includes("/api/bee/text?type=journal&id=jrnl-synthetic-3333"));
    assert.doesNotMatch(root.textContent, /\[object/);
  });

  it("opens the Bee data tab, filters it, and shows text for the visible rows only", async () => {
    const { root, byId, fetched } = await openPage();
    await until(() => byId("app").textContent.includes("Voice notes"), "the Marty tab");
    assert.ok(!fetched.some((p) => p.startsWith("/api/bee")), "Bee is read only when the tab opens");
    await buttonIn(byId("tabs"), "Bee data").fire("click");
    assert.equal(byId("bee-tab").hidden, false);
    assert.equal(byId("marty-tab").hidden, true);
    assert.match(byId("bee-app").textContent, /Loading Bee data \(the first call can take about 20 s\)\.\.\./);
    await until(() => byId("bee-app").textContent.includes("Bee data, last 14 days"), "the Bee data");
    const app = byId("bee-app");
    for (const h of ["Type", "Id", "Created", "Updated", "Start and end", "State", "Marty", "Text", "Look up"]) assert.ok(app.all((e) => e.tagName === "th" && e.textContent === h).length, h);
    assert.equal(bodyRows(app).length, 13);
    assert.doesNotMatch(app.textContent, /Synthetic:|\[object|undefined|\bnull\b/);
    assert.ok(rowWith(app, "900111").textContent.includes("session: Coaching"));
    assert.ok(rowWith(app, "900666").textContent.includes("not captured"));
    assert.ok(rowWith(app, "900666").textContent.includes("(in progress)"));

    const filters = byId("bee-filters");
    const box = filters.all((e) => e.attrs.get("type") === "checkbox")[0];
    box.checked = true;
    await box.fire("change");
    assert.equal(bodyRows(app).length, 4); // journal 7777, conversation 900666, insights 2101 and 2102
    box.checked = false;
    await box.fire("change");
    const type = filters.all((e) => e.tagName === "select")[0];
    type.value = "insight";
    await type.fire("change");
    assert.equal(bodyRows(app).length, 2);
    type.value = "";
    await type.fire("change");

    // The last six hours, to the minute.
    const local = (ms: number) => {
      const d = new Date(ms);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const from = filters.all((e) => e.attrs.get("type") === "datetime-local")[0];
    from.value = local(Date.now() - 6 * 3_600_000);
    await from.fire("change");
    assert.equal(bodyRows(app).length, 4); // journals 6666 and 5555, conversation 900666, insight 2101

    const before = fetched.filter((p) => p.startsWith("/api/bee/text")).length;
    await buttonIn(filters, "Show all text").fire("click");
    await until(() => app.textContent.includes("Synthetic: insight title 2101"), "all text");
    assert.equal(fetched.filter((p) => p.startsWith("/api/bee/text")).length - before, 4);
    assert.ok(app.textContent.includes("Synthetic: Marty, start coaching session."));
    assert.ok(app.textContent.includes("Synthetic: short 900666"));
    assert.ok(!root.textContent.includes("Synthetic: short 900111"));
    assert.doesNotMatch(root.textContent, /\[object|undefined|\bnull\b/);
  });

  it("searches each tab on its own: Marty exact words; Bee data exact, keyword and semantic", async () => {
    const { root, byId, fetched } = await openPage();
    await until(() => byId("app").textContent.includes("Voice notes"), "the Marty tab");
    // The Marty tab has one mode and no mode select.
    assert.equal(byId("marty-mode"), null);
    assert.ok(byId("bee-mode"));

    // Before Bee is read, the Marty search doesn't read it (no Keychain prompt).
    byId("marty-q").value = "garden";
    await buttonIn(byId("marty-search"), "Search").fire("click");
    await until(() => byId("marty-searchinfo").textContent.includes("matching rows"), "the Marty search");
    assert.match(byId("marty-searchinfo").textContent, /Exact words "garden": 0 matching rows\. Note text wasn't searched: open the Bee data tab once to read it\.$/);
    assert.ok(!fetched.some((p) => p.startsWith("/api/bee")), "the Marty search reads no Bee data");

    // Bee data tab: one read, then an exact search on that tab only.
    await buttonIn(byId("tabs"), "Bee data").fire("click");
    await until(() => byId("bee-app").textContent.includes("Bee data, last 14 days"), "the Bee data");
    assert.equal(bodyRows(byId("bee-app")).length, 13);
    byId("bee-q").value = "garden";
    byId("bee-mode").value = "exact";
    await buttonIn(byId("bee-search"), "Search").fire("click");
    await until(() => byId("bee-searchinfo").textContent.includes("matching rows"), "the Bee exact search");
    assert.match(byId("bee-searchinfo").textContent, /Exact words "garden": 1 matching rows\.$/);
    assert.equal(bodyRows(byId("bee-app")).length, 1);
    assert.ok(byId("bee-app").textContent.includes("matched: note text"));

    // Now Bee's text is loaded, the Marty search finds the note; the Bee tab's search doesn't touch it.
    await buttonIn(byId("tabs"), "Marty").fire("click");
    await buttonIn(byId("marty-search"), "Search").fire("click");
    await until(() => byId("marty-searchinfo").textContent.includes("1 matching rows"), "the Marty search again");
    assert.match(byId("marty-searchinfo").textContent, /Exact words "garden": 1 matching rows\.$/);
    assert.ok(rowWith(byId("app"), "jrnl-synthetic-3333").textContent.includes("matched: note text"));
    assert.equal(rowWith(byId("app"), "jrnl-synthetic-1111"), undefined);
    assert.ok(fetched.filter((p) => p.startsWith("/api/search")).every((p) => /scope=(marty|bee)/.test(p)));

    // Semantic search lists ranked results on the Bee data tab, without Created or Updated.
    await buttonIn(byId("tabs"), "Bee data").fire("click");
    byId("bee-q").value = "when did I feel stretched?";
    byId("bee-mode").value = "neural";
    await byId("bee-q").fire("keydown", { key: "Enter" });
    await until(() => byId("bee-searchinfo").textContent.includes("Bee semantic search"), "the semantic search");
    assert.match(byId("bee-searchinfo").textContent, /^Bee semantic search "when did I feel stretched\?": 2 results\.$/);
    const app = byId("bee-app");
    assert.ok(app.textContent.includes('Bee semantic search results for "when did I feel stretched?"'));
    assert.deepEqual(app.all((e) => e.tagName === "th").map((e) => e.textContent), ["Match", "Type", "Id", "Start and end", "State", "Marty", "Text", "Look up"]);
    const rows = bodyRows(app);
    assert.equal(rows.length, 2);
    assert.ok(rows[0].textContent.startsWith("#1conversation900333"));
    assert.ok(rows[0].textContent.includes("waiting for review: filed under Other"));
    assert.ok(rows[1].textContent.includes("not captured"));
    assert.doesNotMatch(app.textContent, /Synthetic:/);
    await buttonIn(rows[0] as FakeElement, "show").fire("click");
    await until(() => app.textContent.includes("Synthetic: neural detailed 900333"), "the hit's text");

    // No effect on the Marty tab: its own search still holds, nothing highlighted.
    await buttonIn(byId("tabs"), "Marty").fire("click");
    assert.match(byId("marty-searchinfo").textContent, /Exact words "garden": 1 matching rows/);
    assert.ok(!byId("app").textContent.includes("Bee semantic"));
    await buttonIn(byId("marty-search"), "Clear").fire("click");
    assert.equal(byId("marty-searchinfo").textContent, "");
    assert.ok(rowWith(byId("app"), "jrnl-synthetic-1111"));

    // Clearing the Bee search goes back to the same read: no new Bee read.
    const reads = fetched.filter((p) => p.startsWith("/api/bee?") || p === "/api/bee").length;
    await buttonIn(byId("tabs"), "Bee data").fire("click");
    await buttonIn(byId("bee-search"), "Clear").fire("click");
    assert.equal(byId("bee-searchinfo").textContent, "");
    assert.equal(bodyRows(byId("bee-app")).length, 13);
    assert.equal(fetched.filter((p) => p.startsWith("/api/bee?") || p === "/api/bee").length, reads);
    assert.doesNotMatch(root.textContent, /\[object|undefined|\bnull\b/);
  });

  it("reports a refused search", async () => {
    const { byId } = await openPage();
    await until(() => byId("app").textContent.includes("Voice notes"), "the Marty tab");
    await buttonIn(byId("tabs"), "Bee data").fire("click");
    byId("bee-q").value = "-nope";
    byId("bee-mode").value = "keyword";
    await buttonIn(byId("bee-search"), "Search").fire("click");
    await until(() => byId("bee-searchinfo").textContent.includes("can't start with -"), "the error");
  });
});
