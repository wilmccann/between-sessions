// End-to-end check: connects to the MCP server like any client and calls
// get_last_session. By default it prints only shape (dates, counts, lengths)
// so personal content stays off screen; pass --full to print everything.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LastSession } from "../src/sessions.js";

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

const started = Date.now();
const result = await client.callTool({ name: "get_last_session", arguments: {} });
const ms = Date.now() - started;
const [first] = result.content as { type: string; text: string }[];

if (result.isError || !first?.text.startsWith("{")) {
  console.log(`get_last_session (${ms}ms):`, first?.text);
} else if (full) {
  console.log(first.text);
} else {
  const s = JSON.parse(first.text) as LastSession & { collectedAt: string };
  console.log(`get_last_session (${ms}ms):`);
  console.log(`  series:        ${s.series}`);
  console.log(`  started:       ${s.startedAtLocal}`);
  console.log(`  duration:      ${s.durationMinutes} min`);
  console.log(`  short summary: ${s.shortSummary.length} chars`);
  console.log(`  summary:       ${s.summary.length} chars`);
  console.log(`  insights:      ${s.insights.length} in the ${s.insights.length ? "days" : "hours"} after`);
  for (const i of s.insights) {
    console.log(`    ${i.generatedAt}  title ${i.title.length} chars, description ${i.description.length} chars`);
  }
  console.log(`  source:        ${s.source}, collected ${s.collectedAt}`);
}

await client.close();
