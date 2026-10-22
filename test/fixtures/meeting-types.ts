// The four meeting types from the feature plan, all synthetic: weekly
// therapy, coaching one or two times a month (a Thursday test slot), an
// interview loop at two made-up companies with no schedule, and Other.
import { parseSeries, type Series } from "../../src/series.js";

export const [therapy, coaching, acme, globex, other] = parseSeries(
  JSON.stringify([
    {
      id: "therapy",
      name: "Weekly therapy",
      timezone: "America/New_York",
      weekday: 2,
      windowStart: "17:00",
      windowEnd: "18:00",
      // A reliable weekly slot: no keywords, so the slot alone files a session.
      spokenNames: ["therapy"],
    },
    {
      id: "coaching",
      name: "Coaching",
      timezone: "America/New_York",
      weekday: 4,
      windowStart: "16:00",
      windowEnd: "17:00",
      captureKeywords: ["coach"],
    },
    { id: "acme-interview", name: "Acme interview", timezone: "America/New_York", captureKeywords: ["acme"] },
    { id: "globex-interview", name: "Globex interview", timezone: "America/New_York", captureKeywords: ["globex"] },
    { id: "other", name: "Other", timezone: "America/New_York" },
  ]),
);

export const meetingTypes: Series[] = [therapy, coaching, acme, globex, other];

// A fixed "now": Thursday Oct 22, 2026, 10:00 in New York (EDT).
export const NOW = Date.parse("2026-10-22T10:00:00-04:00");
