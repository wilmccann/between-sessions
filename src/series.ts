// A Series is a recurring 1:1 (therapy, coaching, an interview loop) with a
// schedule rule that picks its sessions out of Bee conversations.
import { readFileSync } from "node:fs";
import { z } from "zod";

const SeriesSchema = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string(), // IANA, e.g. America/New_York
  weekday: z.number().int().min(0).max(6), // 0 = Sunday
  windowStart: z.string().regex(/^\d{2}:\d{2}$/), // when the session usually starts
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/), // and ends, local time
  minOverlapMinutes: z.number().int().positive().default(10), // per conversation
  minDurationMinutes: z.number().int().positive().default(30), // total overlap
  insightWindowHours: z.number().int().positive().default(72),
});

export type Series = z.infer<typeof SeriesSchema>;

// Your real schedule stays in a git-ignored file; the example is synthetic.
export function loadSeries(): Series[] {
  const candidates = [process.env.SERIES_FILE, "series.local.json", "series.example.json"];
  for (const path of candidates) {
    if (!path) continue;
    try {
      return z.array(SeriesSchema).parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw new Error("No series file found (series.local.json or series.example.json)");
}
