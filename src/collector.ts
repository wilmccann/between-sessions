// One collector run, shared by the local script and the Lambda: match every
// series against a Bee snapshot and store a new version of each session whose
// content changed. Only matched sessions reach the store.
import type { Series } from "./series.js";
import { matchSessions, sessionInput, type Snapshot } from "./sessions.js";
import type { SessionStore, SessionVersion } from "./store/types.js";

export interface RunResult {
  series: number;
  matched: number;
  written: SessionVersion[];
}

export async function recordSnapshot(store: SessionStore, series: Series[], snapshot: Snapshot): Promise<RunResult> {
  const result: RunResult = { series: series.length, matched: 0, written: [] };
  for (const s of series) {
    // Oldest first, so LATEST#SESSION ends on the newest session.
    const sessions = matchSessions(snapshot.conversations, s).reverse();
    result.matched += sessions.length;
    for (const session of sessions) {
      const { version, written } = await store.putSessionVersion(
        s.id,
        sessionInput(session, snapshot.insights, s),
        snapshot.collectedAt,
      );
      if (written) result.written.push(version);
    }
  }
  return result;
}
