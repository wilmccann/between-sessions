// The MCP server, shared by the local HTTP server and the Lambda. Tools only
// read and write the store; nothing here calls Bee or Bedrock, so every
// answer comes from precomputed data. Each tool lives in tools/, and
// capabilities.ts lists them.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionStore } from "../store/types.js";
import { TOOLS } from "./capabilities.js";

export { describeSession, prepBrief, type PrepBriefView, type SessionView } from "./views.js";

export function createMcpServer(store: SessionStore): McpServer {
  const server = new McpServer({ name: "between-sessions", version: "0.3.0" });
  for (const tool of TOOLS) tool.register(server, { store });
  return server;
}
