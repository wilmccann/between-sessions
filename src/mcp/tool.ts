// What every tool file shares: the tool shape, the reply helpers and series
// resolution. Tools only read and write the store.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { choose, type Purpose } from "../choose.js";
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
  // One suggested next step, added to every successful answer.
  next?: string;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>;
}): ToolDef {
  const { name, title, description, inputSchema, annotations, next, run } = def;
  return {
    name,
    title,
    description,
    register(server, ctx) {
      server.registerTool(name, { title, description, inputSchema, annotations }, (async (args: z.infer<z.ZodObject<S>>) =>
        withNext(next, await run(args, ctx))) as never);
    },
  };
}

// JSON answers get a `next` field; text answers get a "Next:" line.
export function withNext(next: string | undefined, answer: CallToolResult): CallToolResult {
  if (!next || answer.isError) return answer;
  const [first, ...rest] = answer.content;
  if (first?.type !== "text") return answer;
  const body = first.text.startsWith("{")
    ? JSON.stringify({ ...JSON.parse(first.text), next }, null, 2)
    : `${first.text}\nNext: ${next}`;
  return { ...answer, content: [{ type: "text", text: body }, ...rest] };
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

export type Chosen =
  | { series: Series; why: string | null; failure?: undefined }
  | { series?: undefined; why?: undefined; failure: CallToolResult };

// The series a tool call means (see choose.ts); asks when it can't tell.
export async function chooseSeries(
  store: SessionStore,
  wanted: string | undefined,
  purpose: Purpose,
  now = Date.now(),
): Promise<Chosen> {
  const c = await choose(store, wanted, purpose, now);
  return c.series ? { series: c.series, why: c.why } : { failure: error(c.ask!) };
}

// Puts the "which series" sentence in front of a text answer, or into a
// JSON answer as `seriesChosen`.
export function say(why: string | null, answer: CallToolResult): CallToolResult {
  if (!why) return answer;
  const [first, ...rest] = answer.content;
  if (first?.type !== "text") return answer;
  const body = first.text.startsWith("{")
    ? JSON.stringify({ seriesChosen: why, ...JSON.parse(first.text) }, null, 2)
    : `${why} ${first.text}`;
  return { ...answer, content: [{ type: "text", text: body }, ...rest] };
}
