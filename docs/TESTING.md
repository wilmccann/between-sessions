# Testing Between Sessions

Four ways to try it, from no setup at all to a full deploy. Paths 1 and 2 need no Bee device, no AWS account and no tokens.

| Path | Needs | Time | What you see |
|---|---|---|---|
| [1. Read the real-device walkthrough](#1-read-the-real-device-walkthrough) | A browser | 5 min | One evening on a real Bee, with screenshots |
| [2. Run it on localhost with synthetic data](#2-run-it-on-localhost-with-synthetic-data) | Node 22.18+ | 10 min | The review page, Schedule page, MCP server and voice-note watcher, on made-up data |
| [3. Run it locally with your own Bee](#3-run-it-locally-with-your-own-bee) | A Bee device and the Bee CLI | 20 min | The same tools on your own data |
| [4. Deploy to AWS](#4-deploy-to-aws) | A Bee device and an AWS account | 30 min | The full product: collector every 15 minutes, remote MCP server |

## 1. Read the real-device walkthrough

These two pages show what the demo video shows, with screenshots from a real Bee on Thu Oct 22, 2026:
- [DEMO_FALLBACK.md](demo/DEMO_FALLBACK.md), as of 19:40: tutoring slots filed from the schedule alone, an off-topic conversation sent to review, and a voice command through the Bee button.
- [DEMO_FALLBACK_2.md](demo-2/DEMO_FALLBACK_2.md), as of 22:35: adds a canceled slot that stayed empty, and an unscheduled session started and ended by voice.

## 2. Run it on localhost with synthetic data

Everything here runs on your machine, binds to `127.0.0.1` only, and reads a made-up store plus a fake Bee CLI from the test fixtures. Nothing calls Bee or AWS.

### Set up

Requires Node 22.18 or later, with Corepack (it comes with Node).

```bash
git clone https://github.com/wilmccann/between-sessions.git
cd between-sessions
corepack yarn install
corepack yarn test         # 226 tests, synthetic data only
corepack yarn demo:seed    # writes snapshots/demo-store.json
```

`demo:seed` writes four made-up series with sessions, a review queue, voice notes, agenda items and a takeaway, all dated October 2026:
- Weekly therapy;
- Coaching;
- an Acme interview loop;
- Other.

Run it again at any time to start fresh.

### The review page and Schedule page

```bash
corepack yarn demo:review
```

Open the `http://127.0.0.1:8789/?token=...` link it prints. Then try:
- **Marty tab:**
  - the review queue (Confirm, Move, "Not a session");
  - series, sessions with their evidence tags, Bee button markers, voice notes and agenda items.

  Summaries stay hidden until you press "show". Edits write to the demo store only.
- **Bee data tab:** what the fake Bee CLI returns (conversations, insights, voice notes), and what Marty did with each. The search bar runs exact, keyword and semantic searches.
- **Schedule link** (top left):
  - edit a series' weekly slot, keywords and minimum length;
  - add a dated session;
  - see the calendar of slots and the session filed in each.

`demo:review` sets three variables for you:
- `STORE_FILE` points at the demo store.
- `BEE_BIN` swaps the real Bee CLI for the fake one.
- `BEE_DAYS=60` widens the Bee window from the default 14 days, because the fake data is dated October 2026. The maximum is 60, which covers the data until mid-December 2026.

### The MCP server

The quickest way is one command, which needs the [Claude Code](https://claude.com/claude-code) CLI:

```bash
corepack yarn demo:claude
```

It seeds the demo store if needed, starts the local MCP server with a token made for this run, and opens a new Claude Code session connected only to it, asking "What can I ask?". Type `/` for the prompts, or try "prep me for coaching". Quitting Claude stops the server.

To run the pieces yourself instead, start the local MCP server on the same store in a second terminal:

```bash
export MCP_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
corepack yarn demo:mcp
```

In a third terminal with the same `MCP_TOKEN`, list the tools and call a few:

```bash
corepack yarn local:check    # tools, prompts, and the shape of three answers
corepack yarn local:show     # the same calls, full content (all synthetic)
```

To ask it from Claude Code instead, with the same `MCP_TOKEN` in that shell:

```bash
claude mcp add --transport http between-sessions-demo http://127.0.0.1:8788/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

Then try "prep me for coaching" or "what's waiting for review?". The server's prompts (prep, since, agenda, takeaway, review, help) appear in the `/` menu.

### The voice-note watcher

The watcher follows `bee stream` and shows what Marty would do with each Bee button voice note. With the fake CLI, it replays a short synthetic stream every 5 seconds:

```bash
corepack yarn demo:watch
```

Look for `"Marty, test: start coaching session." -> Test: would be START, series coaching`. Stop it with Ctrl-C.

## 3. Run it locally with your own Bee

Needs a Bee device, and the [Bee CLI](https://www.npmjs.com/package/@beeai/cli) logged in with `bee login`. Follow [Run locally](../README.md#run-locally) in the README:
- describe your recurring sessions in `series.local.json`;
- `corepack yarn local:collect` reads recent Bee data into a local store;
- then use `local:review`, `local:mcp` and `local:watch`, the `local:` versions of the demo commands above.

Your data stays in `snapshots/` (git-ignored, readable only by you).

## 4. Deploy to AWS

Follow [Deploy to AWS](../README.md#deploy-to-aws) in the README. In short:
1. `scripts/setup-bee-secret.sh` puts a dedicated Bee CLI login in Secrets Manager.
2. `corepack yarn aws:deploy` deploys the collector (every 15 minutes), the DynamoDB table and the MCP server behind API Gateway.
3. `corepack yarn aws:seed --file series.local.json` writes your series.

Then connect Claude Code to the printed `McpUrl` (or open a session on it with `corepack yarn aws:claude`, see the README's [Connect Claude Code](../README.md#connect-claude-code)), and hold the Bee button: "Marty, agenda for <series>: …". The README's [cost section](../README.md#cost) lists what it costs and the optional guardrails.
