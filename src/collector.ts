// One collector run, shared by the local script and the Lambda: read new Bee
// button notes, find every series' sessions in a Bee snapshot (markers
// first, the schedule window as the fallback), place each Bee conversation
// in at most one session (see detect.ts), store a new version of each
// session whose content or tag changed, then file the notes that need a
// session. Only placed sessions reach the store.
import { emptyCounts, fileNotes, readJournals, type ButtonCounts } from "./button.js";
import { claimCandidates, keywordCandidates, placeSessions, windowCandidates, type Candidate } from "./detect.js";
import { computeDigest, topicWords, updateTallies } from "./digest.js";
import { markerCandidates } from "./markers.js";
import { OTHER_ID, otherSeries, type Series } from "./series.js";
import { sessionInput, type Snapshot } from "./sessions.js";
import { reviewItemFrom } from "./review.js";
import type { ReviewItem, SessionStore, SessionVersion } from "./store/types.js";
import { DAY } from "./time.js";

// Bee keeps 14 days of history; older markers would rebuild sessions from
// conversations Bee no longer returns.
const MARKER_DAYS = 13;

export interface RunResult {
  series: number;
  matched: number;
  replaced: number;
  written: SessionVersion[];
  button: ButtonCounts;
  digests: number;
  review: number;
}

export async function recordSnapshot(store: SessionStore, seriesIn: Series[], snapshot: Snapshot): Promise<RunResult> {
  const now = Date.parse(snapshot.collectedAt);
  const series = [...seriesIn];
  const button = emptyCounts();
  const deferred = await readJournals(store, series, snapshot.journals ?? [], button);

  const markers = (await store.listMarkers()).filter((m) => Date.parse(m.at) >= now - MARKER_DAYS * DAY);
  const marked = markerCandidates(markers, snapshot.conversations, series).filter(
    // A marked session with no conversations yet is kept for a day, so a
    // debrief has somewhere to go; after that Bee had its chance.
    (c) => c.session.parts.length || now - c.session.end < DAY,
  );
  if (marked.some((c) => c.seriesId === OTHER_ID) && !series.some((s) => s.id === OTHER_ID)) {
    const other = otherSeries(series);
    await store.putSeries(other);
    series.push(other);
  }
  const claims = await store.listClaims();
  const candidates: Candidate[] = [
    ...claimCandidates(snapshot.conversations, claims).filter((c) => series.some((s) => s.id === c.seriesId)),
    ...marked,
    ...series.flatMap((s) => [...windowCandidates(snapshot.conversations, s), ...keywordCandidates(snapshot.conversations, s)]),
  ];
  const placed = placeSessions(candidates, claims);

  const result: RunResult = {
    series: series.length,
    matched: 0,
    replaced: 0,
    written: [],
    button,
    digests: 0,
    review: 0,
  };
  const byId = new Map(series.map((s) => [s.id, s]));
  const review: ReviewItem[] = [];
  for (const { candidate, replaces } of placed) {
    const s = byId.get(candidate.seriesId)!;
    // An unsure guess from the schedule or a keyword isn't filed until you
    // confirm it, unless it was stored before review existed.
    if (candidate.tag.status === "pending" && candidate.tag.source !== "marker") {
      const ref = { seriesId: s.id, start: new Date(candidate.session.start).toISOString() };
      if (!(await store.hasSession(ref))) {
        review.push(reviewItemFrom(candidate, false));
        continue;
      }
      candidate.tag = { ...candidate.tag, status: "auto" };
    }
    if (candidate.tag.status === "pending") review.push(reviewItemFrom(candidate, true));
    result.matched++;
    const { version, written } = await store.recordSession(
      s.id,
      sessionInput(candidate.session, snapshot.insights, s, candidate.tag),
      snapshot.collectedAt,
      replaces,
    );
    result.replaced += replaces.length;
    if (written) result.written.push(version);
  }

  // The queue is rebuilt each run: guesses that were placed elsewhere or
  // aged out of Bee's history disappear.
  const key = (r: ReviewItem) => `${r.seriesId}|${r.start}`;
  const fresh = new Set(review.map(key));
  for (const old of await store.listReviewItems()) if (!fresh.has(key(old))) await store.deleteReviewItem(old);
  for (const item of review) await store.putReviewItem(item);
  result.review = review.length;

  await fileNotes(store, series, deferred, markers, now, button);
  result.digests = await recordDigests(store, series, snapshot);
  return result;
}

// Running day tallies, then one digest per series (none for Other).
async function recordDigests(store: SessionStore, series: Series[], snapshot: Snapshot): Promise<number> {
  const withDigest = series.filter((s) => s.id !== OTHER_ID);
  const lasts = await Promise.all(withDigest.map((s) => store.getLatestSession(s.id)));
  const topics = withDigest.map((s, i) => topicWords(lasts[i], s));
  const tallies = await store.listTallies();
  await store.putTallies(updateTallies(tallies, snapshot, [...new Set(topics.flat())]));
  for (const [i, s] of withDigest.entries()) {
    await store.putDigest(computeDigest(s, lasts[i], tallies, snapshot, topics[i]));
  }
  return withDigest.length;
}
