// What every tool file shares: the tool shape, the reply helpers and series
// resolution. Tools only read and write the store.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Series } from "../series.js";
import type { SessionStore } from "../store/types.js";

export interface ToolContext {
  store: SessionStore;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  register(server: McpServer, ctx: ToolContext): void;
}

export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations?: ToolAnnotations;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>;
}): ToolDef {
  const { name, title, description, inputSchema, annotations, run } = def;
  return {
    name,
    title,
    description,
    register(server, ctx) {
      server.registerTool(name, { title, description, inputSchema, annotations }, ((args: z.infer<z.ZodObject<S>>) =>
        run(args, ctx)) as never);
    },
  };
}

export const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
export const json = (value: unknown) => text(JSON.stringify(value, null, 2));
export const error = (t: string): CallToolResult => ({ isError: true, ...text(t) });

export const minutes = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

export const seriesArg = z
  .string()
  .optional()
  .describe("Which recurring series, by id or name. Leave it out for the default series.");

export const noteText = z.string().trim().min(1).max(500);

export async function resolveSeries(store: SessionStore, wanted?: string): Promise<Series | null> {
  if (!wanted) return (await store.listSeries())[0] ?? null;
  const byId = await store.getSeries(wanted);
  if (byId) return byId;
  const all = await store.listSeries();
  return all.find((s) => s.name.toLowerCase() === wanted.toLowerCase()) ?? null;
}

export async function withSeries(store: SessionStore, wanted: string | undefined) {
  const series = await resolveSeries(store, wanted);
  return series
    ? { series }
    : { failure: error(wanted ? `I don't know a series called ${wanted}.` : "No series is set up yet.") };
}
