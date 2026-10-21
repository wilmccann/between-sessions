// Thin wrapper around the Bee CLI (`@beeai/cli`). Every read goes through
// `bee <resource> list --json`, so the CLI owns auth and the API host.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface BeeConversation {
  id: number;
  start_time: number; // epoch ms
  end_time: number; // epoch ms
  summary: string;
  short_summary: string;
  state: string;
  created_at: number;
  updated_at: number;
  utterances_count: number;
}

export interface BeeInsight {
  id: number;
  title: string;
  description: string;
  suggested_actions: unknown[];
  generated_at: number; // epoch ms
  timezone: string;
}

interface Page {
  next_cursor?: string | null;
  [key: string]: unknown;
}

const BEE_BIN = process.env.BEE_BIN ?? "bee";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export async function bee<T = unknown>(args: string[]): Promise<T> {
  const { stdout } = await run(BEE_BIN, [...args, "--json"], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

// Pages through `bee <resource> list` until it reaches items older than
// `sinceMs`. Bee returns newest first.
async function listSince<T>(
  resource: string,
  key: string,
  timeOf: (item: T) => number,
  sinceMs: number,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = [resource, "list", "--limit", String(PAGE_SIZE)];
    if (cursor) args.push("--cursor", cursor);
    const res = await bee<Page>(args);
    const batch = (res[key] as T[] | undefined) ?? [];
    items.push(...batch);
    cursor = res.next_cursor ?? undefined;
    const oldest = Math.min(...batch.map(timeOf));
    if (!cursor || batch.length === 0 || oldest < sinceMs) break;
  }
  return items.filter((item) => timeOf(item) >= sinceMs);
}

export function listConversations(sinceMs: number): Promise<BeeConversation[]> {
  return listSince<BeeConversation>("conversations", "conversations", (c) => c.start_time, sinceMs);
}

export function listInsights(sinceMs: number): Promise<BeeInsight[]> {
  return listSince<BeeInsight>("insights", "insights", (i) => i.generated_at, sinceMs);
}
