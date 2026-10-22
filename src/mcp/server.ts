// The MCP server, shared by the local HTTP server and the Lambda. Tools only
// read and write the store; nothing here calls Bee or Bedrock, so every
// answer comes from precomputed data. Each tool lives in tools/, and
// capabilities.ts lists them with the menu, instructions and prompts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionStore } from "../store/types.js";
import { CAPABILITIES, instructions, TOOLS } from "./capabilities.js";

export { describeSession, prepBrief, type PrepBriefView, type SessionView } from "./views.js";

export function createMcpServer(store: SessionStore): McpServer {
  const server = new McpServer({ name: "between-sessions", version: "0.4.0" }, { instructions: instructions() });
  for (const tool of TOOLS) tool.register(server, { store });
  for (const { prompt } of CAPABILITIES) {
    if (!prompt) continue;
    const argsSchema = Object.fromEntries(
      Object.entries(prompt.args).map(([name, description]) => [name, z.string().optional().describe(description)]),
    );
    server.registerPrompt(prompt.name, { title: prompt.title, argsSchema }, ((args: Record<string, string | undefined>) => ({
      messages: [{ role: "user", content: { type: "text", text: prompt.text(args ?? {}) } }],
    })) as never);
  }
  return server;
}
