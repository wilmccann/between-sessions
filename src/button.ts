// The Bee button: every READY voice note (journal) is read once. Markers
// are stored before sessions are placed; debriefs, agenda items, takeaways
// and removals are filed after, so they can land on the session that just
// ended. Only the words after a recognized command are stored; for any other
// note, only its id. Logs and results hold counts only.
import type { BeeJournal } from "./bee/cli.js";
import { choose } from "./choose.js";
import { parseCommand, type Command } from "./commands.js";
import { matchSeriesName, newSeries, normalizeName, type Series } from "./series.js";
import { latestTarget, retag } from "./review.js";
import { openAgenda } from "./store/agenda.js";
import type { JournalRecord, Marker, SessionStore, SessionVersion } from "./store/types.js";
import { HOUR, MINUTE } from "./time.js";

// A debrief or takeaway this soon after a session ends belongs to it.
export const JUST_ENDED = 3 * HOUR;
// How long a note waits for its session to show up before falling back.
export const WAIT_FOR_SESSION = 6 * HOUR;

export interface Deferred {
  journal: BeeJournal;
  command: Exclude<Command, { kind: "start" | "end" | "unfiled" }>;
}

export interface ButtonCounts {
  notes: number; // new READY notes read this run
  markers: number;
  filed: number;
  unfiled: number;
  ignored: number;
  waiting: number;
  seriesCreated: number;
}

export const emptyCounts = (): ButtonCounts => ({
  notes: 0,
  markers: 0,
  filed: 0,
  unfiled: 0,
  ignored: 0,
  waiting: 0,
  seriesCreated: 0,
});

const iso = (ms: number) => new Date(ms).toISOString();

// Step 1: new notes. Stores markers (creating a series for a new spoken
// name) and records ignored and unfiled notes; returns the rest for step 2.
// `series` gains any series created.
export async function readJournals(
  store: SessionStore,
  series: Series[],
  journals: BeeJournal[],
  counts: ButtonCounts,
): Promise<Deferred[]> {
  const seen = new Set((await store.listJournalRecords()).map((r) => r.journalId));
  const fresh = journals.filter((j) => j.state === "READY" && !seen.has(j.id)).sort((a, b) => a.created_at - b.created_at);
  const deferred: Deferred[] = [];
  for (const journal of fresh) {
    counts.notes++;
    const at = iso(journal.created_at);
    const command = parseCommand(journal.text ?? "", series);
    const record = (r: Omit<JournalRecord, "journalId" | "at">) => store.putJournalRecord({ journalId: journal.id, at, ...r });
    if (!command) {
      counts.ignored++;
      await record({ kind: "note", status: "ignored" });
    } else if (command.kind === "unfiled") {
      counts.unfiled++;
      await record({ kind: "unfiled", status: "unfiled", reason: command.reason });
    } else if (command.kind === "start" || command.kind === "end") {
      const marker: Marker = { journalId: journal.id, kind: command.kind, at };
      if (command.series) {
        const m = matchSeriesName(series, command.series);
        if (m.kind === "match") marker.seriesId = m.series.id;
        else if (m.kind === "ambiguous") marker.unclear = true;
        else {
          const created = newSeries(titleCase(command.series), series);
          await store.putSeries(created);
          series.push(created);
          counts.seriesCreated++;
          marker.seriesId = created.id;
        }
      }
      await store.putMarker(marker);
      counts.markers++;
      await record({ kind: command.kind, status: "filed", ...(marker.seriesId && { seriesId: marker.seriesId }) });
    } else {
      deferred.push({ journal, command: command as Deferred["command"] });
    }
  }
  return deferred;
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

interface Located {
  series: Series;
  session: SessionVersion;
}

async function recentSessions(store: SessionStore, series: Series[]): Promise<Located[]> {
  const lists = await Promise.all(
    series.map(async (s) => (await store.listSessions(s.id, 5)).map((session) => ({ series: s, session }))),
  );
  return lists.flat();
}

// Step 2: debriefs, agenda items, takeaways and removals.
export async function fileNotes(
  store: SessionStore,
  series: Series[],
  deferred: Deferred[],
  markers: Marker[],
  now: number,
  counts: ButtonCounts,
): Promise<void> {
  if (!deferred.length) return;
  const sessions = await recentSessions(store, series);
  for (const { journal, command } of deferred) {
    const at = journal.created_at;
    const record = (r: Omit<JournalRecord, "journalId" | "at">) => {
      if (r.status === "filed") counts.filed++;
      else counts.unfiled++;
      return store.putJournalRecord({ journalId: journal.id, at: iso(at), ...r });
    };
    const fail = (reason: string) => record({ kind: command.kind, status: "unfiled", reason });

    // The session that just ended before this note, if any.
    const justEnded = sessions
      .filter(({ session }) => Date.parse(session.end) <= at + 5 * MINUTE && Date.parse(session.end) >= at - JUST_ENDED)
      .sort((a, b) => Date.parse(b.session.end) - Date.parse(a.session.end))[0];
    // An end marker just before the note whose session isn't stored yet
    // (Bee hasn't finished the conversation): wait a while for it.
    const endPending = markers.some((m) => m.kind === "end" && Date.parse(m.at) <= at && Date.parse(m.at) >= at - JUST_ENDED);
    const shouldWait = !justEnded && endPending && now - at < WAIT_FOR_SESSION;
    const latestBefore = (pool: Located[]) =>
      pool.filter(({ session }) => Date.parse(session.start) <= at).sort((a, b) => Date.parse(b.session.end) - Date.parse(a.session.end))[0];

    switch (command.kind) {
      case "debrief": {
        if (shouldWait) {
          counts.waiting++;
          continue;
        }
        const target = justEnded ?? latestBefore(sessions);
        if (!target) {
          await fail("no session to attach the debrief to");
          continue;
        }
        await store.saveDebrief({
          id: journal.id,
          seriesId: target.series.id,
          sessionStart: target.session.start,
          text: command.text,
          createdAt: iso(at),
        });
        await record({ kind: "debrief", status: "filed", seriesId: target.series.id });
        break;
      }
      case "takeaway": {
        let target: Located | undefined;
        if (command.series) {
          const c = await choose(store, command.series, "recent", at, series);
          if (!c.series) {
            await fail(c.ask);
            continue;
          }
          target = latestBefore(sessions.filter((x) => x.series.id === c.series.id));
        } else {
          if (shouldWait) {
            counts.waiting++;
            continue;
          }
          target = justEnded ?? latestBefore(sessions);
        }
        if (!target) {
          await fail("no session to save the takeaway on");
          continue;
        }
        await store.saveTakeaway(target.series.id, target.session.start, command.text, {
          source: "bee",
          journalId: journal.id,
          createdAt: iso(at),
        });
        await record({ kind: "takeaway", status: "filed", seriesId: target.series.id });
        break;
      }
      case "agenda":
      case "drop": {
        const c = await choose(store, command.series, "next", at, series);
        if (!c.series) {
          await fail(c.ask);
          continue;
        }
        if (command.kind === "agenda") {
          await store.addAgendaItem(c.series.id, command.text, { source: "bee", journalId: journal.id, createdAt: iso(at) });
          await record({ kind: "agenda", status: "filed", seriesId: c.series.id });
          break;
        }
        const open = openAgenda(await store.listAgenda(c.series.id), await store.getLatestSession(c.series.id));
        const item = bestAgendaMatch(open, command.text);
        if (!item) {
          await fail("no matching agenda item");
          continue;
        }
        await store.removeAgendaItem(item);
        await record({ kind: "drop", status: "filed", seriesId: c.series.id });
        break;
      }
      case "retag":
      case "not-session": {
        // "Retag: coaching", "That was Acme", "Not a session": about the
        // session (or guess) that just happened.
        const target = await latestTarget(store, series, at + 5 * MINUTE);
        if (!target) {
          await fail("no session to retag");
          continue;
        }
        if (command.kind === "not-session") {
          await retag(store, target, "not-session", series);
          await record({ kind: "not-session", status: "filed" });
          break;
        }
        const c = await choose(store, command.series, "recent", at, series);
        if (!c.series) {
          await fail(c.ask);
          continue;
        }
        await retag(store, target, c.series, series);
        await record({ kind: "retag", status: "filed", seriesId: c.series.id });
        break;
      }
    }
  }
}

// The open item a spoken description means: containment either way, or
// most of the words in common.
export function bestAgendaMatch<T extends { text: string }>(items: T[], wanted: string): T | undefined {
  const w = normalizeName(wanted).replace(/^(the|my|a|an) /, "");
  const wTokens = new Set(w.split(" ").filter((t) => t.length > 2));
  let best: { item: T; score: number } | undefined;
  for (const item of items) {
    const t = normalizeName(item.text).replace(/^(the|my|a|an) /, "");
    let score = t === w ? 3 : t.includes(w) || w.includes(t) ? 2 : 0;
    if (!score && wTokens.size) {
      const tTokens = t.split(" ");
      const common = [...wTokens].filter((x) => tTokens.includes(x)).length;
      if (common / wTokens.size >= 0.5) score = common / wTokens.size;
    }
    if (score && (!best || score > best.score)) best = { item, score };
  }
  return best?.item;
}
