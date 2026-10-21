// Synthetic Bee data for tests: made-up conversations and insights in the
// shapes `bee conversations list --json` and `bee insights list --json` return.
import { readFileSync } from "node:fs";
import type { BeeConversation, BeeInsight } from "../../src/bee/cli.js";
import type { Series } from "../../src/series.js";

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as T;

export const conversations = read<{ conversations: BeeConversation[] }>("conversations.json").conversations;
export const insights = read<{ insights: BeeInsight[] }>("insights.json").insights;
export const [series] = read<Series[]>("series.json");
export const fakeBee = new URL("fake-bee.mjs", import.meta.url).pathname;

export const at = (iso: string) => Date.parse(iso);

export function conversation(id: number, start: string, end: string): BeeConversation {
  return {
    id,
    start_time: at(start),
    end_time: at(end),
    summary: `Synthetic summary ${id}`,
    short_summary: `Synthetic ${id}`,
    state: "COMPLETED",
    created_at: at(end),
    updated_at: at(end),
    utterances_count: 10,
  };
}

export function insight(id: number, generatedAt: string): BeeInsight {
  return {
    id,
    title: `Synthetic insight ${id}`,
    description: "Made up for tests.",
    suggested_actions: [],
    generated_at: at(generatedAt),
    timezone: "America/Los_Angeles",
  };
}
