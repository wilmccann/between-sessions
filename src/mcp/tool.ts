// What every tool file shares: the tool shape, the reply helpers and series
// resolution. Tools only read and write the store.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { matchSeriesName, OTHER_ID, type Series } from "../series.js";
import type { SessionStore } from "../store/types.js";
import { formatShort, nextSession } from "../time.js";

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

// Which series a request means when it names none: "recent" for looking
// back or filing on a session (takeaways, debriefs), "next" for preparing
// for one (prep brief, agenda).
export type Purpose = "recent" | "next";

export type Chosen =
  | { series: Series; why: string | null; failure?: undefined }
  | { series?: undefined; why?: undefined; failure: CallToolResult };

const names = (all: Series[]) => all.map((s) => s.name).join(", ");

// The series to use: a named one (fuzzy-matched), the only one, the most
// recently ended session's, or the next scheduled one's. `why` says which
// rule picked it, so the answer can say which series was used; it's null
// when the user named it or there's only one. Asks when it can't tell.
export async function chooseSeries(
  store: SessionStore,
  wanted: string | undefined,
  purpose: Purpose,
  now = Date.now(),
): Promise<Chosen> {
  const all = await store.listSeries();
  if (!all.length) return { failure: error("No series is set up yet.") };
  if (wanted) {
    const m = matchSeriesName(all, wanted);
    if (m.kind === "match") return { series: m.series, why: null };
    if (m.kind === "ambiguous") return { failure: error(`Did you mean ${m.candidates.map((s) => s.name).join(" or ")}?`) };
    return { failure: error(`I don't know a series called ${wanted}. Your series: ${names(all)}.`) };
  }
  if (all.length === 1) return { series: all[0], why: null };
  const real = all.filter((s) => s.id !== OTHER_ID);
  if (purpose === "next" && real.length === 1) return { series: real[0], why: null };

  if (purpose === "next") {
    const upcoming = real
      .map((series) => ({ series, next: nextSession(series, now) }))
      .filter((x) => x.next)
      .sort((a, b) => a.next!.start - b.next!.start)[0];
    if (upcoming) {
      const when = formatShort(upcoming.next!.start, upcoming.series.timezone);
      return { series: upcoming.series, why: `Using ${upcoming.series.name}, your next scheduled session (${when}).` };
    }
  }
  const pool = purpose === "next" ? real : all;
  const latest = (await Promise.all(pool.map(async (series) => ({ series, last: await store.getLatestSession(series.id) }))))
    .filter((x) => x.last)
    .sort((a, b) => Date.parse(b.last!.end) - Date.parse(a.last!.end))[0];
  if (latest) return { series: latest.series, why: `Using ${latest.series.name}, your most recent session.` };
  if (real.length === 1) return { series: real[0], why: null };
  return { failure: error(`Which series? Your series: ${names(all)}.`) };
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
