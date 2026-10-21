// After a collector run: write a Bedrock note and prep brief for each series
// whose latest session just got a new version. Failures are counted, not
// thrown, so a Bedrock problem never loses the collected sessions.
import { openAgenda } from "../store/agenda.js";
import type { SessionStore, SessionVersion } from "../store/types.js";
import { writeNotes } from "./bedrock.js";

export async function writeBriefs(
  store: SessionStore,
  written: SessionVersion[],
  notes: typeof writeNotes = writeNotes,
): Promise<{ briefs: number; failed: number }> {
  let briefs = 0;
  let failed = 0;
  for (const v of written) {
    const latest = await store.getLatestSession(v.seriesId);
    if (latest?.start !== v.start || latest.hash !== v.hash) continue;
    try {
      const [agenda, takeaways] = await Promise.all([
        store.listAgenda(v.seriesId),
        store.listTakeaways(v.seriesId, v.start),
      ]);
      const result = await notes({
        session: v,
        agenda: openAgenda(agenda, v).map((a) => a.text),
        takeaways: takeaways.map((t) => t.text),
      });
      await store.putPrepBrief({
        seriesId: v.seriesId,
        sessionStart: v.start,
        note: result.note,
        bullets: result.bullets,
        relevantInsightIds: result.relevantInsightIds,
        model: result.model,
        generatedAt: new Date().toISOString(),
      });
      briefs++;
    } catch (err) {
      failed++;
      console.error(`brief failed for ${v.seriesId} ${v.start}: ${(err as Error).name}`);
    }
  }
  return { briefs, failed };
}
