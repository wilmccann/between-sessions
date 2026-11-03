// The Alexa skill: a plain function from a request envelope to a response
// envelope. Each intent calls its tool through ToolDef.call, the same code
// the MCP server runs, and speaks the tool's view with speech.ts.
//
// Guards first, failing closed: the skill ID must be ours and the user ID on
// the allowlist, else one short refusal that touches no store data.
// Session attributes keep the series you named, the agenda ids in the order
// they were read (so "remove number two" is what you heard), the review
// list, a pending retag waiting for a yes, and what a yes to the last
// question would do.
import type { dialog, Intent, IntentRequest, RequestEnvelope, ResponseEnvelope, Slot, ui } from "ask-sdk-model";
import { bestAgendaMatch } from "../button.js";
import { choose, type Purpose } from "../choose.js";
import { TOOLS } from "../mcp/capabilities.js";
import type { PrepBriefView, SessionView } from "../mcp/views.js";
import { buttonReceipt } from "../receipts.js";
import { refId } from "../review.js";
import { matchSeriesName, OTHER_ID, type NameMatch, type Series } from "../series.js";
import { openAgenda } from "../store/agenda.js";
import type { SessionStore } from "../store/types.js";
import { INTENT_NAMES, SERIES_TYPE, type IntentName } from "./intents.js";
import * as say from "./speech.js";
import { isDiscreet, type AgendaView, type Hint, type ReviewView, type SinceView, type Speech } from "./speech.js";

export interface AlexaConfig {
  store: SessionStore;
  skillId: string;
  userIds: string[];
  now?: number;
}

export type Outcome = "ok" | "refused" | "error";

export interface AlexaResult {
  response: ResponseEnvelope;
  outcome: Outcome;
  requestType: string;
  intent?: string;
}

// What a "yes" to the last question does: run an intent, or say how to ask.
type Offer = { intent: IntentName } | { hint: Hint };

export interface Attributes {
  series?: string;
  agenda?: { series: string; ids: (string | null)[] };
  review?: { id: string; durationMinutes: number }[];
  pending?: { id: string; durationMinutes: number; to: string; at: number };
  offer?: Offer;
}

// A pending retag older than this needs asking again.
export const PENDING_MS = 5 * 60_000;

// The question each tool's `next` hint asks, as what a yes does.
const OFFERS: Record<string, Offer> = {
  get_prep_brief: { hint: "agenda" },
  get_since_last_session: { intent: "PrepBriefIntent" },
  get_last_session: { hint: "takeaway" },
  add_agenda_item: { intent: "ListAgendaIntent" },
  list_agenda: { intent: "PrepBriefIntent" },
  remove_agenda_item: { intent: "ListAgendaIntent" },
  save_takeaway: { hint: "agenda" },
  review_sessions: { hint: "retag" },
  retag_session: { intent: "ReviewIntent" },
};

interface Reply {
  speech: Speech;
  end?: boolean;
  offer?: Offer;
}

const ssml = (s: string): ui.SsmlOutputSpeech => ({ type: "SSML", ssml: `<speak>${s}</speak>` });

function envelopeFor(reply: Reply, attributes?: Attributes, directives: dialog.DynamicEntitiesDirective[] = []): ResponseEnvelope {
  const response: ResponseEnvelope["response"] = { outputSpeech: ssml(reply.speech.speech), shouldEndSession: Boolean(reply.end) };
  if (!reply.end && reply.speech.reprompt) response.reprompt = { outputSpeech: ssml(reply.speech.reprompt) };
  if (directives.length && !reply.end) response.directives = directives;
  return { version: "1.0", ...(attributes ? { sessionAttributes: attributes } : {}), response };
}

const REFUSED: Reply = { speech: { speech: say.escapeSsml(say.REFUSAL) }, end: true };

// Every ID the request carries must match; with no skill ID or no users
// configured, nobody gets in.
export function allowed(envelope: RequestEnvelope, skillId: string, userIds: string[]): boolean {
  const users = userIds.map((u) => u.trim()).filter(Boolean);
  if (!skillId.trim() || !users.length) return false;
  const apps = [envelope.session?.application?.applicationId, envelope.context?.System?.application?.applicationId].filter(Boolean);
  const people = [envelope.session?.user?.userId, envelope.context?.System?.user?.userId].filter(Boolean);
  return apps.length > 0 && apps.every((a) => a === skillId.trim()) && people.length > 0 && people.every((p) => users.includes(p!));
}

// Your series as dynamic entities for the SERIES slot, so real names never
// enter the public interaction model.
export function seriesEntities(all: Series[]): dialog.DynamicEntitiesDirective {
  return {
    type: "Dialog.UpdateDynamicEntities",
    updateBehavior: "REPLACE",
    types: [{ name: SERIES_TYPE, values: all.map((s) => ({ id: s.id, name: { value: s.name, synonyms: s.spokenNames } })) }],
  };
}

export async function runAlexa(envelope: RequestEnvelope, config: AlexaConfig): Promise<AlexaResult> {
  const request = envelope.request;
  const requestType = request.type;
  const intent = request.type === "IntentRequest" ? request.intent.name : undefined;
  const result = (response: ResponseEnvelope, outcome: Outcome): AlexaResult => ({ response, outcome, requestType, intent });

  if (!allowed(envelope, config.skillId, config.userIds)) return result(envelopeFor(REFUSED), "refused");
  if (requestType === "SessionEndedRequest") return result({ version: "1.0", response: {} }, "ok");

  const attributes: Attributes = { ...((envelope.session?.attributes ?? {}) as Attributes) };
  try {
    const turn = new Turn(config, attributes);
    let reply: Reply;
    if (request.type === "LaunchRequest") reply = await turn.launch();
    else if (request.type === "IntentRequest") reply = await turn.intent(request);
    else reply = { speech: say.renderFallback(), offer: { intent: "AMAZON.HelpIntent" } };
    if (reply.offer) attributes.offer = reply.offer;
    else delete attributes.offer;
    const first = request.type === "LaunchRequest" || envelope.session?.new === true;
    const directives = first ? await turn.entities() : [];
    return result(envelopeFor(reply, attributes, directives), "ok");
  } catch {
    return result(envelopeFor({ speech: say.renderError() }, attributes), "error");
  }
}

export async function handleAlexa(envelope: RequestEnvelope, config: AlexaConfig): Promise<ResponseEnvelope> {
  return (await runAlexa(envelope, config)).response;
}

type Picked = { series: Series; all: Series[]; failure?: undefined } | { failure: Reply; series?: undefined };

const slotValue = (slot: Slot | undefined) => slot?.value?.trim() || undefined;
const hasSlot = (slot: Slot | undefined) => Boolean(slotValue(slot) || slot?.resolutions?.resolutionsPerAuthority?.length);

// A spoken series: a dynamic entity id first, then what you said, then the
// generic static value it resolved to.
export function resolveSeries(slot: Slot | undefined, all: Series[]): NameMatch {
  let dynamicId: string | undefined;
  let staticName: string | undefined;
  for (const r of slot?.resolutions?.resolutionsPerAuthority ?? []) {
    const value = r.values?.[0]?.value;
    if (r.status?.code !== "ER_SUCCESS_MATCH" || !value) continue;
    if (r.authority.includes(".dynamic.")) dynamicId ??= value.id;
    else staticName ??= value.name;
  }
  const byId = all.find((s) => s.id === dynamicId);
  if (byId) return { kind: "match", series: byId };
  for (const name of [slotValue(slot), staticName]) {
    if (!name) continue;
    const m = matchSeriesName(all, name);
    if (m.kind !== "none") return m;
  }
  return { kind: "none" };
}

function notMatched(m: Exclude<NameMatch, { kind: "match" }>, slot: Slot | undefined): Reply {
  if (m.kind === "none") return { speech: say.renderUnknownSeries(slotValue(slot) ?? "that") };
  const ask = `Did you mean ${m.candidates.map((s) => s.name).join(" or ")}?`;
  return { speech: say.renderWhichSeries(ask, m.candidates.some(isDiscreet)) };
}

interface Called<V> {
  ok: boolean;
  text: string;
  view: V | null; // the JSON answer, or null for a text answer
  next?: string;
  offer?: Offer;
}

class Turn {
  private readonly store: SessionStore;
  private readonly now: number;
  private allSeries?: Series[];

  constructor(
    config: AlexaConfig,
    private readonly attrs: Attributes,
  ) {
    this.store = config.store;
    this.now = config.now ?? Date.now();
  }

  private async all(): Promise<Series[]> {
    return (this.allSeries ??= await this.store.listSeries());
  }

  async entities(): Promise<dialog.DynamicEntitiesDirective[]> {
    const all = await this.all();
    return all.length ? [seriesEntities(all)] : [];
  }

  private async call<V>(name: string, args: Record<string, unknown>): Promise<Called<V>> {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    const res = await tool.call(args, { store: this.store });
    const first = res.content[0];
    const text = first?.type === "text" ? first.text : "";
    const ok = !res.isError;
    return { ok, text, view: ok && text.startsWith("{") ? (JSON.parse(text) as V) : null, next: tool.next, offer: OFFERS[name] };
  }

  private async anyDiscreet() {
    return (await this.all()).some(isDiscreet);
  }

  // The series a request means: the one you named (remembered for the
  // session), the one named earlier, or choose()'s usual pick.
  private async pick(req: IntentRequest, purpose: Purpose): Promise<Picked> {
    const all = await this.all();
    const slot = req.intent.slots?.series;
    if (hasSlot(slot)) {
      const m = resolveSeries(slot, all);
      if (m.kind !== "match") return { failure: notMatched(m, slot) };
      this.attrs.series = m.series.id;
      return { series: m.series, all };
    }
    const remembered = all.find((s) => s.id === this.attrs.series);
    if (remembered) return { series: remembered, all };
    const c = await choose(this.store, undefined, purpose, this.now, all);
    if (c.series) return { series: c.series, all };
    return { failure: { speech: say.renderWhichSeries(c.ask, all.some(isDiscreet)) } };
  }

  async launch(): Promise<Reply> {
    const all = await this.all();
    const records = await this.store.listJournalRecords();
    // Discreet series' names stay out of the receipt.
    const receipt = buttonReceipt(records, all.filter((s) => !isDiscreet(s)), this.now);
    const c = all.length ? await choose(this.store, undefined, "next", this.now, all) : null;
    let next: { series: Series; nextAt: string | null } | null = null;
    if (c?.series) {
      const brief = await this.call<PrepBriefView>("get_prep_brief", { series: c.series.id });
      if (brief.view) next = { series: c.series, nextAt: brief.view.nextSessionAt };
    }
    return { speech: say.renderLaunch(receipt, next, this.now) };
  }

  async intent(req: IntentRequest): Promise<Reply> {
    const name = req.intent.name as IntentName;
    const route = INTENT_NAMES.includes(name) ? this.routes[name] : undefined;
    return route ? route(req) : this.fallback();
  }

  private fallback(): Reply {
    return { speech: say.renderFallback(), offer: { intent: "AMAZON.HelpIntent" } };
  }

  private readonly routes: Record<IntentName, (req: IntentRequest) => Promise<Reply>> = {
    "AMAZON.HelpIntent": async () => ({ speech: say.renderHelp() }),
    "AMAZON.FallbackIntent": async () => this.fallback(),
    "AMAZON.StopIntent": async () => this.goodbye(),
    "AMAZON.CancelIntent": async () => this.goodbye(),
    "AMAZON.NavigateHomeIntent": async () => this.goodbye(),

    PrepBriefIntent: async (req) => {
      const p = await this.pick(req, "next");
      if (p.failure) return p.failure;
      const r = await this.call<PrepBriefView>("get_prep_brief", { series: p.series.id });
      if (!r.view) return this.error();
      return { speech: say.renderPrepBrief(r.view, p.series, isDiscreet(p.series), r.next, this.now), offer: r.offer };
    },

    NextSessionIntent: async (req) => {
      const p = await this.pick(req, "next");
      if (p.failure) return p.failure;
      const r = await this.call<PrepBriefView>("get_prep_brief", { series: p.series.id });
      if (!r.view) return this.error();
      return { speech: say.renderNextSession(r.view, p.series, isDiscreet(p.series), r.next, this.now), offer: r.offer };
    },

    SinceLastSessionIntent: async (req) => {
      const p = await this.pick(req, "digest");
      if (p.failure) return p.failure;
      if (p.series.id === OTHER_ID) return { speech: say.renderSinceOff() };
      const r = await this.call<SinceView>("get_since_last_session", { series: p.series.id });
      if (!r.ok) return this.error();
      return { speech: say.renderSinceLastSession(r.view, p.series, isDiscreet(p.series), r.next, this.now), offer: r.offer };
    },

    LastSessionIntent: async (req) => {
      const p = await this.pick(req, "recent");
      if (p.failure) return p.failure;
      const r = await this.call<SessionView>("get_last_session", { series: p.series.id });
      if (!r.ok) return this.error();
      return { speech: say.renderLastSession(r.view, p.series, isDiscreet(p.series), r.next), offer: r.view ? r.offer : undefined };
    },

    AddAgendaItemIntent: async (req) => {
      const item = slotValue(req.intent.slots?.item);
      if (!item) return { speech: say.renderMissingText("agenda") };
      const p = await this.pick(req, "next");
      if (p.failure) return p.failure;
      const r = await this.call("add_agenda_item", { series: p.series.id, text: item.slice(0, 500) });
      if (!r.ok) return this.error();
      return { speech: say.renderAgendaAdded(item, p.series, isDiscreet(p.series), r.next), offer: r.offer };
    },

    ListAgendaIntent: async (req) => {
      const p = await this.pick(req, "next");
      if (p.failure) return p.failure;
      const r = await this.call<AgendaView>("list_agenda", { series: p.series.id });
      if (!r.ok) return this.error();
      const open = await this.openAgenda(p.series.id);
      this.attrs.agenda = { series: p.series.id, ids: open.map((i) => i.id) };
      return { speech: say.renderAgendaList(r.view, p.series, isDiscreet(p.series), r.next), offer: r.offer };
    },

    RemoveAgendaItemIntent: async (req) => {
      const n = Number(slotValue(req.intent.slots?.n));
      const words = slotValue(req.intent.slots?.item);
      if (Number.isInteger(n) && slotValue(req.intent.slots?.n)) return this.removeNumber(n);
      if (!words) return { speech: say.renderNoAgendaList() };
      const p = await this.pick(req, "next");
      if (p.failure) return p.failure;
      const item = bestAgendaMatch(await this.openAgenda(p.series.id), words);
      if (!item) return { speech: say.renderNotOnAgenda(words, p.series, isDiscreet(p.series)) };
      // The exact text, so the tool removes the item read back.
      const r = await this.call("remove_agenda_item", { series: p.series.id, text: item.text });
      if (!r.ok) return { speech: say.renderNotOnAgenda(words, p.series, isDiscreet(p.series)) };
      this.forget(item.id);
      return { speech: say.renderAgendaRemoved(item.text, p.series, isDiscreet(p.series), r.next), offer: r.offer };
    },

    SaveTakeawayIntent: async (req) => {
      const takeaway = slotValue(req.intent.slots?.takeaway);
      if (!takeaway) return { speech: say.renderMissingText("takeaway") };
      const p = await this.pick(req, "recent");
      if (p.failure) return p.failure;
      const r = await this.call("save_takeaway", { series: p.series.id, text: takeaway.slice(0, 500) });
      if (!r.ok) return { speech: say.renderNoTakeawaySession(p.series, isDiscreet(p.series)) };
      return { speech: say.renderTakeawaySaved(takeaway, p.series, isDiscreet(p.series), r.next), offer: r.offer };
    },

    ReviewIntent: async () => {
      const r = await this.call<ReviewView>("review_sessions", {});
      if (!r.ok) return this.error();
      delete this.attrs.pending;
      this.attrs.review = (r.view?.sessions ?? []).map(({ id, durationMinutes }) => ({ id, durationMinutes }));
      return {
        speech: say.renderReview(r.view, await this.all(), await this.anyDiscreet(), r.next, this.now),
        offer: r.view?.sessions.length ? r.offer : undefined,
      };
    },

    RetagIntent: async (req) => {
      const first = this.attrs.review?.[0];
      if (!first) return { speech: say.renderNoReviewList() };
      const all = await this.all();
      const slot = req.intent.slots?.series;
      // No series heard is "that wasn't a session"; the question says which.
      let to: Series | "not-session" = "not-session";
      if (hasSlot(slot)) {
        const m = resolveSeries(slot, all);
        if (m.kind !== "match") return notMatched(m, slot);
        to = m.series;
      }
      this.attrs.pending = { ...first, to: to === "not-session" ? to : to.id, at: this.now };
      return { speech: say.renderRetagConfirm(first, to, all, await this.anyDiscreet(), this.now) };
    },

    "AMAZON.YesIntent": async (req) => {
      const pending = this.attrs.pending;
      if (pending) return this.confirmRetag(pending);
      const offer = this.attrs.offer;
      if (offer && "intent" in offer) return this.routes[offer.intent]({ ...req, intent: { ...req.intent, name: offer.intent, slots: {} } as Intent });
      if (offer && "hint" in offer) return { speech: say.renderHint(offer.hint) };
      return { speech: say.renderNothingToConfirm() };
    },

    "AMAZON.NoIntent": async () => {
      if (!this.attrs.pending) return { speech: say.renderOkay() };
      delete this.attrs.pending;
      return { speech: say.renderRetagKept() };
    },
  };

  private goodbye(): Reply {
    return { speech: { speech: say.escapeSsml(say.GOODBYE) }, end: true };
  }

  private error(): Reply {
    return { speech: say.renderError() };
  }

  private async openAgenda(seriesId: string) {
    return openAgenda(await this.store.listAgenda(seriesId), await this.store.getLatestSession(seriesId));
  }

  // Keeps the numbers you heard: a removed item leaves a gap.
  private forget(id: string) {
    const ids = this.attrs.agenda?.ids;
    if (!ids) return;
    const at = ids.indexOf(id);
    if (at >= 0) ids[at] = null;
  }

  private async removeNumber(n: number): Promise<Reply> {
    const list = this.attrs.agenda;
    const series = (await this.all()).find((s) => s.id === list?.series);
    if (!list || !series) return { speech: say.renderNoAgendaList() };
    if (n < 1 || n > list.ids.length) return { speech: say.renderNoSuchNumber(n) };
    const id = list.ids[n - 1];
    const item = (await this.openAgenda(series.id)).find((i) => i.id === id);
    if (!item) return { speech: say.renderAlreadyRemoved() };
    const r = await this.call("remove_agenda_item", { series: series.id, text: item.text });
    if (!r.ok) return { speech: say.renderAlreadyRemoved() };
    this.forget(item.id);
    return { speech: say.renderAgendaRemoved(item.text, series, isDiscreet(series), r.next), offer: r.offer };
  }

  // Only a yes, soon after the question, on a guess that's still waiting,
  // calls retag_session.
  private async confirmRetag(pending: NonNullable<Attributes["pending"]>): Promise<Reply> {
    delete this.attrs.pending;
    const all = await this.all();
    const to = pending.to === "not-session" ? "not-session" : all.find((s) => s.id === pending.to);
    const waiting = (await this.store.listReviewItems()).some((i) => refId(i) === pending.id);
    if (!to || !waiting || this.now - pending.at > PENDING_MS) return { speech: say.renderRetagStale() };
    const r = await this.call("retag_session", to === "not-session" ? { id: pending.id, notASession: true } : { id: pending.id, series: to.id });
    if (!r.ok) return { speech: say.renderRetagFailed() };
    this.attrs.review = this.attrs.review?.filter((x) => x.id !== pending.id);
    return { speech: say.renderRetagDone(r.text, to, await this.anyDiscreet(), r.next), offer: r.offer };
  }
}
