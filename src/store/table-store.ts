// SessionStore over a single-table key layout, shared by the file store and
// DynamoDB so both behave the same:
//   PK = SERIES#<id>
//   SK = CONFIG | SESSION#<startISO>#V#<collectedAt>
//      | AGENDA#<createdISO>#<uuid> | TAKEAWAY#<sessionStartISO>#<uuid>
//      | DEBRIEF#<sessionStartISO>#<journalId> | BRIEF#<sessionStartISO>
//   PK = CLAIMS, SK = CONV#<conversationId>: which session holds each Bee
//   conversation (see Claim).
//   PK = MARKERS, SK = M#<atISO>#<journalId>: Bee button start/end markers.
//   PK = JOURNALS, SK = J#<atISO>#<journalId>: what each voice note did.
// LATEST#SESSION items written by earlier versions are ignored.
import { createHash, randomUUID } from "node:crypto";
import { normalizeSeries, type Series } from "../series.js";
import type {
  AgendaItem,
  Claim,
  Debrief,
  FromBee,
  JournalRecord,
  Marker,
  PrepBrief,
  SessionInput,
  SessionRef,
  SessionStore,
  SessionVersion,
  Takeaway,
} from "./types.js";

export interface Item {
  PK: string;
  SK: string;
  [key: string]: unknown;
}

export type WriteOp = { put: Item } | { delete: { PK: string; SK: string } };

export interface Table {
  get(pk: string, sk: string): Promise<Item | undefined>;
  put(item: Item): Promise<void>;
  // All or nothing.
  transact(ops: WriteOp[]): Promise<void>;
  // Items under pk whose SK starts with prefix, sorted by SK.
  query(pk: string, prefix: string, opts?: { descending?: boolean; limit?: number }): Promise<Item[]>;
  // Every item with this exact SK, across partitions.
  scanSk(sk: string): Promise<Item[]>;
}

const pk = (seriesId: string) => `SERIES#${seriesId}`;
const CLAIMS = "CLAIMS";
const MARKERS = "MARKERS";
const JOURNALS = "JOURNALS";
const claimSk = (conversationId: number) => `CONV#${conversationId}`;
// Items that belong to one session and move with it.
const ATTACHED = ["TAKEAWAY#", "DEBRIEF#"];

export function contentHash(session: SessionInput): string {
  const h = createHash("sha256");
  for (const p of session.parts) h.update(`${p.id}\n${p.shortSummary}\n${p.summary}\n`);
  h.update(session.insights.map((i) => i.id).join(","));
  return h.digest("hex").slice(0, 32);
}

const strip = <T>({ PK, SK, ...rest }: Item) => rest as T;

// A transaction may touch each item once; the first op on an item wins.
function onePerItem(ops: WriteOp[]): WriteOp[] {
  const seen = new Set<string>();
  return ops.filter((op) => {
    const { PK, SK } = "put" in op ? op.put : op.delete;
    const key = `${PK}|${SK}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
const sameTag = (a: SessionInput["tag"], b: SessionInput["tag"]) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class TableStore implements SessionStore {
  constructor(private readonly table: Table) {}

  async putSessionVersion(seriesId: string, session: SessionInput, collectedAt = new Date().toISOString()) {
    return this.recordSession(seriesId, session, collectedAt);
  }

  async recordSession(seriesId: string, session: SessionInput, collectedAt: string, replaces: SessionRef[] = []) {
    const prefix = `SESSION#${session.start}#V#`;
    const existing = await this.table.query(pk(seriesId), prefix, { descending: true });
    const hash = contentHash(session);
    const current = existing[0] && strip<SessionVersion>(existing[0]);
    const ops: WriteOp[] = [];
    let version: SessionVersion;
    let written = false;
    if (current && current.hash === hash) {
      version = { ...current, versions: existing.length };
      // A new tag on the same content updates the latest version in place.
      if (!sameTag(current.tag, session.tag)) {
        version = { ...version, tag: session.tag };
        ops.push({ put: { ...existing[0], tag: session.tag } });
      }
    } else {
      version = { ...session, seriesId, hash, collectedAt, versions: existing.length + 1 };
      ops.push({ put: { PK: pk(seriesId), SK: `${prefix}${collectedAt}`, ...version } });
      written = true;
    }

    const status = session.tag?.status ?? "auto";
    const source = session.tag?.source ?? "schedule";
    const claimed = new Set(session.parts.map((p) => p.id));
    for (const id of claimed) {
      const claim: Claim = { conversationId: id, seriesId, sessionStart: session.start, source, status };
      ops.push({ put: { PK: CLAIMS, SK: claimSk(id), ...claim } });
    }

    for (const ref of replaces) {
      if (ref.seriesId === seriesId && ref.start === session.start) continue;
      ops.push(...(await this.moveOps(ref, { seriesId, start: session.start }, claimed)));
    }
    if (ops.length) await this.table.transact(onePerItem(ops));
    return { version, written };
  }

  // Deletes a session's versions and brief, moves its takeaways and debriefs
  // to `to`, and releases its conversation claims that `to` doesn't hold.
  private async moveOps(from: SessionRef, to: SessionRef, keep: Set<number>): Promise<WriteOp[]> {
    const ops: WriteOp[] = [];
    const versions = await this.table.query(pk(from.seriesId), `SESSION#${from.start}#V#`);
    for (const v of versions) {
      ops.push({ delete: { PK: v.PK, SK: v.SK } });
      for (const p of strip<SessionVersion>(v).parts) {
        if (!keep.has(p.id)) ops.push({ delete: { PK: CLAIMS, SK: claimSk(p.id) } });
      }
    }
    for (const kind of ATTACHED) {
      for (const item of await this.table.query(pk(from.seriesId), `${kind}${from.start}#`)) {
        const id = item.SK.slice(`${kind}${from.start}#`.length);
        ops.push({ delete: { PK: item.PK, SK: item.SK } });
        ops.push({
          put: { ...item, PK: pk(to.seriesId), SK: `${kind}${to.start}#${id}`, seriesId: to.seriesId, sessionStart: to.start },
        });
      }
    }
    ops.push({ delete: { PK: pk(from.seriesId), SK: `BRIEF#${from.start}` } });
    return ops;
  }

  async listClaims() {
    const items = await this.table.query(CLAIMS, "CONV#");
    return new Map(items.map((i) => [Number(i.conversationId), strip<Claim>(i)]));
  }

  async getLatestSession(seriesId: string) {
    const [item] = await this.table.query(pk(seriesId), "SESSION#", { descending: true, limit: 1 });
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

  async addAgendaItem(seriesId: string, text: string, from: FromBee = {}) {
    const item: AgendaItem = {
      id: randomUUID(),
      seriesId,
      text,
      createdAt: from.createdAt ?? this.stamp(),
      ...(from.source && { source: from.source }),
      ...(from.journalId && { journalId: from.journalId }),
    };
    await this.table.put({ PK: pk(seriesId), SK: `AGENDA#${item.createdAt}#${item.id}`, ...item });
    return item;
  }

  async listAgenda(seriesId: string) {
    return (await this.table.query(pk(seriesId), "AGENDA#")).map((i) => strip<AgendaItem>(i));
  }

  async removeAgendaItem(item: AgendaItem) {
    await this.table.transact([{ delete: { PK: pk(item.seriesId), SK: `AGENDA#${item.createdAt}#${item.id}` } }]);
  }

  async saveTakeaway(seriesId: string, sessionStart: string, text: string, from: FromBee = {}) {
    const item: Takeaway = {
      id: randomUUID(),
      seriesId,
      sessionStart,
      text,
      createdAt: from.createdAt ?? new Date().toISOString(),
      ...(from.source && { source: from.source }),
      ...(from.journalId && { journalId: from.journalId }),
    };
    await this.table.put({ PK: pk(seriesId), SK: `TAKEAWAY#${sessionStart}#${item.id}`, ...item });
    return item;
  }

  async listTakeaways(seriesId: string, sessionStart?: string) {
    const prefix = sessionStart ? `TAKEAWAY#${sessionStart}#` : "TAKEAWAY#";
    return (await this.table.query(pk(seriesId), prefix)).map((i) => strip<Takeaway>(i));
  }

  async saveDebrief(d: Debrief) {
    await this.table.put({ PK: pk(d.seriesId), SK: `DEBRIEF#${d.sessionStart}#${d.id}`, ...d });
  }

  async listDebriefs(seriesId: string, sessionStart: string) {
    return (await this.table.query(pk(seriesId), `DEBRIEF#${sessionStart}#`)).map((i) => strip<Debrief>(i));
  }

  async putMarker(m: Marker) {
    await this.table.put({ PK: MARKERS, SK: `M#${m.at}#${m.journalId}`, ...m });
  }

  async listMarkers() {
    return (await this.table.query(MARKERS, "M#")).map((i) => strip<Marker>(i));
  }

  async putJournalRecord(r: JournalRecord) {
    await this.table.put({ PK: JOURNALS, SK: `J#${r.at}#${r.journalId}`, ...r });
  }

  async listJournalRecords() {
    return (await this.table.query(JOURNALS, "J#")).map((i) => strip<JournalRecord>(i));
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
