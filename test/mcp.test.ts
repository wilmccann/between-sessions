import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BOUNDARY, CAPABILITIES, menu } from "../src/mcp/capabilities.js";
import { createMcpServer, type PrepBriefView, type SessionView } from "../src/mcp/server.js";
import { fileStore } from "../src/store/file-store.js";
import type { TableStore } from "../src/store/table-store.js";
import type { SessionInput } from "../src/store/types.js";
import { series } from "./fixtures/index.js";

// Sessions far in the past or future, so agenda items added "now" fall on a
// known side of them.
const session = (start: string, end: string): SessionInput => ({
  start,
  end,
  parts: [{ id: 1, start, end, shortSummary: "Synthetic check-in", summary: "Synthetic summary." }],
  insights: [{ id: 7, title: "Synthetic insight", description: "Made up.", generatedAt: end }],
});
const PAST = session("2020-01-07T01:00:00.000Z", "2020-01-07T02:00:00.000Z");
const FUTURE = session("2099-01-06T01:00:00.000Z", "2099-01-06T02:00:00.000Z");

let store: TableStore;
let client: Client;

beforeEach(async () => {
  store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-mcp-")), "store.json"));
  await store.putSeries(series);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store).connect(a);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(b);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const [first] = res.content as { type: string; text: string }[];
  return { isError: Boolean(res.isError), text: first.text };
}
const callJson = async <T>(name: string, args: Record<string, unknown> = {}) =>
  JSON.parse((await call(name, args)).text) as T;

describe("MCP tools", () => {
  it("lists every tool with a description", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "add_agenda_item",
      "get_last_session",
      "get_prep_brief",
      "get_since_last_session",
      "help",
      "list_agenda",
      "list_sessions",
      "remove_agenda_item",
      "save_takeaway",
    ]);
    for (const t of tools) assert.ok((t.description ?? "").length > 40, t.name);
  });

  it("registers exactly the tools in the capability list", async () => {
    const { tools } = await client.listTools();
    const listed = CAPABILITIES.flatMap((c) => c.tools.map((t) => t.name));
    assert.equal(new Set(listed).size, listed.length);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...listed].sort());
  });

  it("sends instructions with the menu, the boundary and no tool names", async () => {
    const said = client.getInstructions() ?? "";
    assert.ok(said.includes(menu()));
    assert.ok(said.includes(BOUNDARY));
    const { tools } = await client.listTools();
    for (const t of tools) assert.ok(!menu().includes(t.name), t.name);
  });

  it("answers help with a short menu and the boundary sentence", async () => {
    const res = await call("help");
    assert.ok(res.text.includes(BOUNDARY));
    const lines = res.text.split("\n").filter((l) => l.startsWith("- "));
    assert.ok(lines.length >= 3 && lines.length <= 4, String(lines.length));
    assert.match(res.text, /"Give me my prep brief"/);
  });

  it("lists the prompts for / and fills them in", async () => {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["agenda", "help", "prep", "since", "takeaway"]);
    const agenda = await client.getPrompt({ name: "agenda", arguments: { item: "the work trip" } });
    assert.match((agenda.messages[0].content as { text: string }).text, /Add "the work trip" to my agenda/);
    const prep = await client.getPrompt({ name: "prep", arguments: {} });
    assert.match((prep.messages[0].content as { text: string }).text, /prep brief/);
  });

  it("ends every answer with one next step", async () => {
    await store.putSessionVersion(series.id, PAST);
    assert.match((await call("add_agenda_item", { text: "Ask about the offsite" })).text, /\nNext: .+\?$/);
    const brief = await callJson<{ next: string }>("get_prep_brief");
    assert.match(brief.next, /agenda/);
    assert.ok(!(await call("get_last_session", { series: "nope" })).text.includes("Next:"));
  });

  it("answers plainly when nothing is stored yet", async () => {
    assert.match((await call("get_last_session")).text, /no .* session recorded yet/);
    assert.equal((await call("save_takeaway", { text: "Something" })).isError, true);
    assert.equal((await call("get_last_session", { series: "nope" })).isError, true);
  });

  it("returns the last session with parts, versions and collectedAt", async () => {
    await store.putSessionVersion(series.id, PAST, "2020-01-07T03:00:00.000Z");
    const s = await callJson<SessionView>("get_last_session", { series: series.name.toUpperCase() });
    assert.equal(s.startedAt, PAST.start);
    assert.equal(s.parts.length, 1);
    assert.equal(s.durationMinutes, 60);
    assert.equal(s.versions, 1);
    assert.equal(s.collectedAt, "2020-01-07T03:00:00.000Z");
  });

  it("lists sessions newest first without summaries", async () => {
    await store.putSessionVersion(series.id, PAST, "2020-01-07T03:00:00.000Z");
    await store.putSessionVersion(series.id, { ...PAST, parts: [{ ...PAST.parts[0], summary: "Rewritten." }] }, "2020-01-08T03:00:00.000Z");
    await store.putSessionVersion(series.id, FUTURE);
    const res = await call("list_sessions", { limit: 5 });
    assert.ok(!res.text.includes("Synthetic summary") && !res.text.includes("Rewritten"));
    const { sessions } = JSON.parse(res.text) as { sessions: { startedAt: string; versions: number }[] };
    assert.deepEqual(sessions.map((s) => [s.startedAt, s.versions]), [
      [FUTURE.start, 1],
      [PAST.start, 2],
    ]);
  });

  it("keeps agenda items open until the next session", async () => {
    await store.putSessionVersion(series.id, PAST);
    assert.match((await call("add_agenda_item", { text: "Ask about the offsite" })).text, /1 open item\./);
    assert.match((await call("add_agenda_item", { text: "Review delegation" })).text, /2 open items/);
    const agenda = await callJson<{ items: { text: string }[] }>("list_agenda");
    assert.deepEqual(agenda.items.map((i) => i.text), ["Ask about the offsite", "Review delegation"]);

    await store.putSessionVersion(series.id, FUTURE);
    assert.match((await call("list_agenda")).text, /agenda is empty/);
  });

  it("files takeaways under the latest session", async () => {
    await store.putSessionVersion(series.id, PAST);
    const saved = await call("save_takeaway", { text: "Delegate earlier" });
    assert.equal(saved.isError, false);
    assert.deepEqual((await store.listTakeaways(series.id, PAST.start)).map((t) => t.text), ["Delegate earlier"]);
  });

  it("rejects empty text", async () => {
    assert.equal((await call("add_agenda_item", { text: "  " })).isError, true);
  });

  it("assembles a prep brief without Bedrock", async () => {
    await store.putSessionVersion(series.id, PAST);
    await call("add_agenda_item", { text: "Ask about the offsite" });
    await call("save_takeaway", { text: "Delegate earlier" });
    const brief = await callJson<PrepBriefView>("get_prep_brief");
    assert.equal(brief.source, "assembled");
    assert.equal(brief.shortSummary, "Synthetic check-in");
    assert.deepEqual(brief.insightTitles, ["Synthetic insight"]);
    assert.deepEqual(brief.openAgenda, ["Ask about the offsite"]);
    assert.deepEqual(brief.takeaways, ["Delegate earlier"]);
    assert.equal(brief.note, null);
  });

  it("prefers the precomputed brief", async () => {
    await store.putSessionVersion(series.id, PAST);
    await store.putPrepBrief({
      seriesId: series.id,
      sessionStart: PAST.start,
      note: "You checked in.",
      bullets: ["Follow up on the plan"],
      relevantInsightIds: [7],
      model: "test",
      generatedAt: PAST.end,
    });
    const brief = await callJson<PrepBriefView>("get_prep_brief");
    assert.equal(brief.source, "bedrock");
    assert.equal(brief.note, "You checked in.");
    assert.deepEqual(brief.bullets, ["Follow up on the plan"]);
    assert.deepEqual(brief.insightTitles, ["Synthetic insight"]);
  });
});
