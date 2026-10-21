// Local MCP server over Streamable HTTP (stateless, JSON responses), guarded
// by a static bearer token from MCP_TOKEN. Binds to 127.0.0.1 only.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.js";
import { fileStore } from "../store/file-store.js";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file; rely on the environment.
}

const token = process.env.MCP_TOKEN;
if (!token || token.length < 32) {
  console.error("MCP_TOKEN is missing or shorter than 32 characters. See .env.example.");
  process.exit(1);
}
const store = fileStore();
const port = Number(process.env.MCP_PORT ?? 8788);
const digest = (s: string) => createHash("sha256").update(s).digest();
const expected = digest(token);

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(presented), expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const http = createServer(async (req, res) => {
  const started = Date.now();
  const log = (status: number) =>
    console.log(`${req.method} ${req.url} ${status} ${Date.now() - started}ms`);

  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return log(404);
  }
  if (!authorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
    return log(401);
  }
  if (req.method !== "POST") {
    // Stateless server: no SSE stream (GET) and no sessions to end (DELETE).
    res.writeHead(405, { Allow: "POST" }).end();
    return log(405);
  }

  try {
    const body = await readJson(req);
    const server = createMcpServer(store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    log(res.statusCode);
  } catch (err) {
    console.error("request failed:", (err as Error).message);
    if (!res.headersSent) res.writeHead(500).end();
    log(500);
  }
});

http.listen(port, "127.0.0.1", () => {
  console.log(`Between Sessions MCP server on http://127.0.0.1:${port}/mcp`);
});
