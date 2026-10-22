# Feature plan: baseline

Status: **baseline v1.1**, Oct 21, 2026 (v1.1 adds the Bee button with session markers to the MVP). The plan we work from for the Fri Oct 23 submission and after. Change it by editing this file; record decisions in [Decision log](#decision-log).

Related: [PROPOSAL_UNIFIED_MCP.md](PROPOSAL_UNIFIED_MCP.md) (parked; the review that led here), [BUILD_PLAN.md](BUILD_PLAN.md) (build steps and history).

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
| Walking to a session | "Alexa, give me my prep brief" | A spoken brief of three sentences or fewer | [Voice](#4-voice-through-alexa-powered-by-bedrock-asking-without-a-screen) + prep brief |
| Session starts | *(hold the Bee button)* "Start session" | The session's start is marked at that moment | [Bee button](#3-the-bee-button-capture-and-session-control-without-opening-anything-mvp) |
| Session ends | *(hold)* "End session", then *(hold)* "Debrief: ..." | The session is captured between your markers, with your debrief; the next brief confirms it | [Bee button](#3-the-bee-button-capture-and-session-control-without-opening-anything-mvp) |
| Right after | "Save a takeaway: delegate earlier" (or hold: "Takeaway: ...") | "Saved." | Voice or Bee button + takeaways |
| Before the next session | "Prep brief" | Last session, first-night insights, digest, agenda, takeaways, when the next session is | Prep brief, now richer |

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
- Asking "what can I ask?" (typed, or to Alexa) returns a menu short enough to speak: three or four items with one example each.
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
| D: combined | Thu Oct 22, 4pm (the test coaching slot; Fri is the spare) | Hold: "Start coaching session." Talk a few minutes. Hold: "End coaching session." Hold: "Debrief: ..." | Markers, debrief and timing together. Optional: seed a "coaching" series (Thu 16:00 to 17:00) first, so the window fallback is checked against the markers |

**Works when:**
- With synthetic fixtures: start and end notes produce a session with exactly that span from the overlapping conversations; missing-half rules hold; a debrief, an agenda note and a takeaway note each file once; an unrecognized note is reported.
- On real data, a test run of "start session", a short conversation, "end session", "debrief: test" shows up in `get_last_session` with the marked times and the debrief, and the next brief confirms what was filed.
- A session with no markers is still found from the schedule window.
- With synthetic fixtures: "Start session: Acme interview" and a misheard "Akme interview" land in the same new, unscheduled series; an unnamed start with two series goes to "Other"; a lone start or a lone stop still produces a session.

### 4. Voice through Alexa, powered by Bedrock: asking without a screen

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

**Depends on:** Nova 2 Lite answering in us-east-1. If it doesn't arrive in time, the same conversation is demoed typed in Claude Code, and voice moves to "next".

**Works when:**
- Locally (`npm run chat`), the scripted asks call the right tool, with typical turns of 4 s or less and none over the bridge's 6.5 s budget.
- In the Alexa simulator, then on the phone: open, "what can I ask?", "what's happened since my last session?", "add the work trip to my agenda".

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
- Push delivery (brief the evening before a session, takeaway nudge after one). Strong idea for after Friday; needs a privacy decision because content would leave AWS.

## Open questions

| # | Question | How it gets answered |
| --- | --- | --- |
| 1 | ~~Do Bee journals work on Android?~~ | **Yes** (Oct 21 test; see capability 3) |
| 2 | Does a spoken reminder become a Bee todo or suggestion, and how fast? | Partly answered: it became a suggestion, not a todo. Timing still unmeasured |
| 3 | When does Nova 2 Lite answer in us-east-1? | A tiny converse call before each work block |
| 4 | Which keywords should a series' topics and capture use? | Start with `captureKeywords` in the series config; tune on real data |
| 5 | Is the short spoken brief safe to hear aloud in public? | Review the short form before the Alexa demo |
| 6 | Is a journal's `created_at` the moment you spoke, or when Bee finished processing it? Markers depend on it | Test A (compare with the phone-clock times) |
| 7 | How reliably are command words ("start", "end", "debrief", "agenda", "takeaway") transcribed? | Tests A and D; tune the forgiving matches |
| 8 | What maximum length closes a session that has a start marker but no end? | Default per series (for example 2 hours); revisit after real use |

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
