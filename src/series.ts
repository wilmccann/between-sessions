// A Series is a recurring 1:1 (therapy, coaching, an interview loop). It may
// have a weekly schedule, which picks its sessions out of Bee conversations
// when you didn't mark them with the Bee button; without one, its sessions
// come from markers only.
import { readFileSync } from "node:fs";
import { z } from "zod";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

// The catch-all for sessions you marked without saying which series.
export const OTHER_ID = "other";

export const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE ?? "America/New_York";

const SeriesSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    timezone: z.string().default(DEFAULT_TIMEZONE), // IANA, e.g. America/New_York
    // The schedule: all three or none.
    weekday: z.number().int().min(0).max(6).optional(), // 0 = Sunday
    windowStart: hhmm.optional(), // when the session usually starts
    windowEnd: hhmm.optional(), // and ends, local time
    // Other names you might say for it ("coaching" for "Weekly coaching"),
    // and words in Bee's summaries that point at it.
    spokenNames: z.array(z.string()).default([]),
    captureKeywords: z.array(z.string()).default([]),
    minOverlapMinutes: z.number().int().positive().default(10), // per conversation
    minDurationMinutes: z.number().int().positive().default(30), // total overlap
    maxSessionMinutes: z.number().int().positive().default(120), // closes a start marker with no end
    insightWindowHours: z.number().int().positive().default(72),
  })
  .refine(
    (s) => [s.weekday, s.windowStart, s.windowEnd].every((v) => v === undefined) ||
      [s.weekday, s.windowStart, s.windowEnd].every((v) => v !== undefined),
    { message: "A schedule needs weekday, windowStart and windowEnd together" },
  );

export type Series = z.infer<typeof SeriesSchema>;
export type ScheduledSeries = Series & { weekday: number; windowStart: string; windowEnd: string };

export const hasSchedule = (s: Series): s is ScheduledSeries => s.weekday !== undefined;

export function parseSeries(raw: string): Series[] {
  return z.array(SeriesSchema).parse(JSON.parse(raw));
}

// Fills defaults on a series read back from the store, which may predate a field.
export const normalizeSeries = (raw: unknown): Series => SeriesSchema.parse(raw);

// Your real schedule stays in a git-ignored file; the example is synthetic.
export function loadSeries(): Series[] {
  const candidates = [process.env.SERIES_FILE, "series.local.json", "series.example.json"];
  for (const path of candidates) {
    if (!path) continue;
    try {
      return parseSeries(readFileSync(path, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw new Error("No series file found (series.local.json or series.example.json)");
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "series";

// A series created by voice ("Start session: Acme interview"): no schedule.
export function newSeries(name: string, existing: Series[], timezone = defaultTimezone(existing)): Series {
  const base = slug(name);
  let id = base;
  for (let n = 2; existing.some((s) => s.id === id); n++) id = `${base}-${n}`;
  return SeriesSchema.parse({ id, name: name.trim(), timezone });
}

export const otherSeries = (existing: Series[]): Series =>
  SeriesSchema.parse({ id: OTHER_ID, name: "Other", timezone: defaultTimezone(existing) });

// New series take the timezone your existing ones use.
export function defaultTimezone(existing: Series[]): string {
  return existing.find((s) => s.id !== OTHER_ID)?.timezone ?? DEFAULT_TIMEZONE;
}

// --- Fuzzy names -----------------------------------------------------------
// Spoken names come through transcription, so "Akme" should find "Acme".

const FILLER = new Set(["session", "sessions", "my", "the", "a", "an", "for", "with", "to", "of", "our"]);

export const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (s: string) => normalizeName(s).split(" ").filter((t) => t && !FILLER.has(t));

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

const allowedEdits = (len: number) => (len <= 3 ? 0 : len <= 6 ? 1 : 2);

// Plural and singular are the same word ("interviews", "interview").
const sameWord = (a: string, b: string) => {
  const x = a.replace(/s$/, "");
  const y = b.replace(/s$/, "");
  return editDistance(x, y) <= allowedEdits(Math.min(x.length, y.length));
};

const namesOf = (s: Series) => [s.name, s.id.replace(/-/g, " "), ...s.spokenNames];

// How well a spoken name fits a series, 0 to 1.
function fit(wanted: string, s: Series): number {
  const want = tokens(wanted);
  if (!want.length) return 0;
  let best = 0;
  for (const name of namesOf(s)) {
    if (normalizeName(name) === normalizeName(wanted)) return 1;
    const have = tokens(name);
    const matched = want.filter((w) => have.some((h) => sameWord(w, h))).length;
    best = Math.max(best, matched / want.length);
  }
  return best;
}

export type NameMatch =
  | { kind: "match"; series: Series }
  | { kind: "ambiguous"; candidates: Series[] }
  | { kind: "none" };

// Picks the series a spoken or typed name means. Exact ids and names win;
// otherwise the series whose words best match, if more than half the words
// match ("Initech interview" isn't "Acme interview") and no other series
// fits as well.
export function matchSeriesName(all: Series[], wanted: string): NameMatch {
  const exact = all.find((s) => s.id === wanted || namesOf(s).some((n) => normalizeName(n) === normalizeName(wanted)));
  if (exact) return { kind: "match", series: exact };
  const scored = all.map((series) => ({ series, score: fit(wanted, series) })).filter((x) => x.score > 0.5);
  if (!scored.length) return { kind: "none" };
  const top = Math.max(...scored.map((x) => x.score));
  const best = scored.filter((x) => x.score === top).map((x) => x.series);
  return best.length === 1 ? { kind: "match", series: best[0] } : { kind: "ambiguous", candidates: best };
}
