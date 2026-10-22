// Review: guesses you confirm or correct. A retag moves the session (its
// versions, takeaways and debriefs) in one transaction; "not a session"
// deletes it, keeps your takeaways and debriefs on the session before, and
// remembers its Bee ids so they're never suggested again. Every change is
// read back, including what happened to the agenda.
import type { Candidate } from "./detect.js";
import type { Series } from "./series.js";
import { openAgenda } from "./store/agenda.js";
import type { ReviewItem, SessionRef, SessionStore, SessionTag } from "./store/types.js";
import { DAY, formatShort } from "./time.js";

export const CONFIRMED_TAG: SessionTag = { source: "you", confidence: "certain", status: "confirmed", reason: "You confirmed it" };
// Bee keeps 14 days of history.
export const DROP_DAYS = 14;

const iso = (ms: number) => new Date(ms).toISOString();

export function reviewItemFrom(c: Candidate, filed: boolean): ReviewItem {
  const first = c.session.parts[0]?.start_time ?? c.session.start;
  return {
    seriesId: c.seriesId,
    start: iso(c.session.start),
    end: iso(c.session.end),
    conversationIds: c.session.parts.map((p) => p.id),
    source: c.tag.source,
    reason: c.tag.reason,
    filed,
    dropsAt: iso(first + DROP_DAYS * DAY),
  };
}

export const refId = (r: SessionRef) => `${r.seriesId}@${r.start}`;
export function parseRefId(id: string): SessionRef | null {
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  const start = id.slice(at + 1);
  return Number.isNaN(Date.parse(start)) ? null : { seriesId: id.slice(0, at), start };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// "1 session to review; the oldest expires in 3 days." The deadline shows
// only when it's close.
export function reviewLine(items: ReviewItem[], now = Date.now()): string | null {
  if (!items.length) return null;
  const oldest = Math.min(...items.map((i) => Date.parse(i.dropsAt)));
  const days = Math.max(0, Math.ceil((oldest - now) / DAY));
  const deadline = days <= 5 ? `; the oldest expires in ${plural(days, "day")}` : "";
  return `${plural(items.length, "session")} to review${deadline}.`;
}

export type Target = { kind: "item"; item: ReviewItem } | { kind: "session"; ref: SessionRef; end: string };

// The most recent filed session or waiting guess that started by `at`.
export async function latestTarget(store: SessionStore, series: Series[], at: number): Promise<Target | null> {
  const options: { target: Target; end: number }[] = [];
  for (const s of series) {
    const [v] = (await store.listSessions(s.id, 5)).filter((x) => Date.parse(x.start) <= at);
    if (v) options.push({ target: { kind: "session", ref: { seriesId: s.id, start: v.start }, end: v.end }, end: Date.parse(v.end) });
  }
  for (const item of await store.listReviewItems()) {
    if (!item.filed && Date.parse(item.start) <= at) options.push({ target: { kind: "item", item }, end: Date.parse(item.end) });
  }
  return options.sort((a, b) => b.end - a.end)[0]?.target ?? null;
}

export async function findTarget(store: SessionStore, id: string, series: Series[], now = Date.now()): Promise<Target | null> {
  if (id.trim().toLowerCase() === "last") return latestTarget(store, series, now);
  const ref = parseRefId(id.trim());
  if (!ref) return null;
  const item = (await store.listReviewItems()).find((i) => i.seriesId === ref.seriesId && i.start === ref.start);
  if (item && !item.filed) return { kind: "item", item };
  const [v] = (await store.listSessions(ref.seriesId, 50)).filter((x) => x.start === ref.start);
  return v ? { kind: "session", ref, end: v.end } : null;
}

async function openCount(store: SessionStore, seriesId: string) {
  return openAgenda(await store.listAgenda(seriesId), await store.getLatestSession(seriesId)).length;
}

function agendaEffect(name: string, before: number, after: number): string {
  if (after > before) return ` ${plural(after - before, "agenda item")} reopened on ${name}.`;
  if (after < before) return ` ${plural(before - after, "agenda item")} on ${name} closed by it.`;
  return "";
}

// Retags a target to `to`, or drops it when `to` is "not-session".
// Returns the read-back.
export async function retag(
  store: SessionStore,
  target: Target,
  to: Series | "not-session",
  series: Series[],
): Promise<string> {
  const nameOf = (id: string) => series.find((s) => s.id === id)?.name ?? id;
  if (target.kind === "item") {
    const { item } = target;
    await store.deleteReviewItem(item);
    const when = formatShort(Date.parse(item.start), series.find((s) => s.id === item.seriesId)?.timezone ?? "UTC");
    if (to === "not-session") {
      await store.putClaims(
        item.conversationIds.map((id) => ({ conversationId: id, seriesId: "", sessionStart: "", source: "you" as const, status: "rejected" as const })),
      );
      return `Dropped the ${when} conversation; it won't be suggested again.`;
    }
    await store.putClaims(
      item.conversationIds.map((id) => ({ conversationId: id, seriesId: to.id, sessionStart: item.start, source: "you" as const, status: "confirmed" as const })),
    );
    return `Filed the ${when} conversation under ${to.name}. Bee's summary is kept from the next collection, within 15 minutes.`;
  }

  const { ref, end } = target;
  const from = series.find((s) => s.id === ref.seriesId);
  const when = formatShort(Date.parse(ref.start), from?.timezone ?? "UTC");
  const pending = (await store.listReviewItems()).find((i) => i.seriesId === ref.seriesId && i.start === ref.start);
  if (pending) await store.deleteReviewItem(pending);
  const beforeOld = await openCount(store, ref.seriesId);

  if (to === "not-session") {
    const keepOn = (await store.listSessions(ref.seriesId, 50)).find((v) => v.start < ref.start) ?? null;
    const moved = await store.rejectSession(ref, keepOn && { seriesId: ref.seriesId, start: keepOn.start });
    await store.updateMarkers([ref.start, end], null);
    const afterOld = await openCount(store, ref.seriesId);
    const kept = moved ? ` Your ${plural(moved, "note")} from it moved to the session before.` : "";
    return `Marked the ${nameOf(ref.seriesId)} session on ${when} as not a session.${agendaEffect(nameOf(ref.seriesId), beforeOld, afterOld)}${kept}`;
  }

  if (to.id === ref.seriesId) {
    await store.moveSession(ref, to.id, CONFIRMED_TAG);
    await store.updateMarkers([ref.start, end], to.id);
    return `Confirmed: the ${when} session is ${to.name}.`;
  }
  const beforeNew = await openCount(store, to.id);
  await store.moveSession(ref, to.id, CONFIRMED_TAG);
  await store.updateMarkers([ref.start, end], to.id);
  const [afterOld, afterNew] = [await openCount(store, ref.seriesId), await openCount(store, to.id)];
  return (
    `Moved the ${when} session from ${nameOf(ref.seriesId)} to ${to.name}.` +
    agendaEffect(nameOf(ref.seriesId), beforeOld, afterOld) +
    agendaEffect(to.name, beforeNew, afterNew) +
    ` Your ${to.name} agenda has ${plural(afterNew, "open item")}.`
  );
}
