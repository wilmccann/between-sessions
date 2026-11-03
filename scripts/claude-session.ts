// Opens a new Claude Code session connected to Between Sessions, and asks
// "What can I ask?" to start. Quitting Claude stops everything this started.
//
//   yarn demo:claude           # local MCP server on the synthetic demo store
//   MCP_TOKEN='{{resolve:secretsmanager:between-sessions/mcp-token}}' AWS_PROFILE=bee-agent \
//     asm-exec -- corepack yarn aws:claude
//                              # the deployed server, with your real sessions
//
// demo:claude seeds snapshots/demo-store.json if it's missing, starts the local
// server on a free port with a token made for this run, and pre-approves the
// server's tools. aws:claude (--real) reads McpUrl from the BetweenSessions stack (or
// MCP_URL) and asks before each tool, as usual.
//
// Either way Claude runs in an empty folder outside this repo,
// ~/.cache/between-sessions/claude-session (Claude Code asks you to trust it
// the first time), with its built-in tools off (no shell, no file reading), so
// it answers only through Between Sessions' tools. The token goes only into a
// temporary MCP config (0600, deleted on exit) and is removed from Claude's
// environment, so nothing prints it.
// aws:claude shows personal content: run it in your own terminal only.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { instructions } from "../src/mcp/capabilities.js";

const real = process.argv.includes("--real");
const DEMO_STORE = "snapshots/demo-store.json";
const FIRST_PROMPT = "What can I ask?";

// The server sends the same instructions when it connects, but an interactive
// session can send the first prompt before that, and with no repo around,
// Claude would answer as a coding assistant. So it gets them up front too.
const PRODUCT_PROMPT = [
  "This Claude Code session is Between Sessions, connected to its MCP server. Answer only through the Between Sessions tools. You have no file, shell or browser tools here, so don't offer coding or computer help.",
  "If the Between Sessions tools aren't available yet, say they're still connecting and ask the user to repeat the question in a moment.",
  "",
  instructions(),
].join("\n");

const run = promisify(execFile);
const tsx = (script: string, opts: Parameters<typeof spawn>[2]) =>
  spawn(process.execPath, ["--import", "tsx", script], opts);

let server: ChildProcess | undefined;
let configDir: string | undefined;
let claudeRunning = false;
process.on("exit", () => {
  server?.kill();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});
// While Claude runs, Ctrl-C is Claude's (it asks twice before quitting).
process.on("SIGINT", () => {
  if (!claudeRunning) process.exit(130);
});
process.on("SIGTERM", () => process.exit(143));
process.on("SIGHUP", () => process.exit(129));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}

// Starts the local server and resolves once it prints its ready line.
function startLocalServer(token: string, port: number): Promise<void> {
  server = tsx("src/local/mcp-http.ts", {
    env: { ...process.env, MCP_TOKEN: token, MCP_PORT: String(port), STORE_FILE: DEMO_STORE },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // its own process group, so Ctrl-C in Claude doesn't reach it
  });
  const child = server;
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("the local MCP server didn't start within 20 s")), 20_000);
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("MCP server on")) {
        clearTimeout(timer);
        child.stdout!.resume();
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the local MCP server exited (${code}): ${stderr.trim()}`));
    });
  });
}

let name: string;
let url: string;
let token: string;
if (real) {
  name = "between-sessions";
  token = process.env.MCP_TOKEN ?? "";
  if (token.length < 32 || token.startsWith("{{resolve")) {
    fail(
      "aws:claude needs the deployed server's token in MCP_TOKEN, resolved at runtime:\n" +
        "  MCP_TOKEN='{{resolve:secretsmanager:between-sessions/mcp-token}}' AWS_PROFILE=bee-agent \\\n" +
        "    asm-exec -- corepack yarn aws:claude",
    );
  }
  url = process.env.MCP_URL ?? (await stackOutput("McpUrl").catch((err) => fail(`couldn't read McpUrl: ${err.message}`)));
  if (!url.startsWith("https://")) fail(`McpUrl not found in the BetweenSessions stack (got "${url}")`);
} else {
  name = "between-sessions-demo";
  if (!existsSync(DEMO_STORE)) {
    const code = await waitForExit(tsx("scripts/demo-seed.ts", { stdio: "inherit" }));
    if (code !== 0) fail("couldn't seed the demo store");
  }
  token = randomBytes(32).toString("base64url");
  const port = await freePort();
  url = `http://127.0.0.1:${port}/mcp`;
  await startLocalServer(token, port).catch((err) => fail(err.message));
}

configDir = mkdtempSync(join(tmpdir(), "between-sessions-"));
const configFile = join(configDir, "mcp.json");
const config = { mcpServers: { [name]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } };
writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });

// Claude runs as the product, not as a coding assistant: in an empty folder
// outside the repo (so it loads none of this repo's files or instructions)
// with every built-in tool off, so only Between Sessions' tools are left. The
// folder stays put between runs, so Claude Code asks to trust it only once.
const sessionDir = join(homedir(), ".cache", "between-sessions", "claude-session");
mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
const env = { ...process.env };
delete env.MCP_TOKEN;
// The prompt goes first: --tools, --mcp-config and --allowedTools take lists
// and would swallow it.
const args = [FIRST_PROMPT, "--append-system-prompt", PRODUCT_PROMPT, "--tools", "", "--mcp-config", configFile, "--strict-mcp-config"];
if (!real) args.push("--allowedTools", `mcp__${name}`);

console.log(real ? `Opening Claude on ${url} (your real sessions)...` : `Opening Claude on the demo server (${url}, synthetic data)...`);
claudeRunning = true;
const claude = spawn("claude", args, { stdio: "inherit", env, cwd: sessionDir });
claude.once("error", (err) => fail(`couldn't start claude: ${err.message}`));
process.exit(await waitForExit(claude)); // the exit handler stops the server
