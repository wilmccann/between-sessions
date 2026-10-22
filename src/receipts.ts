// The Bee button gives no feedback of its own, so every touchpoint (the
// brief, the digest, the Alexa greeting) opens with what was filed lately:
// "Got it: session ended Thu 4:32 PM, debrief saved, 1 agenda item added.
// 1 voice note I couldn't file." Counts and times only, no note text.
import { DEFAULT_TIMEZONE, type Series } from "./series.js";
import type { JournalRecord } from "./store/types.js";
import { formatShort, HOUR } from "./time.js";

export const RECEIPT_WINDOW = 48 * HOUR;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buttonReceipt(records: JournalRecord[], series: Series[], now = Date.now()): string | null {
  const recent = records
    .filter((r) => r.status !== "ignored" && now - Date.parse(r.at) <= RECEIPT_WINDOW && Date.parse(r.at) <= now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!recent.length) return null;
  const byId = new Map(series.map((s) => [s.id, s]));
  const zone = (r: JournalRecord) => byId.get(r.seriesId ?? "")?.timezone ?? series[0]?.timezone ?? DEFAULT_TIMEZONE;
  const name = (r: JournalRecord) => (r.seriesId && byId.get(r.seriesId) ? ` (${byId.get(r.seriesId)!.name})` : "");
  const filed = recent.filter((r) => r.status === "filed");
  const count = (kind: string) => filed.filter((r) => r.kind === kind).length;

  const parts: string[] = [];
  for (const r of filed) {
    if (r.kind === "start") parts.push(`session started ${formatShort(Date.parse(r.at), zone(r))}${name(r)}`);
    if (r.kind === "end") parts.push(`session ended ${formatShort(Date.parse(r.at), zone(r))}${name(r)}`);
  }
  if (count("debrief")) parts.push(count("debrief") === 1 ? "debrief saved" : `${count("debrief")} debriefs saved`);
  if (count("agenda")) parts.push(`${plural(count("agenda"), "agenda item")} added`);
  if (count("drop")) parts.push(`${plural(count("drop"), "agenda item")} removed`);
  if (count("takeaway")) parts.push(count("takeaway") === 1 ? "takeaway saved" : `${count("takeaway")} takeaways saved`);
  for (const kind of ["retag", "not-session"]) {
    if (count(kind)) parts.push(kind === "retag" ? `${plural(count(kind), "session")} retagged` : `${plural(count(kind), "session")} dropped`);
  }
  const unfiled = recent.filter((r) => r.status === "unfiled").length;
  const sentences = [];
  if (parts.length) sentences.push(`Got it: ${parts.join(", ")}.`);
  if (unfiled) sentences.push(`${plural(unfiled, "voice note")} I couldn't file.`);
  return sentences.join(" ");
}
