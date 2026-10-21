// Smoke test for the deployed remote MCP server. Reads the URL from the
// BetweenSessions stack outputs. The token must arrive in MCP_TOKEN at
// runtime, resolved from Secrets Manager without being printed:
//
//   MCP_TOKEN='{{resolve:secretsmanager:between-sessions/mcp-token}}' asm-exec -- corepack yarn check:remote
//
// Without a token it only checks that the endpoint is up and refuses
// unauthenticated requests.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function stackOutput(key: string): Promise<string> {
  const { stdout } = await run("aws", [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    "BetweenSessions",
    "--region",
    process.env.AWS_REGION ?? "us-east-1",
    "--query",
    `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`,
    "--output",
    "text",
  ]);
  return stdout.trim();
}

const url = process.env.MCP_URL ?? (await stackOutput("McpUrl"));
console.log(`remote MCP: ${url}`);

const probe = async (method: string, headers: Record<string, string> = {}) =>
  (await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? "{}" : undefined })).status;

const noToken = await probe("POST");
const wrongToken = await probe("POST", { authorization: "Bearer not-the-token" });
console.log(`no token: ${noToken}, wrong token: ${wrongToken} (want 401 and 401)`);
if (noToken !== 401 || wrongToken !== 401) process.exitCode = 1;

if (!process.env.MCP_TOKEN || process.env.MCP_TOKEN.startsWith("{{")) {
  console.log("MCP_TOKEN not set; skipping the tool calls. See the header of this script.");
} else {
  process.env.MCP_URL = url;
  await import("./check-mcp.js");
}
