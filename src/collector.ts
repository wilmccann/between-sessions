// One collector run, shared by the local script and the Lambda: find every
// series' sessions in a Bee snapshot, place each Bee conversation in at most
// one session (see detect.ts), and store a new version of each session whose
// content or tag changed. Only placed sessions reach the store.
import { placeSessions, windowCandidates, type Candidate } from "./detect.js";
import type { Series } from "./series.js";
import { sessionInput, type Snapshot } from "./sessions.js";
import type { SessionStore, SessionVersion } from "./store/types.js";

export interface RunResult {
  series: number;
  matched: number;
  replaced: number;
  written: SessionVersion[];
}

export async function recordSnapshot(store: SessionStore, series: Series[], snapshot: Snapshot): Promise<RunResult> {
  const result: RunResult = { series: series.length, matched: 0, replaced: 0, written: [] };
  const byId = new Map(series.map((s) => [s.id, s]));
  const candidates: Candidate[] = series.flatMap((s) => windowCandidates(snapshot.conversations, s));
  const placed = placeSessions(candidates, await store.listClaims());
  result.matched = placed.length;
  for (const { candidate, replaces } of placed) {
    const s = byId.get(candidate.seriesId)!;
    const { version, written } = await store.recordSession(
      s.id,
      sessionInput(candidate.session, snapshot.insights, s, candidate.tag),
      snapshot.collectedAt,
      replaces,
    );
    result.replaced += replaces.length;
    if (written) result.written.push(version);
  }
  return result;
}
