// Synthetic Bee data for the review page's Bee data tab, dated relative to
// `now` so the 14-day window can be tested. Every text starts "Synthetic:",
// so a test can search a response for it. Locations and links are included
// only to prove they're dropped.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LOCATION = { address: "Synthetic: 1 Fake Street", latitude: 1.5, longitude: 2.5 };
export const LINK = "https://synthetic.example/conversations/";

// Newest first, as Bee lists them. With two per page, the journals stop
// after the page holding `jrnl-synthetic-old` and never read `-older`.
export function beeTabData(now = Date.now()) {
  const journal = (id: string, agoMs: number, text: string) => ({
    id,
    text,
    state: "READY",
    created_at: now - agoMs,
    updated_at: now - agoMs + 60_000,
    corrections: [],
  });
  const conversation = (id: number, agoMs: number, end: number | null = now - agoMs + HOUR) => ({
    id,
    state: end === null ? "CAPTURING" : "COMPLETED",
    created_at: now - agoMs,
    updated_at: (end ?? now - agoMs) + 60_000,
    start_time: now - agoMs,
    end_time: end,
    short_summary: `Synthetic: short ${id}`,
    summary: `Synthetic: long summary ${id}`,
    utterances_count: 12,
    device_type: "synthetic",
    primary_location: LOCATION,
  });
  const insight = (id: number, agoMs: number) => ({
    id,
    title: `Synthetic: insight title ${id}`,
    description: `Synthetic: insight description ${id}`,
    generated_at: now - agoMs,
    suggested_actions: [],
    timezone: "America/New_York",
  });
  return {
    journals: [
      journal("jrnl-synthetic-6666", HOUR, "Synthetic: Marty, start coaching session."),
      journal("jrnl-synthetic-5555", 5 * HOUR, "Synthetic: Marty, retag that as x."),
      journal("jrnl-synthetic-3333", DAY, "Synthetic: a plain thought about the garden."),
      journal("jrnl-synthetic-1111", 2 * DAY, "Synthetic: Marty, start session."),
      journal("jrnl-synthetic-7777", 3 * DAY, "Synthetic: a remark about Smarty the cat."),
      journal("jrnl-synthetic-old", 20 * DAY, "Synthetic: too old to show."),
      journal("jrnl-synthetic-older", 25 * DAY, "Synthetic: never read."),
    ],
    conversations: [
      conversation(900666, 2 * HOUR, null), // in progress, not captured
      conversation(900111, DAY), // a Coaching session
      conversation(900444, 2 * DAY), // waiting for review, a guess
      conversation(900333, 3 * DAY), // waiting for review, filed
      conversation(900555, 4 * DAY), // not a session
      conversation(900222, 5 * DAY), // a Weekly therapy session
      conversation(900999, 30 * DAY),
      conversation(900998, 31 * DAY),
    ],
    insights: [insight(2101, 3 * HOUR), insight(2102, 2 * DAY), insight(2103, 20 * DAY)],
    search: {
      results: [
        {
          id: 900111,
          type: "conversation",
          created_at: now - DAY,
          score: 7.5,
          snippet: "Synthetic: keyword snippet 900111",
          title_snippet: "Synthetic: keyword title 900111",
          summary: "Synthetic: keyword summary 900111",
          corrections: [],
        },
        { id: 3001, type: "daily", created_at: now - 2 * DAY, score: 3.25, snippet: "Synthetic: daily snippet", title_snippet: "", summary: "Synthetic: daily summary", corrections: [] },
        { id: 3002, type: "fact", created_at: now - 3 * DAY, score: 9, snippet: "Synthetic: fact snippet", title_snippet: "", summary: "", corrections: [] },
      ],
      next_cursor: null,
      search_mode: "keyword",
      timezone: "America/New_York",
    },
    neural: {
      results: [
        {
          id: 900333,
          started_at: now - 3 * DAY,
          stopped_at: now - 3 * DAY + HOUR,
          short_summary: "Synthetic: neural short 900333",
          detailed_summary: "Synthetic: neural detailed 900333",
          link: `${LINK}900333`,
          locations: [LOCATION],
        },
        {
          id: 900666,
          started_at: now - 2 * HOUR,
          stopped_at: null,
          short_summary: "Synthetic: neural short 900666",
          detailed_summary: "Synthetic: neural detailed 900666",
          link: `${LINK}900666`,
          locations: [LOCATION],
        },
      ],
      total: 2,
      timezone: "America/New_York",
    },
  };
}

export type BeeTabData = ReturnType<typeof beeTabData>;

// Writes the fixture files the fake bee reads (FAKE_BEE_DIR) and returns the
// directory, plus a file for its argument log (FAKE_BEE_ARGV).
export async function writeBeeTabData(data: BeeTabData = beeTabData()) {
  const dir = await mkdtemp(join(tmpdir(), "bs-bee-tab-"));
  const tz = { timezone: "America/New_York" };
  await writeFile(join(dir, "journals.json"), JSON.stringify({ journals: data.journals, next_cursor: null, ...tz }));
  await writeFile(join(dir, "conversations.json"), JSON.stringify({ conversations: data.conversations, next_cursor: null, ...tz }));
  await writeFile(join(dir, "insights.json"), JSON.stringify({ insights: data.insights, next_cursor: null, ...tz }));
  await writeFile(join(dir, "search.json"), JSON.stringify(data.search));
  await writeFile(join(dir, "neural.json"), JSON.stringify(data.neural));
  return { dir, argvFile: join(dir, "argv.jsonl") };
}
