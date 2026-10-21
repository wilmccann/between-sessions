import type { AgendaItem, SessionVersion } from "./types.js";

// Agenda items are for the next session, so an item is open until a session
// starts after it was added.
export function openAgenda(items: AgendaItem[], latest: SessionVersion | null): AgendaItem[] {
  return latest ? items.filter((i) => i.createdAt > latest.start) : items;
}
