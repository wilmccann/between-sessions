// A seeded store and an HTTP helper for the review page tests.
import { readFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { reviewServer, type ReviewServerOptions } from "../../src/local/review-ui.js";
import type { TableStore } from "../../src/store/table-store.js";
import type { SessionInput, SessionTag } from "../../src/store/types.js";
import { acme, coaching, other, therapy } from "./meeting-types.js";

// All synthetic, October 2026 in New York.
const session = (start: string, end: string, id: number, tag: SessionTag): SessionInput => ({
  start,
  end,
  parts: [{ id, start, end, shortSummary: `Synthetic short ${id}`, summary: `Synthetic long summary ${id}` }],
  insights: [],
  tag,
});
export const COACHING = "2026-10-15T20:02:00.000Z";
export const THERAPY = "2026-10-20T21:00:00.000Z";
export const OTHER = "2026-10-21T18:00:00.000Z";
export const ACME_GUESS = "2026-10-19T15:00:00.000Z";

export async function seed(store: TableStore) {
  for (const s of [therapy, coaching, acme, other]) await store.putSeries(s);
  await store.recordSession(
    coaching.id,
    session(COACHING, "2026-10-15T20:55:00.000Z", 900111, { source: "schedule", confidence: "high", status: "auto", reason: "Thu 16:00 to 17:00 slot" }),
    "2026-10-15T21:30:00.000Z",
  );
  await store.recordSession(
    therapy.id,
    session(THERAPY, "2026-10-20T22:00:00.000Z", 900222, { source: "marker", confidence: "certain", status: "auto", reason: "Your markers" }),
    "2026-10-20T22:30:00.000Z",
  );
  await store.recordSession(
    other.id,
    session(OTHER, "2026-10-21T18:30:00.000Z", 900333, { source: "marker", confidence: "low", status: "pending", reason: "Unnamed start marker" }),
    "2026-10-21T19:00:00.000Z",
  );
  await store.putReviewItem({
    seriesId: other.id,
    start: OTHER,
    end: "2026-10-21T18:30:00.000Z",
    conversationIds: [900333],
    source: "marker",
    reason: "Unnamed start marker",
    filed: true,
    dropsAt: "2026-11-04T18:00:00.000Z",
  });
  await store.putReviewItem({
    seriesId: acme.id,
    start: ACME_GUESS,
    end: "2026-10-19T15:45:00.000Z",
    conversationIds: [900444],
    source: "keyword",
    reason: "Keyword acme",
    filed: false,
    dropsAt: "2026-11-02T15:00:00.000Z",
  });
  await store.putMarker({ journalId: "jrnl-synthetic-1111", kind: "start", at: OTHER });
  await store.putMarker({ journalId: "jrnl-synthetic-2222", kind: "end", at: "2026-10-21T18:30:00.000Z" });
  await store.putJournalRecord({ journalId: "jrnl-synthetic-1111", at: OTHER, kind: "start", status: "filed" });
  await store.putJournalRecord({ journalId: "jrnl-synthetic-3333", at: "2026-10-21T19:00:00.000Z", kind: "note", status: "ignored" });
  await store.addAgendaItem(coaching.id, "Synthetic: bring up the trip", { source: "bee", journalId: "jrnl-synthetic-4444", createdAt: "2026-10-21T12:00:00.000Z" });
  await store.addAgendaItem(therapy.id, "Synthetic: sleep", { createdAt: "2026-10-21T13:00:00.000Z" });
  await store.saveTakeaway(other.id, OTHER, "Synthetic takeaway", { createdAt: "2026-10-21T18:40:00.000Z" });
}

// The seed, plus the other things Marty can do with a voice note or
// conversation, for the Bee data tab (ids match test/fixtures/bee-tab.ts).
export async function seedBeeTab(store: TableStore) {
  await seed(store);
  await store.putClaims([{ conversationId: 900555, seriesId: "", sessionStart: "", source: "you", status: "rejected" }]);
  await store.putJournalRecord({ journalId: "jrnl-synthetic-5555", at: "2026-10-22T10:00:00.000Z", kind: "retag", status: "unfiled", reason: "I don't know a series called x" });
  await store.putJournalRecord({ journalId: "jrnl-synthetic-6666", at: "2026-10-22T11:00:00.000Z", kind: "start", status: "filed", seriesId: coaching.id });
}

// The fake bee's argument log (FAKE_BEE_ARGV), one array per call.
export const argvLines = async (file: string): Promise<string[][]> =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

export interface Reply {
  status: number;
  type: string;
  body: string;
  json: () => any;
}

export function call(
  port: number,
  path: string,
  { method = "GET", host = `127.0.0.1:${port}`, token, body, contentType = "application/json" }: { method?: string; host?: string; token?: string; body?: unknown; contentType?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: host };
    if (token !== undefined) headers["X-Review-Token"] = token;
    if (body !== undefined) headers["Content-Type"] = contentType;
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), body: data, json: () => JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

export async function startServer(store: TableStore, token: string, opts: ReviewServerOptions = {}): Promise<{ server: Server; port: number }> {
  const server = reviewServer(store, token, opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}
