# Feature plan: baseline

Status: **baseline v1.1**, Oct 21, 2026 (v1.1 adds the Bee button with session markers to the MVP). This is the only plan: what's built, what's left, and how we build it, for the Fri Oct 23 submission and after. Change it by editing this file; tick [Built and left to build](#built-and-left-to-build) as work lands, and record decisions in [Decision log](#decision-log).

Older plans and proposals are in [archive/](archive/README.md) for history only.

## Built and left to build

**Built and working** (deployed in stack `BetweenSessions`, us-east-1):
- [x] Collector Lambda every 15 minutes, running Bee CLI 0.8.0, finds sessions from the series' weekly window and keeps dated versions of each session's summary and insights in DynamoDB (so the first-night version survives Bee's rewrites and its 14-day history window).
- [x] Remote MCP server on API Gateway with a bearer token and six tools: `get_prep_brief`, `get_last_session`, `list_sessions`, `add_agenda_item`, `list_agenda`, `save_takeaway`. Warm calls take about 220 to 260 ms.
- [x] Bedrock session notes: code and tests done, deployed switched off.
- [x] Cost guardrails stack: budgets, anomaly alerts and a Lambda kill switch.
- [x] Least-privilege `bee-agent` role (`infra/bee-agent-access.yaml`) and `asm-exec` for secrets.
- [x] Scripts: `brief`, `check:remote`, `seed`, `try-notes`; 39 tests pass. MIT LICENSE.

**Left to build, MVP (in priority order):**
- [x] [Menu](#1-menu-knowing-what-to-ask): server instructions, `help` tool, prompts, a next-step hint after every answer.
- [x] [Since-last-session digest](#2-since-last-session-digest-the-time-between-sessions): `get_since_last_session`.
- [ ] [Bee button](#3-the-bee-button-capture-and-session-control-without-opening-anything-mvp): start and end markers, voice-note commands (debrief, agenda, takeaway), marked ad-hoc sessions, `remove_agenda_item`. Device tests A and C (Oct 21 evening) and D (Thu Oct 22, 4pm).
- [x] [Session tagging and review](#4-session-tagging-and-review-best-guesses-you-can-correct-mvp): tags with best guesses, the review queue, `review_sessions` and `retag_session`, the brief's review line, Bee button retag commands.
- [x] [When is my next session](#small-addition-when-is-my-next-session).

**Cut for the submission:**
- ~~[Voice through Alexa](#5-voice-through-alexa-powered-by-bedrock-asking-without-a-screen)~~: Bedrock's Nova token quotas were still 0 in us-east-1 on the morning of Thu Oct 22, too late for Gates 1 to 3 before the 1pm ET hard stop. The demo is typed in Claude Code plus the Bee button. Voice moves to "next".

**Operations:**
- [x] Switch the table to `RemovalPolicy.RETAIN` with deletion protection, so stored sessions can't be lost with the stack (deployed Thu Oct 22).

**Submission (by Fri Oct 23, 12:00pm PDT):**
- [x] README updated for the new capabilities.
- [ ] Demo video under 3 minutes.
- [ ] Product feedback, and the friction log ([FRICTION_LOG.md](FRICTION_LOG.md)) brought up to date.
- [ ] Push the public repo (only when the user says so).

## Build rules

- **AWS:** use only `AWS_PROFILE=bee-agent`, region `us-east-1`. Don't use `aws-admin` or `agent-toolkit` directly, never run `aws login`, and never use the `fts-website` profile. Changes go through CDK. No em dashes in resource names or descriptions.
- **Secrets:** never call `secretsmanager get-secret-value` or `batch-get-secret-value`; resolve secrets at runtime with `{{resolve:secretsmanager:...}}` and `asm-exec`. Never print, log or commit a token.
- **Real Bee data:** check real-data steps by counts, ids, dates and lengths only, never content. Scripts that print personal content (`yarn brief`) run in the user's own terminal; agents use `--shape`. Tests and examples are synthetic.
- **Personal details** (the real schedule, series names, anything from `series.local.json`) never go into committed files. This repo is public.
- **Git:** never push without the user's say-so.
- **Shell:** Node 22 with `corepack yarn`. Local `bee` calls take about 20 s each (Keychain), so batch them.

**Deployed resources** (stack outputs, names only): `McpUrl` (see the stack output), table `between-sessions`, functions `between-sessions-collector` and `between-sessions-mcp`, schedule `between-sessions-collector`, secrets `between-sessions/bee-cli-config` (created by the user, read and refreshed by the stack) and `between-sessions/mcp-token`, alarm `between-sessions-collector-errors`.

## Product in one line

Between Sessions follows the week around a recurring 1:1 (therapy, coaching, an interview loop): it helps you prepare before a session, keep what mattered after it, and notice and capture what happens in between, using what your Bee already heard.

## What we learned from the first version

- **It was shaped like the data, not like your questions.** Six tools (sessions, agenda, takeaways) that you had to already know about. Nothing told you what to ask.
- **It only worked when you remembered to ask.** No help at the moments that matter.
- **It couldn't see between sessions.** The collector keeps only conversations that match a session, so the product named after the in-between couldn't describe it.
- **Capture took the most effort at the worst moment.** Adding an agenda item meant opening a chat and typing, while you were wearing a device built to capture.
- **Its real strength is remembering what Bee first said.** Bee rewrites summaries; the first-night snapshot of a session is something neither Bee nor bee-skill gives you. Keep it central.

## The week at a glance

| Moment | You say | You get | Capability |
| --- | --- | --- | --- |
| Any time | "What can I ask?" or type `/` | A short menu; one suggestion after every answer | [Menu](#1-menu-knowing-what-to-ask) |
| Mid-week | "What's happened since my last session?" | Days since, conversation count, topics that came back, Bee's insights, new todos | [Digest](#2-since-last-session-digest-the-time-between-sessions) |
| Mid-week, hands busy | *(hold the Bee button)* "Agenda: the work trip" | It appears on your agenda, marked "from Bee" | [Bee button](#3-the-bee-button-capture-and-session-control-without-opening-anything-mvp) |
| Walking to a session | "Alexa, give me my prep brief" | A spoken brief of three sentences or fewer | [Voice](#5-voice-through-alexa-powered-by-bedrock-asking-without-a-screen) + prep brief |
| Session starts | *(hold the Bee button)* "Start session" | The session's start is marked at that moment | [Bee button](#3-the-bee-button-capture-and-session-control-without-opening-anything-mvp) |
| Session ends | *(hold)* "End session", then *(hold)* "Debrief: ..." | The session is captured between your markers, with your debrief; the next brief confirms it | [Bee button](#3-the-bee-button-capture-and-session-control-without-opening-anything-mvp) |
| After an unsure guess | "I tagged Thursday's 52-minute conversation as coaching. Right?" "No, an Acme interview." | Moved to Acme interviews; agenda updated and read back | [Tagging and review](#4-session-tagging-and-review-best-guesses-you-can-correct-mvp) |
| Right after | "Save a takeaway: delegate earlier" (or hold: "Takeaway: ...") | "Saved." | Voice or Bee button + takeaways |
| Before the next session | "Prep brief" | Last session, first-night insights, digest, agenda, takeaways, when the next session is | Prep brief, now richer |

## Meeting types (reference)

The product supports four kinds of meetings. Examples are synthetic.

**How each type gets detected:**

| Type | Setup | Today (time window only) | With Bee button markers (MVP) |
| --- | --- | --- | --- |
| Weekly therapy | Weekly slot | ✅ Works. A late, long or moved session is missed or cut short | ✅ Markers give the exact span; the window catches a session you forgot to mark |
| Coaching, 1 to 2 a month | Today it has to pretend to be weekly | ⚠️ In off weeks, any conversation in that slot becomes a fake coaching session. Sessions on other days are missed | ✅ With no schedule, markers only. ⚠️ Forget to mark it and nothing is recorded |
| Interviews (Acme, Globex) | One series per company, no schedule | ❌ Can't be set up | ✅ "Start session: Acme interview" creates the series. Several rounds in one day work if each one is marked |
| Other | The catch-all series | ❌ | ✅ Works, but of limited use |

**Each tool with each type (assuming markers are built):**

| Tool | Weekly therapy | Coaching (1 to 2 a month) | Interviews (Acme, Globex) | Other |
| --- | --- | --- | --- | --- |
| `get_prep_brief` | ✅ "Prep for therapy": last session, first-night insights, takeaways, open agenda, next session | ✅ Content works. ⚠️ With no schedule, "next session" should say "not scheduled", not a guessed weekday | ✅ "Prep for Globex": the last Globex round, Globex agenda only. Good mid-loop: before round 2 it shows round 1 | ⚠️ "Last other meeting" is just the latest unrelated meeting. Better to offer to rename it into a real series |
| `get_last_session` | ✅ | ✅ Still there a month later, after Bee has dropped it (14-day window) | ✅ "Last Acme interview". ⚠️ Only the latest round; there's no date option to ask for an earlier one | ✅ The latest marked meeting |
| `list_sessions` | ✅ | ✅ | ✅ One company at a time. ❌ "All my interviews" across Acme and Globex isn't possible | ✅ |
| `add_agenda_item` | ✅ "Add sleep to my therapy agenda": open until the next therapy session | ✅ With the window only, a fake off-week session silently closes the item early | ✅ "Add 'ask about team size' to Globex". ⚠️ When the loop ends, items stay open forever | ⚠️ Closes at the next random meeting. Better to ask which series |
| `list_agenda` | ✅ | ✅ (same early-close risk) | ✅ Per company | ⚠️ Same as above |
| `save_takeaway` | ✅ Saved on the last therapy session | ✅ | ⚠️ If you don't name the company, it goes to the first series. If you save round 1's takeaway after round 2 is recorded, it lands on round 2 | ✅ Saved on the last marked meeting |
| `get_since_last_session` (planned) | ✅ "6 days, 41 conversations, the work trip came up 4 times" | ⚠️ Undercounts once the gap passes 14 days (Bee's history window) or 21 days (the collector's lookback) | ⚠️ Gaps of hours during a run of interviews. "Since my first Acme round" would be more useful | ❌ Meaningless. Turn it off for Other |

Today, a request that names no series goes to whichever series the store lists first, and series names must match exactly.

## Existing capabilities (kept)

| Capability | Tool | Change in this plan |
| --- | --- | --- |
| Prep brief | `get_prep_brief` | Gains "Since last session" (digest), "from Bee" agenda items, and "Next session: Tue 17:00" |
| Last session, as Bee first summarized it | `get_last_session` | Sessions come from Bee button markers first, the series' fixed weekly window only as a fallback; gains your debrief |
| Recent sessions | `list_sessions` | Same detection change; each session says whether it was marked or inferred from the schedule |
| Agenda | `add_agenda_item`, `list_agenda` | Gains `remove_agenda_item`; items carry a source (`you` or `bee`) |
| Takeaways | `save_takeaway` | None |

## New capabilities, in priority order

### 1. Menu: knowing what to ask

**What it adds:** you never need to remember tool names, and the product says plainly what it can't do.

**What you experience:**
- In Claude Code, typing `/` lists `prep`, `since`, `agenda`, `takeaway` and `help`.
- Asking "what can I ask?" (typed, or to Alexa) returns a menu short enough to speak: four items (prep, since, agenda, takeaway) with one example each. Looking back at the last session and reviewing guesses are in the server instructions' "Also" line, not the spoken menu.
- After every answer, one suggested next step ("Want to add that to your agenda?").
- Out-of-scope questions get a boundary, not a vague failure: "I see your sessions, including any you mark with the Bee button. For anything else Bee knows, use the Bee app."

**Supports:** every other feature. Each new capability adds one menu entry and one example.

**Built from:**
- MCP server instructions (sent on connect; Claude Code adds them to every session);
- a `help` tool;
- MCP prompts (`prep`, `since`, `agenda`, `takeaway`, `help`);
- a `next` field in tool results;
- all generated from one capability list in `src/mcp/server.ts`, so they can't drift.

**Data exposed:** none new.

**Works when:**
- A fresh Claude Code session answers "what can I ask?" with the menu and no tool names.
- `/` lists the prompts.
- An out-of-scope question ("what do you know about me?") gets the boundary sentence.

### 2. "Since last session" digest: the time between sessions

**What it adds:** the product finally sees the gap it's named after.

**What you experience** (illustrative, synthetic numbers):
> It's been 6 days and 41 conversations. Two things from last session came up again: the work trip (4 times) and sleep (twice). Bee noticed you've been more focused in the mornings. You added 3 todos.

**Supports:** mid-week reflection on its own, and the prep brief, which gains a "Since last session" section.

**Built from:**
- The collector (every 15 minutes) precomputes one digest per series:
  - days since the last session;
  - number of conversations since;
  - Bee insight titles since;
  - todos created since (`bee todos list` timestamps);
  - recurring topics: keywords taken from the last session's summary, counted across conversation summaries since.
- A new tool, `get_since_last_session`, reads the precomputed item (under 500 ms, no Bedrock in the tool path).
- `get_prep_brief` includes it.

**Data exposed:** counts, topic words, insight titles and todo text. Never conversation summaries. Much less than the parked P1 tools.

**Limits:** keyword matching finds a topic only if Bee's summaries mention it. Bee's own keyword search has the same limit (it matches summaries, not transcripts).

**Optional Bedrock upgrade:** when Nova Lite is available, the collector asks it to name the last session's topics (at write time, never in the tool path). Keyword topics remain the fallback.

**Works when:**
- With synthetic fixtures, the digest has the right counts and topics.
- On real data, `check:remote --shape` shows the digest's counts (no content printed).
- "What's happened since my last session?" returns it in one tool call.

### 3. The Bee button: capture and session control without opening anything (MVP)

**What it adds:** the button on the Bee becomes the product's always-available input. You mark when a session starts and ends, debrief right after, and capture agenda items and takeaways, all by holding the button and speaking. No phone, chat or Alexa needed.

**Why it's in the MVP:** session detection was the weakest part of the first version. It guessed sessions from a fixed weekly window in the series config (for example Tuesday 17:00 to 18:00), so a rescheduled, late, long or off-schedule session (an interview loop, a makeup session) was missed or cut. Start and end markers replace the guess with what you actually did. A calendar would have been a better fallback than the fixed window, but Bee's free tier has no calendar integration (`bee today` returns no events and daily calendar summaries are empty) and Bee Pro can't be purchased right now, so the fixed window stays as the fallback.

**How the button is set up:** in the Bee app, Action Button, "Hold and speak" stays on **Voice Notes** (not Voice Assistant). Each hold-and-speak becomes a Bee journal, which the CLI can read. Voice Assistant sends the request to Bee's own assistant, which this product can't see. Double press: "Process current conversation" (or "Bookmark and process"), so pressing it at the end of a session makes Bee finish that conversation and its summary sooner. Bookmarks themselves aren't in the API, so they carry no meaning for this product.

**What you experience:**

| You hold the button and say | What the product does |
| --- | --- |
| "Start session" (or "Start coaching") | Marks the session's start at the time of the note |
| "Start session: Acme interview" | Marks the start of a one-off or new series by name; no schedule needed |
| "End session" | Marks the session's end; the session is captured from the conversations between the two markers |
| "Debrief: ..." | Attaches your debrief, in your words, to the session that just ended |
| "Agenda: the work trip" (or "For therapy: ...") | Adds an agenda item for the next session, marked "from Bee" |
| "Takeaway: delegate earlier" | Saves a takeaway on the last session |

- The button gives no feedback of its own, and processing isn't instant (Bee transcribes the note, then the collector picks it up within 15 minutes). So every touchpoint confirms what was filed: the brief, the digest and the Alexa greeting open with, for example, "Got it: session ended 11:02, debrief saved, 1 agenda item added."
- A note that starts with a command word but can't be filed is reported, not dropped: "1 voice note I couldn't file."
- "Drop the work trip from my agenda" removes an item; any filed item can be undone.

**Supports:**
- **Session detection** (markers first, the series schedule only as a fallback), which every session feature depends on: last session, list of sessions, first-night insights, prep brief, digest.
- **Debriefs**, a new part of the session record and the prep brief.
- **Agenda and takeaways**, which until now only grew when you opened a chat and typed.
- **Marked ad-hoc sessions:** any conversation you deliberately mark (an interview, a hard conversation, a doctor's visit) is kept like a session, with its summaries, first-night insights and versions, long after Bee's 14-day history window drops it.

**Built from:**
- Series config gains a spoken name for each series (for example "therapy", "coaching") and `captureKeywords`.
- **Optional schedule:** the weekday and time window become optional. A series without them gets its sessions from markers only; a series with them also uses the window as the fallback.
- **Spoken series names, fuzzy-matched:** "Start session: <name>" picks the closest existing series name, so a transcription slip ("Akme") doesn't create a duplicate. A clearly new name creates a new series with no schedule.
- **An "Other" series:** an unnamed or unclear "start session" goes to the only series when there is one, and otherwise to a catch-all "Other" series, which you can rename or merge later.
- Storage needs no change: sessions are already kept per series (`SERIES#<id>`, one item per session version), and the tools already take an optional series name.
- The collector reads `bee journals list` every run and parses each `READY` journal's first words against a small command list, with forgiving matching for transcription slips ("and session"). Each journal is used once (by Bee id).
- **Markers:** the journal's time marks the start or end. The session is built from the Bee conversations that overlap the marked span. Rules for missing halves: a start with no end closes at the end of the last overlapping conversation (or after a maximum length set per series); an end with no start opens at the start of the first overlapping conversation. Sessions without markers, including all sessions before markers existed, still come from the schedule window.
- **Debrief:** a "Debrief:" note within a few hours of an end marker attaches to that session; later, to the most recent session.
- **Agenda, takeaway:** the existing `add_agenda_item` and `save_takeaway` storage, with `source: bee` and the journal id.
- **Todo suggestions (secondary, confirm first):** Bee also derives suggestions from what you say, but many mention a keyword without being agenda items. Matching suggestions are offered in the brief ("Bee heard: bring up the work trip. Add it to your agenda?"), never filed automatically.
- New tool `remove_agenda_item`.

**Past sessions:** sessions recorded before markers existed are already found by the schedule window. Bee can't create journals after the fact (the CLI only lists, searches and gets them), so exact times for past sessions, if wanted, go in our own git-ignored `series.local.json` as known start and end times.

**Data stored:** the time of each marker; the text after a recognized command (your own words, spoken on purpose, like a typed takeaway); only the id of a note that wasn't a command. No ambient utterances. Marked ad-hoc sessions keep the same session data as recurring ones (summaries and insights), but only for conversations you explicitly marked; the README says so.

**Findings so far (Oct 21 test):**
- **Journals work on the Android app.** A test note came back from `bee journals list` as `READY`, with fields `id`, `text`, `state`, `created_at`, `updated_at`, `corrections`, and its text contained the keyword. It was ready within the hour.
- **Bee also created a todo suggestion** for the same item, not an active todo. Four of 50 current suggestions mention the keyword, which is why suggestions need confirmation.
- Conversations expose `state` (`CAPTURING`, then `COMPLETED`) but no bookmark field.

**Tests on the device** (made-up, harmless talk; note the phone-clock time of every press; then only timestamps, counts and yes/no matches are checked, never content):

| Test | When | Steps | What it tells us |
| --- | --- | --- | --- |
| A: explicit markers | Oct 21 evening | Hold: "Start coaching session." Talk 3 min. Hold: "End coaching session." Double-press. | Both notes become `READY` journals; whether `created_at` is when you spoke or when Bee finished; whether the conversation sits between the markers; how fast double-press completes it |
| C: double press alone | Oct 21 evening | Double-press. Talk 2 min. Double-press. | Whether double press leaves any trace (expected: none) |
| D: combined | Thu Oct 22, 4pm (Fri is the spare) | The script below | Markers, debrief, agenda, a review item and timing together, on the deployed build. No seeding: "Start coaching session" creates an unscheduled Coaching series |

**Test D script** (normal voice, a few seconds between holds; note the phone-clock time of each):
1. *(hold)* "Start coaching session." Talk for 3 to 4 minutes.
2. *(hold)* "End coaching session."
3. *(hold)* "Debrief: the test went fine."
4. *(hold)* "Agenda for coaching: bring up the work trip."
5. For a real review item: *(hold)* "Start session." Talk for 2 minutes. *(hold)* "End session." With two series and no slot at that hour, this pair is filed under Other, pending review.
6. Within about 15 minutes the next brief opens with what was filed, and `review_sessions` lists the unnamed session. Record the retag for the video: "That was coaching."

Say "session", not "call" ("Start a coaching call" names a separate "coaching call" series). Always name the series in the first pair: with only one series, an unnamed start goes to that series.

**Findings Oct 22:** the 4 voice notes Bee holds (Oct 21 evening) contain no command words, so test D is the first real-device test of the parser. On 20 likely phrasings (including "Okay, start...", "Starting...", "And coaching session" for a misheard "End", and "The brief:" for "Debrief:") the deployed parser gives the intended command.

**Works when:**
- With synthetic fixtures: start and end notes produce a session with exactly that span from the overlapping conversations; missing-half rules hold; a debrief, an agenda note and a takeaway note each file once; an unrecognized note is reported.
- On real data, a test run of "start session", a short conversation, "end session", "debrief: test" shows up in `get_last_session` with the marked times and the debrief, and the next brief confirms what was filed.
- A session with no markers is still found from the schedule window.
- With synthetic fixtures: "Start session: Acme interview" and a misheard "Akme interview" land in the same new, unscheduled series; an unnamed start with two series goes to "Other"; a lone start or a lone stop still produces a session.

### 4. Session tagging and review: best guesses you can correct (MVP)

**What it adds:** every meeting that looks like a session gets a tag (which series it belongs to), with a best guess when you didn't say. Sure guesses are filed; unsure ones wait in a review queue, and you confirm or retag them wherever you are. The product is honest about what it guessed, and you stay in control.

**Why it's in the MVP:** it closes the biggest gaps in [Meeting types](#meeting-types-reference): fake sessions from a sparse schedule slot (which close agenda items early and catch takeaways), an unnamed request going to the wrong series, and "Other" turning into a junk drawer.

**What you experience:**
- The brief and the digest open with "1 session to review" when the queue isn't empty, with the deadline when it's close: "the oldest expires in 3 days" (Bee keeps history for 14 days).
- In Claude Code, `/review` lists the queue: date, time, length, guessed tag, reason, and the last 4 characters of the Bee id.
- By voice (once Alexa works): "I found a 52-minute conversation Thursday at 4:05 PM and tagged it coaching. Is that right?" "No." "Was it therapy, an interview, something else, or not a session?" "An Acme interview." "Moved it to Acme interviews. Your Acme agenda has 2 open items." Spoken review gives date, time, length and tag only, never the summary.
- With the Bee button: "Retag: last session coaching", "That was Acme", "Not a session".
- Every retag reads back what changed, including agenda effects: "2 agenda items reopened."

**How a guess is made** (at collection time; nothing new in the tool path):

| Evidence | Example | Result |
| --- | --- | --- |
| Marker with a name | "Start session: coaching" | Certain: filed, no review |
| Marker without a name, several series | "Start session" | Filed under the best guess, and queued for review |
| Schedule slot plus a series keyword in Bee's short summary | The therapy slot, and "therapist" in the summary | High: filed |
| Schedule slot only, series has capture keywords | The coaching slot in an off week | Low: queued, not filed (no more fake sessions) |
| Schedule slot only, series has no capture keywords | A reliable weekly therapy slot | Filed as before, so a dependable slot doesn't need weekly review |
| Keyword only | "Acme" and "interview" in a 45-minute conversation | Low: queued |
| Pattern from past confirmations | The last 3 confirmed coaching sessions were Thursdays around 16:00 | Raises confidence |
| Optional: Nova Lite at collection time | Reads the short summary, returns a series and confidence | Breaks ties; never in the tool path |

Locations, utterances and calendar data are never used as evidence.

**Supports:** session detection for every meeting type, and through it the brief, last session, agenda openness, takeaways and digest. It also fixes the default-series problem: a request that names no series uses the only series, or the most recently ended session (takeaways, debriefs) or the next scheduled one (prep), always says which, and asks when it's unclear.

**Built from:**
- A tag on each session: `series`, `source` (marker, schedule, keyword, pattern, model, you), `confidence`, `status` (auto, pending, confirmed, rejected), a short `reason`, and the Bee conversation ids.
- A review queue: pending candidates, oldest first, with the date Bee drops each one.
- New tools `review_sessions` (lists the queue) and `retag_session` (id, and a series or "not a session"). Claude Code and the Alexa bridge both use them, so voice review comes free once Alexa works.
- A `review` MCP prompt, and the "N to review" line in `get_prep_brief` and `get_since_last_session`.
- Bee button commands "Retag: ...", "That was ...", "Not a session", in the same parser as the other voice-note commands, using the fuzzy series names.
- Retag moves the session's versions, takeaways and debrief to the new series in one DynamoDB transaction. This is the table's first delete path, so it ships together with `RemovalPolicy.RETAIN` and deletion protection.
- Learning, kept simple: a confirmation adds to the series' keywords and timing pattern; a rejection lowers confidence for that slot. After 3 confirmed sessions with a regular pattern, the product offers a schedule ("Coaching seems to be every other Thursday at 4. Use that?").

**Data stored:** a pending candidate keeps only its time, length, Bee ids and reason, no summary. On confirm, the collector fetches and keeps the summaries and insights like any session. A rejected id is remembered so it's never suggested again, with nothing else stored. The trade-off: a pending guess must be reviewed within Bee's 14-day window, hence the deadline in the review line.

**After Friday: review web app.** A small page on S3 and CloudFront: recent sessions with date, time, length, Bee id, tag, confidence and reason; a menu to change the tag; filters for pending and per series; an optional "show summary" per row. It needs a Cognito user pool (one user), because the MCP token can't go into browser code, so it waits until after the submission.

**Works when:**
- With synthetic fixtures: a schedule-only match in an off week is queued, not filed; a named marker is filed with no review; confirming fetches and stores the session; rejecting reopens the agenda items it had closed; retagging moves takeaways with the session; a rejected id is never queued again.
- On real data, the brief shows the review line with counts only, and one retag in Claude Code moves a session (checked by counts and ids).

### 5. Voice through Alexa, powered by Bedrock: asking without a screen

**What it adds:** the product works when you're walking to or from a session, where typing is the wrong interface.

**What you experience:**
- "Alexa, open Between Sessions" greets you with the menu: "You can ask for your prep brief, what's happened since last session, or add to your agenda. Your next session is Tuesday at 5."
- Answers are three sentences or fewer and end with "The full version is in Claude" when there's more.
- Every write is read back: "Added: the work trip."
- "Help" (Alexa's built-in help intent) gives the same menu.

**Supports:** prep brief, digest, agenda and takeaways by voice, through the same MCP tools you type to.

**Built from:**
- The Alexa skill bridge (classic Alexa skill, then a thin Lambda, then an agent on AgentCore Runtime, then this MCP server with its bearer token).
- **Bedrock:** Nova 2 Lite runs the agent: it chooses the tool and turns the answer into speech. (Sonnet 5.5 access was denied by AWS Support; Nova Lite and Nova 2 Lite were approved and are propagating to us-east-1.)
- AgentCore Memory off (privacy).
- **Not Bee's own Alexa integration.** Bee may restrict its Alexa integration on the free tier, but this path doesn't use it: it is our own development-stage skill reading data our collector already pulled through the Bee CLI, which works on the free tier.

**Data exposed:** same as the typed tools; answers are spoken aloud, so the brief's short form must be safe to hear in public (no verbatim content).

**Depends on:** Nova 2 Lite answering in us-east-1. **Status: cut for the submission (Thu Oct 22).** The quota hadn't arrived, so the same conversation is demoed typed in Claude Code, and voice moves to "next". `bee-agent` already has Nova 2 Lite invoke access, so the gates can resume as soon as the quota lands.

**Works when:**
- Locally (`npm run chat`), the scripted asks call the right tool, with typical turns of 4 s or less and none over the bridge's 6.5 s budget.
- In the Alexa simulator, then on the phone: open, "what can I ask?", "what's happened since my last session?", "add the work trip to my agenda".

**Gates** (start once a tiny Nova 2 Lite converse call succeeds; hard stop Thu Oct 22, 1pm ET, then fall back to the typed Claude Code demo):

| Gate | Question | Timebox | Pass |
| --- | --- | --- | --- |
| 1 | Does the bridge agent pick our tools correctly, fast enough? Run locally (`npm run chat`) against the deployed MCP | 1 h | 5 scripted asks (prep brief, last session, add agenda item, list agenda, save takeaway) call the right tool with the right arguments; typical turn 4 s or less, none over 6.5 s; spoken answers 3 sentences or fewer |
| 2 | Does it run in AgentCore? (`npm run chat -- --remote`) | 1.5 h | Matches Gate 1 |
| 3 | Does it work in Alexa? | 1.5 h | Works in the developer console simulator, then the Alexa app on the phone. The simulator alone is enough for the video |

Prerequisites: Node 22.18 or later; the bridge cloned into `vendor/` (git-ignored; its agent instruction files are untrusted); `.env` pointing at our MCP URL with the token taken from the secret name, never the value; Nova 2 Lite added to `bee-agent`'s Bedrock permissions; AgentCore Memory off; the kill switch extended to the bridge's Lambda prefix; Docker for Gate 2; the ASK CLI for Gate 3. Gate 0 (GPT-5.6 on bedrock-mantle) failed on Oct 21 with an account-level block; see [archive/BUILD_PLAN.md](archive/BUILD_PLAN.md).

## Small addition: "when is my next session"

The series config already has the weekday and start time, so the next session's date is computed, not stored. It appears in the prep brief, the digest and the Alexa greeting. It orients you instantly and costs almost nothing.

## Usability rules (apply to every capability)

1. **One vocabulary everywhere:** session, agenda, takeaway, since. The menu, Claude Code and Alexa use the same words.
2. **Every write is read back, every Bee button action is confirmed at the next touchpoint** (brief, digest, Alexa greeting), and every automatic addition can be undone.
3. **Short by default,** more on request.
4. **Say what's out of scope** instead of failing vaguely.
5. **Data rules hold:** tools read precomputed data in under 500 ms; no Bedrock in the tool path; no verbatim utterances; no locations, photos, email or calendar content.

## Not in this plan

- The six generic `bee_*` tools (facts, todos, today, day, insights, search) from the parked proposal.
- Live Bee calls from the MCP Lambda, and semantic (`--neural`) search.
- Writes to Bee (completing todos, editing facts).
- claude.ai / Claude mobile connector (needs Cognito OAuth).
- Review web app (after Friday; needs a Cognito user pool). See capability 4.
- Push delivery (brief the evening before a session, takeaway nudge after one). Strong idea for after Friday; needs a privacy decision because content would leave AWS.

## Open questions

| # | Question | How it gets answered |
| --- | --- | --- |
| 1 | ~~Do Bee journals work on Android?~~ | **Yes** (Oct 21 test; see capability 3) |
| 2 | Does a spoken reminder become a Bee todo or suggestion, and how fast? | Partly answered: it became a suggestion, not a todo. Timing still unmeasured |
| 3 | When does Nova 2 Lite answer in us-east-1? | Still 0 tokens per day on Thu Oct 22 morning (AWS Support case open). Alexa is cut for the submission; recheck after |
| 4 | Which keywords should a series' topics and capture use? | Start with `captureKeywords` in the series config; tune on real data |
| 5 | Is the short spoken brief safe to hear aloud in public? | Review the short form before the Alexa demo |
| 6 | Is a journal's `created_at` the moment you spoke, or when Bee finished processing it? Markers depend on it | Test A (compare with the phone-clock times) |
| 7 | How reliably are command words ("start", "end", "debrief", "agenda", "takeaway") transcribed? | Tests A and D; tune the forgiving matches |
| 8 | What maximum length closes a session that has a start marker but no end? | Default per series (for example 2 hours); revisit after real use |
| 9 | Which confidence levels file automatically, and which go to review? | Start with the evidence table in capability 4; tune on real data and the review answers |

## Decision log

| Date | Decision |
| --- | --- |
| Oct 21 | Parked the unified MCP proposal (six `bee_*` tools). Chose a focused digest instead. |
| Oct 21 | Priority: menu, then digest, then Bee as input. Alexa voice joins if Nova 2 Lite answers by Thu 1pm ET; otherwise the demo is typed in Claude Code. |
| Oct 21 | Journals work on Android. Bee as input files matching journals automatically and offers matching todo suggestions for confirmation. |
| Oct 21 | The Bee button is MVP: voice-note commands (agenda, takeaway, debrief) and session start/end markers together. Markers fix the flawed fixed-window session detection; the window stays only as a fallback. |
| Oct 21 | Hold-and-speak stays on Voice Notes (journals the CLI can read), not Voice Assistant. Double press is set to process the current conversation; bookmarks aren't in the API. |
| Oct 21 | Marked ad-hoc sessions are MVP: a series' schedule becomes optional, spoken series names are fuzzy-matched (new names create unscheduled series), and an "Other" series catches unnamed starts. Any session you mark is kept past Bee's 14-day window. |
| Oct 21 | Calendar ruled out as a session source: no calendar integration on Bee's free tier, and Bee Pro can't be purchased right now (in-app and Google Play). |
| Oct 21 | AWS Support denied Sonnet 5.5; approved Nova Lite and Nova 2 Lite (propagating). Bedrock's role is the Alexa agent model, plus optional topic naming at collect time. |
| Oct 21 | Session tagging and review is MVP: every session gets a tag with a best guess, unsure guesses wait in a review queue, and `review_sessions` and `retag_session` work in Claude Code, by Bee button and (once it works) by Alexa. Pending guesses store no summary until confirmed. The review web app waits until after Friday because it needs Cognito sign-in. |
| Oct 22 | Alexa voice is cut for the submission: every Nova tokens-per-day quota in us-east-1 was still 0 on Thursday morning, and Gates 1 to 3 couldn't finish before the 1pm ET hard stop. The demo is typed in Claude Code plus the Bee button. The MVP (menu, digest, Bee button, tagging and review, next session) and table protection are deployed. |
| Oct 22 | Reviewed the overnight build's defaults and kept them: command words need a session word or known series name; a named start for a new name creates an unscheduled series; two markers give an exact span; debriefs attach within 3 hours; unnamed starts go to the slot's series or Other, pending review; a series without capture keywords files its schedule slot as before; 48-hour receipts in every brief; a four-item spoken menu; a todo count, not todo text, in the digest. Changed one: "Not a session" never deletes your words; with no session before, takeaways and debriefs are kept under Other. |
