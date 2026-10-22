// Prints the prep brief from the deployed MCP server, for reading before a
// session. It prints personal content, so run it in your own terminal:
//
//   AWS_PROFILE=bee-agent AWS_REGION=us-east-1 \
//     MCP_TOKEN='{{resolve:secretsmanager:between-sessions/mcp-token}}' asm-exec -- corepack yarn brief
//
// --shape prints counts and lengths only (for checks run by an agent).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PrepBriefView } from "../src/mcp/server.js";

const run = promisify(execFile);

async function mcpUrl(): Promise<string> {
  if (process.env.MCP_URL) return process.env.MCP_URL;
  const { stdout } = await run("aws", [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    "BetweenSessions",
    "--region",
    process.env.AWS_REGION ?? "us-east-1",
    "--query",
    "Stacks[0].Outputs[?OutputKey=='McpUrl'].OutputValue",
    "--output",
    "text",
  ]);
  return stdout.trim();
}

if (!process.env.MCP_TOKEN || process.env.MCP_TOKEN.startsWith("{{")) {
  console.error("MCP_TOKEN isn't set. Run this through asm-exec; see the header of this script.");
  process.exit(1);
}

const shape = process.argv.includes("--shape");
const transport = new StreamableHTTPClientTransport(new URL(await mcpUrl()), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } },
});
const client = new Client({ name: "between-sessions-brief", version: "0.1.0" });
await client.connect(transport);

const result = await client.callTool({ name: "get_prep_brief", arguments: {} });
const [first] = result.content as { type: string; text: string }[];
await client.close();

if (result.isError || !first?.text.startsWith("{")) {
  console.log(first?.text ?? "No answer from get_prep_brief.");
  process.exit(result.isError ? 1 : 0);
}

const b = JSON.parse(first.text) as PrepBriefView;
const list = (items: string[]) => (items.length ? items.map((i) => `  - ${i}`).join("\n") : "  (none)");

if (shape) {
  console.log(`source: ${b.source}, last session: ${b.lastSessionLocal ?? "none"}`);
  console.log(`short summary ${b.shortSummary?.length ?? 0} chars, note ${b.note?.length ?? 0} chars`);
  console.log(
    `bullets ${b.bullets.length}, insights ${b.insightTitles.length}, agenda ${b.openAgenda.length}, takeaways ${b.takeaways.length}`,
  );
} else {
  console.log(`Prep brief: ${b.series} (${b.source})\n`);
  console.log(`Last session: ${b.lastSessionLocal ?? "none yet"}`);
  if (b.shortSummary) console.log(`\n${b.shortSummary}`);
  if (b.note) console.log(`\n${b.note}`);
  if (b.bullets.length) console.log(`\nTo bring up:\n${list(b.bullets)}`);
  console.log(`\nBee's insights after it:\n${list(b.insightTitles)}`);
  console.log(`\nYour takeaways:\n${list(b.takeaways)}`);
  console.log(`\nOpen agenda:\n${list(b.openAgenda)}`);
}
