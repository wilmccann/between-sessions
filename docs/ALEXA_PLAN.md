# Alexa on Android: use cases, design and plan

Status: **proposal**, Nov 2, 2026. Covers the "Voice through Alexa" item in the feature plan's [Next](FEATURE_PLAN.md#next) list. If accepted, it replaces the bridge design in [capability 5](FEATURE_PLAN.md#5-voice-through-alexa-powered-by-bedrock-asking-without-a-screen) (Oct 21).

Target: the Alexa app on an Android phone (a Pixel 6a here), signed in to the same Amazon account as the Alexa developer account.

## Summary

- **Phase 1: a classic custom skill, "Between Sessions".** It stays in the development stage, so it never needs certification and only your account can use it. A new Lambda in the `BetweenSessions` stack answers it by calling the same tool code as the MCP server, against the same DynamoDB table. It works in the Android Alexa app today, needs no Bedrock model, no OAuth server and no public endpoint, and costs cents.
- **Phase 2 (optional): an Alexa+ MCP add-on.** Alexa+ now connects to MCP servers directly ([MCP Toolkit](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview)), so you could ask in free-form language through our existing server. It is in Preview, needs OAuth 2.1 in front of the server and answers within 500 ms, and Amazon's docs don't yet say it works in the phone app before certification. Start it only after the gates in [Phase 2](#phase-2-alexa-mcp-add-on).
- **Drop the October bridge** (classic skill, then a third-party Lambda, then a Strands agent on Nova 2 Lite in AgentCore, then our MCP server). Alexa+ now does the agent's job natively, and phase 1 covers the rest without a model.

## Using it on the phone

**Set up once:**
1. Install the Amazon Alexa app and sign in with the Amazon account that owns the Alexa developer account.
2. Set the app's language to English (United States). The skill's locale is en-US, and they must match.
3. Enable the skill: menu, Skills & Games, Your Skills, the **Dev** tab, Between Sessions, Enable to use. With Alexa+, Amazon's docs route this through the Alexa+ Store instead ([Test and Debug Your Skill](https://developer.amazon.com/en-US/docs/alexa/test/test-your-skill-overview.html)).
4. Optional: turn on hands-free in the app. The wake word only works while the phone is unlocked and the Alexa app is on screen.
5. Optional: make Alexa the default digital assistant (Settings, Apps, Default apps, Digital assistant app), so press-and-hold opens Alexa. This adds no wake word; "Hey Google" stays Google's.
6. Check Alexa's privacy settings (see [Privacy](#privacy)).

**Talking to it:** open Alexa (the app's Alexa button, hands-free in the app, or press-and-hold), then either open the skill and talk ("Alexa, open Between Sessions") or ask in one go ("Alexa, ask Between Sessions what's happened since my last session"). Earbuds keep the answers private.

## Use cases

Each answer is three sentences or fewer, ends with one suggested next step as a question, and reads back every write. Examples use synthetic series.

| # | Moment | You say | You hear | Tool | Phase |
|---|---|---|---|---|---|
| 1 | Any time | "Alexa, open Between Sessions" | What the Bee button filed lately ("Got it: 1 agenda item added"), when the next session is, and "You can ask for your prep brief, what's happened since last session, or add to your agenda." | receipts, `get_prep_brief` | 1 |
| 2 | Any time | "What can I ask?" / "Help" | The four-item spoken menu | `help` | 1 |
| 3 | Walking to a session | "Prep me for coaching" | "Last coaching was Tuesday: you talked about delegating. You have 2 agenda items, starting with the work trip. The full version is in Claude." | `get_prep_brief` | 1 |
| 4 | Mid-week | "What's happened since my last session?" | "It's been 5 days and 38 conversations. Sleep came up 3 times." | `get_since_last_session` | 1 |
| 5 | Planning | "When is my next session?" | "Coaching, Tuesday at 5 PM." | `get_prep_brief` | 1 |
| 6 | Before a session | "What did we cover last session?" | One-sentence paraphrase of Bee's first short summary, never the full summary | `get_last_session` | 1 |
| 7 | Mid-week | "Add the work trip to my agenda" | "Added to coaching: the work trip." | `add_agenda_item` | 1 |
| 8 | Before a session | "What's on my agenda?" | The count and up to three items, numbered | `list_agenda` | 1 |
| 9 | After the list | "Remove number two" | "Removed: the work trip." | `remove_agenda_item` | 1 |
| 10 | Right after a session | "Save a takeaway: delegate earlier" | "Saved for coaching: delegate earlier." | `save_takeaway` | 1 |
| 11 | Any time | "Which sessions need review?" | "One guess is waiting: a 52-minute conversation on Thursday, filed under coaching. It expires in 9 days." | `review_sessions` | 1 |
| 12 | After #11 | "That was an Acme interview" / "That wasn't a session" | Read-back of the move, after a yes/no confirmation | `retag_session` | 1b |
| 13 | Any time, phase 2 | Free-form ("Anything I should raise with my coach?") | Alexa+ picks the tools and phrases the answer | all tools | 2 |

**What Alexa won't do, and where it lives instead:**

| Not by Alexa | Why | Use instead |
|---|---|---|
| Start and end session markers | The Bee button marks the exact moment, hands-free, while you're wearing it | Bee button: "Marty, start session" |
| Debriefs | A debrief is a paragraph of free speech; Alexa's free-text slot is a short phrase | Bee button: "Marty, debrief: ..." |
| Reading summaries, insights or transcripts aloud | Privacy (answers are heard by anyone nearby) and length | Claude, or the review page |
| Schedule edits | Needs a form, not a sentence | `aws:review`, Schedule page |
| Anything else Bee knows | Out of scope | The boundary sentence: "I see your sessions, including any you mark with the Bee button. For anything else Bee knows, use the Bee app." |

**Where each capability is available:**

| Capability | Claude (typed) | Bee button | Alexa, phase 1 | Alexa+, phase 2 |
|---|---|---|---|---|
| Menu and help | ✅ | | ✅ | ✅ |
| Prep brief, next session | ✅ full | | ✅ short | ✅ short |
| Since last session | ✅ | | ✅ | ✅ |
| Last session | ✅ | | ✅ one sentence | ✅ |
| Agenda: add, list, remove | ✅ | add | ✅ | ✅ |
| Takeaway | ✅ | ✅ | ✅ | ✅ |
| Debrief | | ✅ | | |
| Session markers | | ✅ | | |
| Review: list | ✅ | | ✅ | ✅ |
| Review: retag, not a session | ✅ | ✅ | 1b, with confirmation | ✅ |

## Options considered

| | A. Classic custom skill (phase 1) | B. Alexa+ MCP add-on (phase 2) | C. October bridge (dropped) |
|---|---|---|---|
| How | Fixed phrases mapped to intents; our Lambda calls the tool code | Alexa+ is the MCP client of our server; free-form language | Skill, then a third-party Lambda, then a Strands agent on Nova 2 Lite in AgentCore, then our MCP server |
| Android Alexa app | Yes: dev-stage skills enable from Your Skills, Dev | Not documented: testing is the web simulator and "route your simulator session to a physical Alexa device" | Yes (as a classic skill) |
| Status | Generally available | Preview; the CLI installs from Amazon's CodeArtifact (`@alexa-ai/cli`, Node 24+) | Third-party code |
| Auth | Lambda invoke permission tied to the skill ID, plus an allowlist of your Alexa user ID; no public endpoint | OAuth 2.1 authorization code with PKCE, RFC 8414 and RFC 9728 metadata; no dynamic client registration; `client_credentials` "must not grant access to user-specific data" | Static bearer token to our MCP server |
| Model | None | Alexa+ | Nova 2 Lite on Bedrock |
| Time limit | About 8 s per response | Server round trip within 500 ms | 8 s, with the agent's model calls inside it |
| Moving parts | 1 Lambda, 1 skill package | Cognito, metadata routes, token checks, add-on package | Skill, Lambda, AgentCore runtime, model, our server |
| Cost | Cents | Cents, plus about $2 to $4 a month if the MCP Lambda needs provisioned concurrency for 500 ms | Model calls and AgentCore |

## Phase 1 design: classic custom skill

```mermaid
flowchart LR
  phone[Alexa app on Android] --> alexa[Alexa service<br/>speech to intent]
  alexa -->|skill ID checked| fn[Lambda<br/>between-sessions-alexa]
  fn --> tools[Same tool code as the MCP server<br/>src/mcp/tools]
  tools --> table[(DynamoDB<br/>between-sessions)]
  fn -->|speech, max 3 sentences| alexa
  claude[Claude Code] --> mcp[MCP Lambda] --> tools
```

**Skill package**, committed in `alexa/skill-package/`:
- `skill.json`: name "Between Sessions", invocation name "between sessions", locale en-US, endpoint the Alexa Lambda's ARN, no account linking, never submitted for certification.
- `interactionModels/custom/en-US.json`: the intents below. The `SERIES` slot type holds only generic values (therapy, coaching, interview, other). Your real series names and spoken names are loaded per session with dynamic entities (`Dialog.UpdateDynamicEntities` on launch, from `store.listSeries()`), so they never enter the public repo.

| Intent | Sample phrases | Slots | Calls |
|---|---|---|---|
| LaunchRequest | "open Between Sessions" | | receipts line, next session, menu |
| `AMAZON.HelpIntent` | "help", "what can I ask" | | `help` |
| `PrepBriefIntent` | "prep me", "give me my prep brief", "prep me for {series}" | `series` | `get_prep_brief` |
| `SinceLastSessionIntent` | "what's happened since my last session", "since my last {series} session" | `series` | `get_since_last_session` |
| `NextSessionIntent` | "when is my next session", "when's my next {series} session" | `series` | `get_prep_brief` (next session only) |
| `LastSessionIntent` | "what did we cover last session" | `series` | `get_last_session` |
| `AddAgendaItemIntent` | "add {item} to my agenda", "put {item} on my agenda" | `item` (`AMAZON.SearchQuery`) | `add_agenda_item` |
| `ListAgendaIntent` | "what's on my agenda" | `series` | `list_agenda` |
| `RemoveAgendaItemIntent` | "remove number {n}", "remove {item} from my agenda" | `n` (`AMAZON.NUMBER`), `item` | `remove_agenda_item` |
| `SaveTakeawayIntent` | "save a takeaway {takeaway}", "takeaway {takeaway}" | `takeaway` (`AMAZON.SearchQuery`) | `save_takeaway` |
| `ReviewIntent` | "which sessions need review" | | `review_sessions` |
| `RetagIntent` (1b) | "that was {series}", "that wasn't a session" | `series` | `retag_session`, after `AMAZON.YesIntent` |
| `AMAZON.FallbackIntent` | anything else | | the boundary sentence |
| Stop, Cancel, `AMAZON.NavigateHomeIntent` | | | ends the session |

When no series is named, the existing `chooseSeries` rules pick one, and the read-back always names it ("Added to coaching: ..."), so a wrong pick is heard and can be fixed. A free-text slot may not combine reliably with a series slot in one phrase; if the model build or testing shows that, the agenda and takeaway intents drop `{series}` and rely on the read-back.

**Code:**
- `src/alexa/handler.ts`: routes each request to a tool through `ToolDef.call(args, { store })`, the same path the review page uses. Checks that `session.application.applicationId` is our skill ID and that `context.System.user.userId` is on the allowlist; anything else gets a polite refusal and is not logged. Keeps the last list read in session attributes, so "remove number two" refers to what you heard.
- `src/alexa/speech.ts`: one renderer per tool view, from the JSON the tools already return. At most three sentences; numbers and dates spoken naturally; Bee text only as a one-line paraphrase of the short summary; writes read back; the tool's `next` hint becomes the reprompt, which keeps the session open for one more ask. SSML-escaped.
- `src/aws/alexa-handler.ts`: the Lambda entry point with `dynamoStore()`, like `mcp-handler.ts` without the token.
- No cards. Cards persist in the Alexa app's activity, so the skill sends speech only.
- Logs hold the intent name, the outcome and the duration, never slot values or speech.

**Infrastructure**, in `infra/stack.ts`:
- `fn("Alexa", "src/aws/alexa-handler.ts", ...)`: Node 22 on arm64, 256 MB, a 7 s timeout. Its name, `between-sessions-alexa`, is already covered by the kill switch's prefix.
- `table.grantReadWriteData(alexa)`, the same as the MCP Lambda.
- `alexa.addPermission(...)` for the principal `alexa-appkit.amazon.com` with `eventSourceToken` set to the skill ID, so only this skill can invoke it.
- The skill ID and allowed user IDs come from CDK context (`-c alexaSkillId=... -c alexaUserIds=...`) and are never committed. A stack output, `AlexaFunctionArn`, goes into `skill.json`'s endpoint.

**Commands**, following the `aws:`/`local:`/`demo:` naming:
- `demo:alexa`: runs a scripted conversation (every intent) through the handler on the synthetic demo store and prints what Alexa would say, with sentence counts. No Alexa or AWS needed.
- `aws:alexa-deploy`: deploys the skill package with the ASK CLI (`ask deploy --target skill-metadata`).
- `aws:alexa-dialog`: `ask dialog` against the development skill, to test real speech understanding by typing.

**Time and cost:** a warm DynamoDB-backed answer takes a few hundred milliseconds, and a cold start a second or two, well inside about 8 s. No model and no provisioned concurrency, so the cost is a few Lambda requests a day.

## Privacy

- **Heard aloud.** Answers come out of the phone's speaker unless you wear earbuds. That's why answers stay short and never read summaries, insights or transcripts.
- **Content leaves your AWS account.** What you say and what the skill answers pass through Amazon's Alexa service and can appear in Alexa's voice history. This is the same kind of decision as push delivery in the feature plan. Before using it with therapy content, set Alexa Privacy to not save voice recordings, and check what the activity history keeps.
- **Bee hears Alexa.** If you're wearing the Bee, it records the spoken answers as a conversation. That adds to "conversations since" and can bump topic counts in the digest. Earbuds avoid it; a later fix could ignore very short conversations in topic counts.
- **Only you.** A development-stage skill is available only to the developer's own Amazon account, and the Lambda also checks your Alexa user ID. On a shared Echo, a voice profile check (`person.personId`) would be needed too; phase 1 targets the phone only.

## Phase 2: Alexa+ MCP add-on

**Start only when all three gates pass** (about 1 hour):
1. Preview access: the Alexa AI CLI installs (`npm install -g @alexa-ai/cli` after the CodeArtifact login, on Node 24) and `alexa-ai configure` succeeds.
2. Your Amazon account has Alexa+ in the Android app.
3. A development-stage add-on is reachable from the phone, not only the web simulator. Test with a throwaway add-on on a public, no-data MCP server.

**Changes it needs:**
1. **OAuth 2.1 for the MCP server.** A Cognito user pool (sign-up off, one user) with an app client for Alexa (authorization code with PKCE S256) and scopes `mcp:tools` and `mcp:resources`. The API serves `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414). The MCP Lambda accepts either the static bearer token (Claude Code, as today) or a Cognito access token with the right scope and audience.
2. **500 ms round trip.** Measure p95 through API Gateway; if cold starts miss it, add provisioned concurrency of 1 to the MCP Lambda.
3. **Tool results** add `structuredContent` next to the text, and tool descriptions get a pass against Amazon's [MCP design guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-design-guide).
4. **The add-on package** (`alexa-ai new mcp`, `addon.json`): name, descriptions, 3 or 4 example phrases, icons, a carousel image, and privacy policy and terms URLs (simple pages in this repo).
5. **No certification** while it's for your own use, if gate 3 shows the development stage is enough.

**Side benefit:** the same Cognito OAuth unblocks the claude.ai and Claude mobile connector, another item on the Next list.

## Implementation plan

**Phase 0: checks before building** (about 1 hour)

| Step | Done when |
|---|---|
| Phone: Alexa app signed in to the developer account, English (US); note whether it's Alexa+ | Recorded in this doc |
| Hello-world custom skill (console template), enabled from the Dev tab | "Alexa, open hello test" answers on the phone, including on Alexa+ |
| Alexa Privacy settings | Recordings not saved |
| ASK CLI: `npm install -g ask-cli`, `ask configure` (Login with Amazon) | `ask smapi list-skills-for-vendor` works |

**Phase 1** (about 1.5 to 2 days)

| # | Step | Files | Done when |
|---|---|---|---|
| 1 | Speech renderers, with tests on synthetic data | `src/alexa/speech.ts`, `test/alexa-speech.test.ts` | Every tool view renders in at most 3 sentences; writes read back; no Bee text beyond one paraphrased sentence |
| 2 | Handler: routing, skill and user checks, session attributes | `src/alexa/handler.ts`, `test/alexa-handler.test.ts`, `test/fixtures/alexa/*.json` (synthetic requests) | Every intent answers; a wrong skill ID or unknown user is refused; Fallback gives the boundary sentence |
| 3 | `demo:alexa` scripted conversation | `scripts/alexa-demo.ts`, `package.json` | Prints a full conversation on the demo store |
| 4 | Interaction model and skill manifest | `alexa/skill-package/` | `ask deploy --target skill-metadata` builds the model without errors |
| 5 | Lambda, skill permission and output in the stack | `infra/stack.ts`, `src/aws/alexa-handler.ts` | `aws:deploy -c alexaSkillId=... -c alexaUserIds=...` deploys; only the skill can invoke the function |
| 6 | Skill endpoint and dialog test | `alexa/skill-package/skill.json`, `aws:alexa-deploy`, `aws:alexa-dialog` | Use cases 1 to 11 pass in `ask dialog` |
| 7 | On the phone | | Use cases 1 to 11 pass by voice; note misheard phrases and add samples |
| 8 | Docs | README (an "Alexa" section and the Who runs what table), `docs/TESTING.md`, feature plan capability 5 and Next | A new reader can set it up from the README |
| 9 | Phase 1b: retag by voice, with confirmation | handler, model, tests | Use case 12 passes, and "no" changes nothing |

**Phase 2** (about 2 to 3 days, only after its gates): Cognito and metadata routes, token checks in the MCP Lambda, latency measurement, the add-on package, simulator tests, phone tests.

**Works when:** on the phone, with the Bee button and Claude unchanged, "Alexa, ask Between Sessions to prep me" answers in under about 3 seconds with at most three sentences, and "add the work trip to my agenda" shows up in Claude's `list_agenda` straight away.

## Open questions

| # | Question | How it gets answered |
|---|---|---|
| 1 | Does a development-stage classic skill still open on an account with Alexa+? | Phase 0 hello-world test |
| 2 | Can an agenda phrase carry both a free-text item and a series name? | Model build in step 4, and phone tests in step 7 |
| 3 | What does Alexa's activity history keep of the skill's answers, and can it be turned off? | Check Alexa Privacy after the first test |
| 4 | Can a development-stage Alexa+ add-on be used from the phone without certification? | Phase 2 gate 3 |
| 5 | Does Cognito accept the `resource` parameter (RFC 8707) that MCP clients send, and can the metadata live on our API's domain? | A spike against a test user pool before phase 2 step 1 |
| 6 | Does the MCP Lambda stay within 500 ms including cold starts? | p95 measurement in phase 2 |
| 7 | Does hands-free in the Alexa app work on this phone with the current app version? | Phase 0 |

## Sources

- [Alexa+ MCP Toolkit overview](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview) and [quickstart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart): Streamable HTTP, MCP 2025-11-25, 500 ms, OAuth requirements.
- [Alexa+ MCP authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication): the two auth tiers, scopes, what's not supported.
- [Test your MCP add-ons](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-test-add-ons) and [client lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html).
- [Set up your development environment](https://developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment): Node 24+, `@alexa-ai/cli`.
- [Alexa+ launches new ways to build experiences](https://developer.amazon.com/alexaplus/blogs/2026/07/alexa-plus-new-ways-to-build-experiences) (July 2026): "currently available in Preview".
- [Test and Debug Your Skill](https://developer.amazon.com/en-US/docs/alexa/test/test-your-skill-overview.html): enabling a development skill in the Alexa app.
- Hands-free in the Alexa app on Android: [Android Central](https://androidcentral.com/you-can-now-use-amazon-alexa-hands-free-android-phones), [TechCrunch](https://techcrunch.com/2020/07/07/amazon-adds-hands-free-alexa-to-its-alexa-mobile-app/); default assistant: [How-To Geek](https://www.howtogeek.com/351554/how-to-set-alexa-as-your-default-digital-assistant-on-android/). These are older articles; phase 0 checks them on the phone.
