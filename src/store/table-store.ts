// SessionStore over a single-table key layout, shared by the file store and
// DynamoDB so both behave the same:
//   PK = SERIES#<id>
//   SK = CONFIG | LATEST#SESSION | SESSION#<startISO>#V#<collectedAt>
//      | AGENDA#<createdISO>#<uuid> | TAKEAWAY#<sessionStartISO>#<uuid>
//      | BRIEF#<sessionStartISO>
import { createHash, randomUUID } from "node:crypto";
import { normalizeSeries, type Series } from "../series.js";
import type {
  AgendaItem,
  PrepBrief,
  SessionInput,
  SessionStore,
  SessionVersion,
  Takeaway,
} from "./types.js";

export interface Item {
  PK: string;
  SK: string;
  [key: string]: unknown;
}

export interface Table {
  get(pk: string, sk: string): Promise<Item | undefined>;
  put(item: Item): Promise<void>;
  // Items under pk whose SK starts with prefix, sorted by SK.
  query(pk: string, prefix: string, opts?: { descending?: boolean; limit?: number }): Promise<Item[]>;
  // Every item with this exact SK, across partitions.
  scanSk(sk: string): Promise<Item[]>;
}

const pk = (seriesId: string) => `SERIES#${seriesId}`;
const LATEST = "LATEST#SESSION";

export function contentHash(session: SessionInput): string {
  const h = createHash("sha256");
  for (const p of session.parts) h.update(`${p.id}\n${p.shortSummary}\n${p.summary}\n`);
  h.update(session.insights.map((i) => i.id).join(","));
  return h.digest("hex").slice(0, 32);
}

const strip = <T>({ PK, SK, ...rest }: Item) => rest as T;

export class TableStore implements SessionStore {
  constructor(private readonly table: Table) {}

  async putSessionVersion(seriesId: string, session: SessionInput, collectedAt = new Date().toISOString()) {
    const prefix = `SESSION#${session.start}#V#`;
    const existing = await this.table.query(pk(seriesId), prefix, { descending: true });
    const hash = contentHash(session);
    const current = existing[0] && strip<SessionVersion>(existing[0]);
    if (current && current.hash === hash) {
      return { version: { ...current, versions: existing.length }, written: false };
    }
    const version: SessionVersion = { ...session, seriesId, hash, collectedAt, versions: existing.length + 1 };
    await this.table.put({ PK: pk(seriesId), SK: `${prefix}${collectedAt}`, ...version });
    const latest = await this.getLatestSession(seriesId);
    if (!latest || latest.start <= session.start) {
      await this.table.put({ PK: pk(seriesId), SK: LATEST, ...version });
    }
    return { version, written: true };
  }

  async getLatestSession(seriesId: string) {
    const item = await this.table.get(pk(seriesId), LATEST);
    return item ? strip<SessionVersion>(item) : null;
  }

  async listSessions(seriesId: string, limit: number) {
    const items = await this.table.query(pk(seriesId), "SESSION#", { descending: true });
    const byStart = new Map<string, SessionVersion>();
    for (const item of items) {
      const v = strip<SessionVersion>(item);
      const seen = byStart.get(v.start);
      if (seen) seen.versions = Math.max(seen.versions, v.versions);
      else if (byStart.size < limit) byStart.set(v.start, v);
    }
    return [...byStart.values()];
  }

  // Strictly increasing within this process, so items added in the same
  // millisecond keep their order.
  private last = 0;
  private stamp() {
    this.last = Math.max(Date.now(), this.last + 1);
    return new Date(this.last).toISOString();
  }

  async addAgendaItem(seriesId: string, text: string) {
    const item: AgendaItem = { id: randomUUID(), seriesId, text, createdAt: this.stamp() };
    await this.table.put({ PK: pk(seriesId), SK: `AGENDA#${item.createdAt}#${item.id}`, ...item });
    return item;
  }

  async listAgenda(seriesId: string) {
    return (await this.table.query(pk(seriesId), "AGENDA#")).map((i) => strip<AgendaItem>(i));
  }

  async saveTakeaway(seriesId: string, sessionStart: string, text: string) {
    const item: Takeaway = { id: randomUUID(), seriesId, sessionStart, text, createdAt: new Date().toISOString() };
    await this.table.put({ PK: pk(seriesId), SK: `TAKEAWAY#${sessionStart}#${item.id}`, ...item });
    return item;
  }

  async listTakeaways(seriesId: string, sessionStart?: string) {
    const prefix = sessionStart ? `TAKEAWAY#${sessionStart}#` : "TAKEAWAY#";
    return (await this.table.query(pk(seriesId), prefix)).map((i) => strip<Takeaway>(i));
  }

  async putPrepBrief(brief: PrepBrief) {
    await this.table.put({ PK: pk(brief.seriesId), SK: `BRIEF#${brief.sessionStart}`, ...brief });
  }

  async getPrepBrief(seriesId: string, sessionStart: string) {
    const item = await this.table.get(pk(seriesId), `BRIEF#${sessionStart}`);
    return item ? strip<PrepBrief>(item) : null;
  }

  async getSeries(id: string) {
    const item = await this.table.get(pk(id), "CONFIG");
    return item ? normalizeSeries(strip(item)) : null;
  }

  async listSeries() {
    const items = await this.table.scanSk("CONFIG");
    return items.map((i) => normalizeSeries(strip(i))).sort((a, b) => a.id.localeCompare(b.id));
  }

  async putSeries(series: Series) {
    await this.table.put({ PK: pk(series.id), SK: "CONFIG", ...series });
  }
}
