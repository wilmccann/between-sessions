# Proposal: one MCP server for session prep and Bee context

Status: **parked**, Oct 21 evening. Drafted, then reviewed against the code, CloudWatch logs and read-only CLI checks (see [Review findings](#review-findings-oct-21)). Recommendation from the review: build only P0 (the menu) before the Friday deadline; P1 (Bee context tools) waits until after Friday, or ships local-only behind a flag. Whether P1 is the right direction at all is still open; see [Alternatives](#alternatives-to-p1). Nothing here is built yet.

## Problem

Today there are two separate ways to ask about Bee data, and neither tells you what you can ask:

| | Between Sessions (this repo) | bee-skill (bee-skill-lab) |
| --- | --- | --- |
| What it answers | Prep brief, last session, session list, agenda, takeaways | Open questions: facts about me, "did I mention X", today's plan from todos |
| How it's delivered | Remote MCP server (API Gateway + Lambda), any MCP client | A SKILL.md that teaches Claude Code to run the `bee` CLI |
| Where it works | Claude Code, any MCP client, Alexa bridge (blocked) | Only where Claude Code runs next to the CLI (the Mac, or the phone through Remote Control) |
| How you find out what to ask | Nothing (no server instructions, prompts or help) | The skill text, which only the model reads |

Goal: one MCP server that answers both kinds of question, works in any MCP client (not only Claude), and tells you what it can do.

## Design

### One server, three groups of tools

The existing `between-sessions` server grows; nothing is renamed.

**1. Sessions (exists today, unchanged):** `get_prep_brief`, `get_last_session`, `list_sessions`, `add_agenda_item`, `list_agenda`, `save_takeaway`.

**2. Bee context (new, read-only):** the parts of bee-skill's capability map that fit this project's rules.

| Tool | Answers | bee-skill equivalent | Notes from review |
| --- | --- | --- | --- |
| `bee_facts(status: confirmed\|unconfirmed\|all)` | "What do you know about me?" | `bee facts list [--unconfirmed]` | `facts list` returns confirmed only; `all` needs both calls |
| `bee_todos(include_suggestions)` | "What's on my list?" | `bee todos list`, `bee todos suggestions` | Suggestions come back under `todoSuggestions` |
| `bee_today()` | "Plan my day" (with `bee_todos`) | `bee today --context` | Keep `activeTodos`, `dailySummary`, `recentConversations`; **drop `todayBrief`** (calendar events and emails) |
| `bee_day(date)` | "What happened on Tuesday?" | `bee daily find <date>` | Keep `summary`, `short_summary`, `conversations_count`, `date_time`; **drop `locations`, `photos`, `email_summary`, `calendar_summary`, `account_summaries`** |
| `bee_insights(since)` | "Any patterns lately?" | `bee insights list` | Already collected (21-day lookback) |
| `bee_search(query, scope, since)` | "Did I mention X this week?" | `bee search` (keyword) | Matches Bee's keyword search; see Q3 |

Left out on purpose:
- **Verbatim utterances** (`bee now`, `conversations get/transcript`): CLAUDE.md says to work from summaries.
- **Locations and photos:** too sensitive for a bearer-token endpoint. Note that daily summaries carry these fields, so the collector must keep an explicit field allowlist, not store records as returned.
- **Email and calendar content:** `today --context` includes them in `todayBrief`; drop that field.
- **Any write to Bee** (facts, todos): a v1 server shouldn't change Bee data.
- **`sync`, `stream`, `proxy`:** not needed.

**3. Help (new):** `help()` returns the menu below. It is short enough to be spoken, so Alexa can use it too.

### Discoverability, built into the server so every client gets it

1. **Server instructions** (sent when a client connects; Claude Code adds them to every session). They contain:
   - what the server is for, and the menu with one example per tool;
   - routing: session questions go to the session tools, everything else Bee knows goes to `bee_*` (or, without P1, a plain "I only see your sessions; for anything else, use the Bee app");
   - the rules from bee-skill that still apply: summaries can be wrong, unconfirmed facts are guesses and should be flagged, prefer search to paging;
   - after each answer, suggest one next thing to ask.
2. **MCP prompts**, which clients show as a menu (in Claude Code, typing `/` lists them):
   - `prep`, `agenda`, `takeaway`;
   - with P1: `about_me` (bee-skill's "confirmed / unconfirmed / missing" prompt), `plan_today` (bee-skill's "top 5 actions" prompt), `did_i_mention`.
3. **Next-step hints in tool results**: each JSON result gets a short `next` field, for example `["add an agenda item", "save a takeaway"]`.
4. ~~**The bee-skill text as an MCP resource** (`skill://bee-cli`).~~ **Dropped after review** (Q5): serving the text doesn't "call" anything, the bee-skill repo has no LICENSE file (only its README says MIT), and CLAUDE.md requires the user to name any outside file before it is copied in. The server instructions can still borrow its rules in our own words.

The menu, the prompts and the hints all come from one list in `src/mcp/server.ts`, so they can't drift apart.

### Data path: precompute, don't call Bee live

CLAUDE.md says tools read precomputed data and answer in under 500 ms. The new tools keep that:

- The **collector** (already runs the `bee` CLI in Lambda every 15 minutes, with its login in Secrets Manager) also saves, through a field allowlist:
  - facts (with confirmed flag);
  - todos and suggestions;
  - today's context, without `todayBrief`;
  - the last 30 days of daily summaries and conversation **summaries** (about 230 conversations at the current rate, not 100);
  - insights (already collected).

  These go into the existing DynamoDB table, one item per record, under new key prefixes. No utterances.
- Facts and insights can refresh hourly; todos, today and conversations every 15 minutes.
- The **MCP Lambda** reads DynamoDB only, as it does now. `bee_search` is a keyword match over the cached summaries, daily summaries and facts, scoped by date.
- **Freshness:** at most 15 minutes old. Results include `as_of`, so the client can say "as of 2:15 pm".

Why not call Bee live from the MCP Lambda:
- It breaks the 500 ms budget.
- It needs the Bee login in a second function.
- Two functions refreshing the same CLI token can overwrite each other's refresh.

Live calls (and Bee's semantic `--neural` search) are a later phase.

### Where it works

| Client | Sessions | Bee context | Menu |
| --- | --- | --- | --- |
| Claude Code (Mac, or phone through Remote Control) | yes | yes (local server only until the exposure question is settled) | instructions, `/` prompts, help |
| Other MCP clients with bearer-token support | yes | same | instructions where supported, help |
| claude.ai / Claude mobile connector | needs OAuth (Cognito, cut for now) | same | same |
| Alexa bridge | yes, if Bedrock quota arrives | yes | `help` on "what can you do?" |

The bee-cli skill can still be installed next to this server in Claude Code. It then adds what the server leaves out (live `bee now`, semantic search) behind its own permission prompts. That's optional, not part of this plan.

## Risks and how they're handled

- **A much bigger blast radius for the bearer token.** Today the collector stores only conversations that match a session series (3 of about 115 in the logs). P1 would put every conversation summary from 30 days, plus facts and todos, behind the same token. Mitigations:
  - `bee_*` tools behind a flag (for example `BEE_CONTEXT_TOOLS=local`), on in `src/local/mcp-http.ts`, off on the remote endpoint until decided;
  - field allowlist (no locations, photos, email or calendar);
  - read-only;
  - the existing 2 req/s throttle;
  - rotate the token after the demo.
- **Prompt injection.** Summaries contain other people's words. The instructions say tool results are data, and tools return JSON fields, not prose meant to be followed.
- **Tool count (6 to 13).** Harder tool choice for small models (Alexa's Nova). Matters only if Alexa comes back. Mitigations: clear `bee_` vs session naming, descriptions written for voice, routing tests in `test/mcp.test.ts`.
- **Stale or rewritten summaries.** Bee rewrites summaries. The cache shows the latest version; the session snapshots keep the first one, as today.
- **DynamoDB 400 KB item limit.** One item per record, never one big list.
- **CLI version.** Lambda bundles `@beeai/cli` 0.8.0; the review checked shapes on 0.7.3 locally. Check 0.8.0 shapes in Lambda (keys only) before relying on them.
- **Bee rate limits are unpublished.** P1 adds about 6 to 8 CLI calls per run to today's 4. Log it in the friction log.

## Review findings (Oct 21)

Checks printed only keys and counts.

1. **Collector headroom: yes.** The last 8 runs took 3.5 to 7.2 s and about 182 MB, against a 5-minute timeout and 1024 MB (`infra/stack.ts`). Each run makes about 4 CLI calls today. Bee rate limits are unknown. Hourly refresh for facts and insights is a cheap margin, not a requirement.
2. **CLI shapes: mostly.** Facts have `confirmed` (default list is confirmed only). `today --context` returns `date`, `todayBrief` (calendar events, emails), `dailySummary`, `activeTodos`, `recentNotes`, `recentConversations`. Daily summaries include `locations`, `photos`, `email_summary`, `calendar_summary`. Hence the field allowlist. Lambda runs 0.8.0, not 0.7.3; 0.8.0 is unverified.
3. **Keyword search over cached summaries: yes, equivalent.** For four test words, every Bee keyword hit had the word in its summary (0 hits without it), and a local substring match over 100 cached summaries found as many or more (work 41 vs 37, dinner 10 vs 7, email 4 vs 5 with one hit older than the cache, budget 3 vs 3). Neither searches utterances, so a passing remark is found only if the summary kept it. Only `--neural` would add recall. 100 conversations covered 13 days.
4. **Bearer-token exposure: bigger than the draft said.** See Risks. Recommendation: local-only behind a flag if built before Friday.
5. **Bee-track citation: cite the CLI, not `skill://bee-cli`.** `src/bee/cli.ts` runs the CLI inside the deployed Lambda, which already meets "actually call ... in code". The resource is dropped (see Discoverability item 4).

Conflicts found with the plan of record:
- **Thursday is already full:** Alexa timebox to the Thu 1pm ET hard stop (if Support lifts Nova 2 Lite), then README and video draft Thursday evening. P0 + P1 adds about 4.5 h, and the draft's "Demo Thu evening" takes the video slot.
- **`search_history` was on the demo plan's cut list;** `bee_search` brings it back under another name.

## Plan (deadline Fri Oct 23, 12:00 PDT / 3:00 pm ET), revised

| Phase | When | Work | Done when |
| --- | --- | --- | --- |
| P0: menu | Thu morning, about 1.5 h | Server instructions (with the "sessions only" boundary), `help` tool, prompts for the existing tools, `next` hints. Tests. Redeploy. | A fresh Claude Code session answers "what can I ask?" correctly, and `/` lists the prompts |
| P1: Bee context | **after Friday** (or Thu, local-only behind a flag, if P0 is done by noon) | Collector saves facts, todos, today, daily, conversation summaries through a field allowlist. Six `bee_*` tools and their prompts. Tests on synthetic fixtures. Check 0.8.0 shapes. | Both bee-skill example prompts work through the local server in under 500 ms per tool call |
| Cut line | Thu 6 pm ET | Anything not green ships as "next" in the README | |
| Later | after Friday | Decide P1 vs the alternatives below; live/neural search; Cognito OAuth for claude.ai; opt-in writes; Alexa | |

## Alternatives to P1

P1 makes the server more general (a remote bee-skill). The review raised the question of whether the product should instead get more useful *for its own job*: the time between sessions. Options, smallest first:

- **A "since last session" digest** instead of six generic tools: one precomputed tool, `get_since_last_session`, with Bee insights since the session, todos created since, how many conversations, and which of the last session's topics came up again (keyword match over summaries). Narrower data exposure than P1, and it answers the question the product is named after.
- **Bee as the input device:** say "for therapy: ..." (or record a Bee journal) during the week, and the collector files it as an agenda item. No app or chat needed to capture. Needs a check that journals work on Android (0 journals as of Oct 20).
- **Push, not pull:** the collector already knows each series' cadence. Send the prep brief the evening before a session, and a "save a takeaway?" nudge when a new session is detected. Privacy tradeoff: content leaves AWS (email, SMS, push), so a notice with no content plus a link or prompt may be better.

## Questions for review (original)

1. Does the collector have room for the extra lists every 15 minutes (time, Bee rate limits, cost)? Should facts and insights refresh hourly instead?
2. Do `bee facts list --json` and `bee today --context --json` return what the tools need (a confirmed flag; todos inside today's context) with CLI 0.7.3 in Lambda?
3. Is the keyword search over cached summaries good enough for "did I mention X", or does it need Bee's server-side search?
4. Is exposing facts and todos through the bearer-token endpoint acceptable for the demo, or should the `bee_*` tools be enabled only in the local server (`src/local/mcp-http.ts`)?
5. Should the Bee-track write-up cite `skill://bee-cli` as the "Agent Skills in code" integration, next to the CLI?

Answers: see [Review findings](#review-findings-oct-21).
