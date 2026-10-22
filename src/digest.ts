// The "since last session" digest, computed by the collector (never in the
// tool path). Bee only returns 14 days of history, so the collector keeps
// running day tallies (conversation ids and times, todo ids and times, and
// which conversations mention each topic word) and counts from those.
// Topics are words from the last session's summaries plus the series'
// captureKeywords; Bee's summaries, not transcripts, are matched, like Bee's
// own search. Off for the Other series.
import type { BeeConversation } from "./bee/cli.js";
import type { Series } from "./series.js";
import type { Snapshot } from "./sessions.js";
import type { DayTally, Digest, SessionInput, SessionVersion } from "./store/types.js";

const STOPWORDS = new Set(
  (
    "about above after again against also although among another anyone anything around because been before being " +
    "below between both cannot could during each either else enough even ever every first from further getting given " +
    "going have having here however into itself just last later least less like made make making many maybe might more " +
    "most much must myself need needs never next none nothing often once only other others otherwise over perhaps " +
    "quite rather really said same says several shall should since some someone something sometimes still such than " +
    "that their them themselves then there these they thing things this those though through throughout today together " +
    "toward towards under until upon very want wanted wants well were what whatever when where whether which while " +
    "whole whom whose will with within without would your yours user users speaker speakers discussed discussing " +
    "discussion conversation conversations talked talking mentioned mentions shared sharing explained described noted " +
    "agreed asked including regarding various people person overall general specific different important potential " +
    "possible currently recent recently week weeks time times plan plans plus able also back came come comes coming " +
    "felt feel feeling feelings session sessions summary brief briefly includes included later another next thought " +
    "think thinking talk tell told work working"
  ).split(" "),
);

const word = (w: string) => w.toLowerCase().replace(/[^a-z0-9-]/g, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function mentions(text: string, topic: string): boolean {
  return new RegExp(`\\b${escape(topic)}(s|es)?\\b`, "i").test(text);
}

// Up to `max` words that recur in the last session's summaries, plus the
// series' captureKeywords.
export function topicWords(session: SessionInput | null, series: Series, max = 5): string[] {
  const counts = new Map<string, number>();
  if (session) {
    const text = session.parts.map((p) => `${p.shortSummary} ${p.summary}`).join(" ");
    for (const raw of text.split(/\s+/)) {
      const w = word(raw).replace(/s$/, "");
      if (w.length < 4 || STOPWORDS.has(w) || STOPWORDS.has(`${w}s`) || /^\d/.test(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const fromSession = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
  return [...new Set([...series.captureKeywords.map((k) => k.toLowerCase()), ...fromSession])];
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Folds a snapshot into the tallies (in place) and returns the days that changed.
export function updateTallies(tallies: DayTally[], snapshot: Snapshot, topics: string[]): DayTally[] {
  const byDay = new Map(tallies.map((t) => [t.date, t]));
  const changed = new Set<DayTally>();
  const day = (ms: number) => {
    const date = dayOf(ms);
    let t = byDay.get(date);
    if (!t) {
      t = { date, conversations: [], todos: [], topicHits: {} };
      byDay.set(date, t);
      tallies.push(t);
    }
    return t;
  };
  const text = (c: BeeConversation) => `${c.short_summary ?? ""} ${c.summary ?? ""}`;
  for (const c of snapshot.conversations) {
    const t = day(c.start_time);
    if (!t.conversations.some((x) => x.id === c.id)) {
      t.conversations.push({ id: c.id, start: c.start_time });
      changed.add(t);
    }
    for (const topic of topics) {
      if (!mentions(text(c), topic)) continue;
      const hits = (t.topicHits[topic] ??= []);
      if (!hits.includes(c.id)) {
        hits.push(c.id);
        changed.add(t);
      }
    }
  }
  for (const todo of snapshot.todos ?? []) {
    const t = day(todo.created_at);
    if (!t.todos.some((x) => x.id === todo.id)) {
      t.todos.push({ id: todo.id, createdAt: todo.created_at });
      changed.add(t);
    }
  }
  tallies.sort((a, b) => a.date.localeCompare(b.date));
  return [...changed];
}

export function computeDigest(
  series: Series,
  last: SessionVersion | null,
  tallies: DayTally[],
  snapshot: Snapshot,
  topics: string[],
): Digest {
  const base = { seriesId: series.id, computedAt: snapshot.collectedAt };
  if (!last) return { ...base, since: null, conversations: 0, todos: 0, insightTitles: [], topics: [], partial: false };
  const since = Date.parse(last.end);
  const own = new Set(last.parts.map((p) => p.id));
  const after = new Set<number>();
  let todos = 0;
  const hits = new Map<string, Set<number>>();
  for (const t of tallies) {
    for (const c of t.conversations) if (c.start > since && !own.has(c.id)) after.add(c.id);
    for (const todo of t.todos) if (todo.createdAt > since) todos++;
    for (const [w, ids] of Object.entries(t.topicHits)) {
      const set = hits.get(w) ?? new Set<number>();
      for (const id of ids) set.add(id);
      hits.set(w, set);
    }
  }
  const counted = topics
    .map((w) => ({ word: w, count: [...(hits.get(w) ?? [])].filter((id) => after.has(id)).length }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);
  const sessionInsights = new Set(last.insights.map((i) => i.id));
  const insightTitles = snapshot.insights
    .filter((i) => i.generated_at > since && !sessionInsights.has(i.id))
    .sort((a, b) => b.generated_at - a.generated_at)
    .slice(0, 5)
    .map((i) => i.title);
  const coverage = tallies.length ? Date.parse(`${tallies[0].date}T00:00:00Z`) : Infinity;
  return {
    ...base,
    since: last.end,
    conversations: after.size,
    todos,
    insightTitles,
    topics: counted,
    partial: since < coverage,
  };
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// One short paragraph, safe to read aloud: counts, topic words and insight titles.
export function digestSentence(d: Digest, now = Date.now()): string {
  if (!d.since) return "There's no session recorded yet, so there's nothing to count from.";
  const hours = Math.max(0, Math.floor((now - Date.parse(d.since)) / 3_600_000));
  const gap = hours < 24 ? plural(hours, "hour") : plural(Math.floor(hours / 24), "day");
  const out = [`It's been ${gap} and ${plural(d.conversations, "conversation")}${d.partial ? " or more" : ""}.`];
  if (d.topics.length) {
    const list = d.topics.slice(0, 3).map((t) => `${t.word} (${times(t.count)})`);
    const joined = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0];
    out.push(`From last session, ${joined} came up again.`);
  }
  if (d.insightTitles.length) out.push(`Bee noticed: ${d.insightTitles[0]}.`);
  if (d.todos) out.push(`You added ${plural(d.todos, "todo")}.`);
  return out.join(" ");
}
