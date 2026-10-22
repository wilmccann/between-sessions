// Which series a request means when it names none, shared by the MCP tools
// and the Bee button: a named one (fuzzy-matched), the only one, the most
// recently ended session's ("recent": looking back, takeaways, debriefs), or
// the next scheduled one's ("next": prep, agenda). `why` says which rule
// picked it, so answers can say which series was used; it's null when the
// user named it or there's only one. `ask` is the question to ask instead.
import { matchSeriesName, OTHER_ID, type Series } from "./series.js";
import type { SessionStore } from "./store/types.js";
import { formatShort, nextSession } from "./time.js";

export type Purpose = "recent" | "next";
export type Choice = { series: Series; why: string | null; ask?: undefined } | { series?: undefined; ask: string };

const names = (all: Series[]) => all.map((s) => s.name).join(", ");

export async function choose(
  store: SessionStore,
  wanted: string | undefined,
  purpose: Purpose,
  now = Date.now(),
  all?: Series[],
): Promise<Choice> {
  all ??= await store.listSeries();
  if (!all.length) return { ask: "No series is set up yet." };
  if (wanted) {
    const m = matchSeriesName(all, wanted);
    if (m.kind === "match") return { series: m.series, why: null };
    if (m.kind === "ambiguous") return { ask: `Did you mean ${m.candidates.map((s) => s.name).join(" or ")}?` };
    return { ask: `I don't know a series called ${wanted}. Your series: ${names(all)}.` };
  }
  if (all.length === 1) return { series: all[0], why: null };
  const real = all.filter((s) => s.id !== OTHER_ID);
  if (purpose === "next" && real.length === 1) return { series: real[0], why: null };

  if (purpose === "next") {
    const upcoming = real
      .map((series) => ({ series, next: nextSession(series, now) }))
      .filter((x) => x.next)
      .sort((a, b) => a.next!.start - b.next!.start)[0];
    if (upcoming) {
      const when = formatShort(upcoming.next!.start, upcoming.series.timezone);
      return { series: upcoming.series, why: `Using ${upcoming.series.name}, your next scheduled session (${when}).` };
    }
  }
  const pool = purpose === "next" ? real : all;
  const latest = (await Promise.all(pool.map(async (series) => ({ series, last: await store.getLatestSession(series.id) }))))
    .filter((x) => x.last && Date.parse(x.last.start) <= now)
    .sort((a, b) => Date.parse(b.last!.end) - Date.parse(a.last!.end))[0];
  if (latest) return { series: latest.series, why: `Using ${latest.series.name}, your most recent session.` };
  if (real.length === 1) return { series: real[0], why: null };
  return { ask: `Which series? Your series: ${names(all)}.` };
}
