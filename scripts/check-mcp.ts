// End-to-end check: connects to the MCP server like any client and calls
// get_last_session, get_since_last_session and review_sessions. By default
// it prints only shape (dates, counts, lengths) so personal content stays
// off screen; pass --full to print everything.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SessionView } from "../src/mcp/server.js";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file; rely on the environment.
}

const full = process.argv.includes("--full");
const url = new URL(process.env.MCP_URL ?? `http://127.0.0.1:${process.env.MCP_PORT ?? 8788}/mcp`);
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN ?? ""}` } },
});
const client = new Client({ name: "between-sessions-check", version: "0.1.0" });

await client.connect(transport);
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const { prompts } = await client.listPrompts();
console.log("prompts:", prompts.map((p) => p.name).join(", "));

async function call(name: string) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: {} });
  const [first] = result.content as { type: string; text: string }[];
  return { ms: Date.now() - started, isError: Boolean(result.isError), text: first?.text ?? "" };
}

const last = await call("get_last_session");
if (last.isError || !last.text.startsWith("{")) {
  console.log(`get_last_session (${last.ms}ms): ${full ? last.text : `not JSON, ${last.text.length} chars`}`);
} else if (full) {
  console.log(last.text);
} else {
  const s = JSON.parse(last.text) as SessionView;
  console.log(`get_last_session (${last.ms}ms):`);
  console.log(`  series name:   ${s.series.length} chars`);
  console.log(`  started:       ${s.startedAt}`);
  console.log(`  found by:      ${s.foundBy.source}, ${s.foundBy.status}`);
  console.log(`  duration:      ${s.durationMinutes} min in ${s.parts.length} part(s)`);
  console.log(`  short summary: ${s.shortSummary.length} chars`);
  console.log(`  summary:       ${s.summary.length} chars`);
  console.log(`  debriefs:      ${s.debriefs.length}`);
  console.log(`  insights:      ${s.insights.length} in the first batch after`);
  for (const i of s.insights) {
    console.log(`    ${i.generatedAt}  title ${i.title.length} chars, description ${i.description.length} chars`);
  }
  console.log(`  source:        ${s.source}, ${s.versions} version(s), latest collected ${s.collectedAt}`);
}

const since = await call("get_since_last_session");
if (full || !since.text.startsWith("{")) {
  console.log(`get_since_last_session (${since.ms}ms): ${full ? since.text : `not JSON, ${since.text.length} chars`}`);
} else {
  const d = JSON.parse(since.text) as { conversations: number; topics: unknown[]; insightTitles: unknown[]; todosAdded: number; countsMayBeLow: boolean };
  console.log(
    `get_since_last_session (${since.ms}ms): ${d.conversations} conversations, ${d.topics.length} topics, ` +
      `${d.insightTitles.length} insight titles, ${d.todosAdded} todos, counts may be low: ${d.countsMayBeLow}`,
  );
}

const review = await call("review_sessions");
if (full || !review.text.startsWith("{")) {
  console.log(`review_sessions (${review.ms}ms): ${full || review.text === "Nothing to review." ? review.text : `${review.text.length} chars`}`);
} else {
  const r = JSON.parse(review.text) as { sessions: { filed: boolean; expiresInDays: number }[] };
  const filed = r.sessions.filter((x) => x.filed).length;
  console.log(`review_sessions (${review.ms}ms): ${r.sessions.length} to review (${filed} filed under a guess)`);
}

await client.close();
