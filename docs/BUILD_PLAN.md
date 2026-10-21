# Overnight build plan (Oct 20-21, 2026)

This plan is written for an unattended Claude Code session. It works through the phases in order, on its own branch, and records progress here: tick each box as it's done, then fill in the **Morning report** at the end. Before starting, read `CLAUDE.md` (constraints, secrets rules) and `README.md`.

## Ground rules (never break these)

- **Never push** to GitHub. Never merge into `main`. Commit to this worktree's branch after every phase (or sub-step that works), with a clear message and the attribution line from the system prompt.
- **Secrets:** never call `secretsmanager get-secret-value` or `batch-get-secret-value`, never print, log or commit a token, and never read `~/.aws`, the Keychain, or `.env` values. Application code may read secrets at runtime inside Lambda (that's its job); you may not.
- **Real Bee data:** never print, log or read real Bee content (summaries, insights, utterances) into the transcript. Verify real-data steps by counts, ids, dates and lengths only. Tests and examples use synthetic data only. **Bedrock runs on synthetic data only tonight**: deploy the Bedrock step disabled.
- **Personal details** (the user's schedule, series names, anything from `series.local.json`) never go into committed files. This repo is public.
- **AWS (updated Oct 21):** use only `AWS_PROFILE=bee-agent`, region `us-east-1`. It is the least-privilege role from `infra/bee-agent-access.yaml` (stack `BeeAgentAccess`), assumed from the user's `aws-admin` sign-in: it deploys only through the CDK bootstrap roles, reads stack outputs, invokes and reads logs of `between-sessions-*` functions, reads and writes the `between-sessions` table, sees secret metadata only (secret values are explicitly denied), and invokes the Sonnet 5.5 and Nova Lite profiles. CDK is already bootstrapped. Do not use `aws-admin` or `agent-toolkit` directly. The rules below that name `agent-toolkit` now mean `bee-agent`. You may run `cdk bootstrap` and `cdk deploy` for the `BetweenSessions` stack, and `aws lambda invoke` on its functions. Do not create, change or delete anything outside that stack, except the Bee secret, which the user created and the stack only reads. No em dashes in resource names or descriptions.
- **Don't stall.** Nobody can answer questions overnight. Take the default given here; if something isn't covered, pick the simplest option, note it in the Morning report, and continue. If a step fails twice, write down what happened, mark it ⚠️, and move on to the next step that doesn't depend on it. If a command is blocked by permissions, do the same.
- **Node 22:** prefix shell commands with `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` and use `corepack yarn`. Every Bee CLI call on macOS takes about 20s (Keychain stall), so avoid local `bee` calls except where a step needs them.

## Phase 0: Setup (about 10 min)

- [x] `corepack yarn install` in the worktree. `corepack yarn typecheck` passes.
- [x] Note what's missing in the worktree: git-ignored files (`.env`, `series.local.json`, `snapshots/`) live only in the main checkout at `<main checkout>`. You may read the main checkout's `series.local.json` for the seed step (Phase 3), but never copy it into the worktree's tracked files or print its contents. _(main checkout has .env, series.local.json, snapshots/; the worktree has none)_
- [x] _(Oct 21: `agent-toolkit` and `aws-admin` were expired; the user signed in to `aws-admin` as IAM user `admin`, and `bee-agent` was set up from it. CDK bootstrapped. The Bee secret does **not** exist yet.)_ Check AWS: `aws sts get-caller-identity --profile agent-toolkit` (print the ARN with the account id masked). The user may still be signing in when you start: if it fails, do Phases 1 to 3 first and check again before Phase 4. If `agent-toolkit` (IAM user `claude-agent`) is denied CloudFormation, Lambda, DynamoDB, Secrets Manager or Bedrock calls the stack needs, the user approved falling back to `--profile aws-admin --region us-east-1`, but only if its credentials already work. Never run `aws login` yourself, and never use the `fts-website` profile. Check the Bee secret exists with `aws secretsmanager describe-secret --secret-id between-sessions/bee-cli-config` (metadata only). If it doesn't exist, skip the real-data parts of Phase 4 and say so in the report.
- [x] Check Bedrock models available to the account (`aws bedrock list-foundation-models`, `aws bedrock list-inference-profiles`). Default model: an Anthropic Claude Sonnet inference profile if listed and invokable, else Amazon Nova Lite (latest). Record the choice. _(`us.anthropic.claude-sonnet-5-5` is listed and ACTIVE; chosen. Invocation not tested yet; fallback `us.amazon.nova-lite-v1:0`)_

## Phase 1: Tests for what exists (about 30 min)

- [x] Add a test runner: `node --import tsx --test` via a `test` script. No new framework.
- [x] Synthetic fixtures in `test/fixtures/` (made-up conversations and insights in the Bee JSON shapes from `src/bee/cli.ts`).
- [x] Tests for `matchSessions` (one part, split parts merged, conversations under `minOverlapMinutes` dropped, wrong weekday, timezone/DST edge) and `insightsAfter` (first batch only, none within window). _(plus a paging test for collectSnapshot against a fake bee CLI)_
- [x] Commit.

## Phase 2: Storage layer (about 45 min)

The cloud must not hold every Bee conversation. Store only what the tools need: matched sessions and their first insight batch.

- [x] `src/store/types.ts`: a `SessionStore` interface: `putSessionVersion(seriesId, session)`, `getLatestSession(seriesId)`, `listSessions(seriesId, limit)`, `addAgendaItem`, `listAgenda`, `saveTakeaway`, `listTakeaways`, `putPrepBrief`, `getPrepBrief`, `getSeries`, `putSeries`. _(plus `listSeries`)_
- [x] Session versions: write a new version only when the content hash (summary + insight ids) changes, so Bee's later rewrites are kept alongside the original. Each version records `collectedAt`.
- [x] `src/store/file-store.ts` (local, JSON under `snapshots/`, git-ignored, files 0600) and `src/store/dynamo-store.ts` (AWS SDK v3, `@aws-sdk/lib-dynamodb`). _(both wrap one `TableStore` in `table-store.ts`, so the file-store tests cover the Dynamo key logic)_
- [x] DynamoDB single-table layout: `PK = SERIES#<id>`; `SK = SESSION#<startISO>#V#<collectedAt>`, `LATEST#SESSION`, `AGENDA#<createdISO>#<uuid>`, `TAKEAWAY#<sessionStartISO>#<uuid>`, `BRIEF#<sessionStartISO>`, `CONFIG`. Series config lives in `CONFIG` items.
- [x] Refactor `src/mcp/server.ts` to take a `SessionStore` (local server uses the file store; the local collector writes sessions into it too). Existing `yarn collect` / `yarn check` keep working. _(typechecked; `collect` no longer writes the all-conversations snapshot file; not run end to end locally yet)_
- [x] Tests against the file store. Commit.

## Phase 3: More MCP tools (about 45 min)

Keep each tool's answer under 500 ms, reading precomputed data only.

- [x] `get_last_session` (exists; now from the store; include `parts`, `versions` count, and `collectedAt`).
- [x] `add_agenda_item {series?, text}`: something to bring up next session.
- [x] `list_agenda {series?}`: open agenda items. _("open" = added after the latest session started; no done flag)_
- [x] `save_takeaway {series?, text}`: the user's own takeaway, attached to the latest session.
- [x] `get_prep_brief {series?}`: the precomputed brief if there is one; otherwise a plain assembled brief (last session's date, short summary, insight titles, open agenda items, takeaways), with no Bedrock call.
- [x] Clear tool descriptions written for voice use (Alexa will read them). Tests. Commit. _(`test/mcp.test.ts`, in-memory MCP client)_
- [x] `scripts/seed-series.ts --file <path> --store dynamo|file`: writes series config to the store (`yarn seed`).
- [x] Run it from the main checkout's `series.local.json`. _(blocked overnight, since the headless session's sandbox refuses reads outside the worktree; run interactively on Oct 21)_

## Phase 4: AWS stack (about 2 h; includes the go/no-go)

CDK app in `infra/` (TypeScript, same package; add `aws-cdk-lib`, `constructs`, `aws-cdk` as dev deps and a `cdk` script). Stack `BetweenSessions`, `us-east-1`, tags `project=between-sessions`.

- [x] **DynamoDB** table `between-sessions`, on-demand, point-in-time recovery on, encryption AWS-owned, removal policy DESTROY (personal data should go away with the stack).
- [x] **Collector Lambda** _(`@beeai/cli@0.8.0` and `esbuild` added as dev deps so the binary and bundler come from the project; AWS SDK bundled, not taken from the runtime)_ (`src/aws/collector.ts`): Node 22, arm64, 1024 MB, 5 min timeout. Bundle with `NodejsFunction` (esbuild, no Docker) and copy the Bee CLI's `linux-arm64` binary (from the installed `@beeai/cli` package, `dist/platforms/linux-arm64/bee`) into the asset with a command hook. Env: `BEE_BIN=/var/task/bee`, `BEE_FORCE_FILE_STORE=1`, `BEE_CONFIG_DIR=/tmp/bee-config`, `HOME=/tmp`, `BEDROCK_NOTES_ENABLED=false`.
  - Startup: read secret `between-sessions/bee-cli-config` (JSON of `{relative path: base64 content}`, made by `scripts/setup-bee-secret.sh`), write those files into `BEE_CONFIG_DIR` with mode 0600.
  - Run: `collectSnapshot()`, match every series from `CONFIG`, write new session versions, update `LATEST#SESSION`.
  - After the run: if any file in `BEE_CONFIG_DIR` changed (the CLI refreshed its token), write the new set back with `PutSecretValue`.
  - Log only counts, durations and ids. Never log Bee content or file contents.
- [x] **EventBridge Scheduler**: every 15 minutes, invoking the collector. Create it **enabled**.
- [x] **Remote MCP Lambda** (`src/aws/mcp-handler.ts`) behind an **API Gateway HTTP API**, route `POST /mcp` (GET/DELETE return 405). Auth: bearer token compared in constant time with a CDK-generated secret `between-sessions/mcp-token` (`generateSecretString`, 48 chars, no punctuation). Stateless Streamable HTTP with JSON responses, like `src/local/mcp-http.ts`. Use the SDK's web-standard transport if `@modelcontextprotocol/sdk` has one; otherwise adapt the API Gateway event to Node `IncomingMessage`/`ServerResponse` objects. Reads DynamoDB only. 256 MB, 10 s timeout. Throttling: 10 requests/s, burst 20. _(uses `WebStandardStreamableHTTPServerTransport`; it has table write access too, because `add_agenda_item` and `save_takeaway` write)_
- [x] Stack outputs: MCP URL, table name, collector function name, secret names (not values).
- [x] `cdk synth` passes. Commit.
- [x] `cdk bootstrap aws://<account>/us-east-1` if the `CDKToolkit` stack doesn't exist. Then `cdk deploy --require-approval never`. _(already bootstrapped; deployed in 72 s)_
- [x] Seed series config into DynamoDB. _(blocked overnight, since the headless run couldn't read outside the worktree; run interactively on Oct 21: 1 series in DynamoDB and 1 in the file store)_
- [x] **Go/no-go: does the Bee CLI run in Lambda?** **Passed.** Overnight, one invoke read 107 conversations and 111 insights in 6.8 s (168 MB used), with 0 error lines in the logs. After the seed on Oct 21, one invoke read 109 conversations and 120 insights in 3.0 s and matched and wrote 2 sessions.
  - **If it fails:** try up to three fixes (missing shared libraries, `HOME`/permissions, binary not executable, timeout, the file store not being picked up). Still failing: write `src/bee/rest.ts` as the fallback, calling `https://api.developer.bee.amazon.dev/v1/conversations` and the insights path with the bearer token read inside the Lambda from the config files. If the token's location in those files is unclear, log only the JSON key names (never values) to find it. Timebox the fallback to 1 hour, then mark ⚠️ and continue.
- ⚠️ Remote MCP smoke test from the Mac: a script `scripts/check-remote.ts` that reads the MCP URL from stack outputs and the token **only via** `asm-exec` with `{{resolve:secretsmanager:between-sessions/mcp-token}}` substituted into an environment variable at runtime (never printed). Call `tools/list` and `get_last_session`, printing shape only. If `asm-exec` isn't installed, skip this, and write the exact command for the user to run in the morning. _(written as `yarn check:remote`; `asm-exec` isn't installed, so only the token-free half ran: no token and a wrong token both get 401, which also shows the Lambda loaded its token secret. The tool calls are left for the user.)_
- [x] Commit.

## Phase 5: Bedrock notes, synthetic only (about 1 h)

- [x] `src/notes/bedrock.ts`: Converse API. _(structured output through a forced `save_notes` tool, with a JSON-in-text fallback; `maxTokens` 1200)_ Inputs: one session (all parts' summaries), its first insight batch, takeaways and agenda. Outputs, as JSON:
  - a **session note** (under 200 words, second person, neutral, no diagnosis)
  - a **prep brief** for next session (3 to 5 bullet points to bring up, plus open agenda items)
  - the **relevant insight ids** (insights about the session vs. about the rest of the week)
- [x] Called by the collector only when a session version is new and `BEDROCK_NOTES_ENABLED=true`. Results stored as `BRIEF#...`. Leave it **disabled** in the deployed stack. _(`src/notes/briefs.ts`, latest session per series only; redeployed with `BEDROCK_NOTES_ENABLED=false`, confirmed on the function. Enable with `cdk deploy -c notes=true [-c bedrockModelId=...]`)_
- [x] `scripts/try-notes.ts`: runs the prompt on the synthetic fixture and prints the result (synthetic content may be printed). (`yarn try-notes [--model <id>] [--write docs/sample-note.md]`)
- ⚠️ Running it against Bedrock failed on account access, not code: Sonnet 5.5 returned `AccessDeniedException` ("not available for this account"), and Nova Lite returned `ThrottlingException` ("Too many tokens per day"). So there's no `docs/sample-note.md` yet. The prompt and parsing are covered by unit tests with a fake Converse.

## Phase 6: Docs (about 30 min)

- [x] README: architecture diagram (Mermaid: Bee → CLI in the collector Lambda → DynamoDB → MCP Lambda → API Gateway → assistants), "How it uses Bee data" (what's stored, what isn't), AWS setup steps (the secret script, deploy, connect Claude Code to the remote MCP), cost notes, and the local quickstart.
- [x] Friction log: add an entry for anything Bee-related that slowed you down tonight (format in `docs/FRICTION_LOG.md`; it's public, so keep it free of personal data). _(entry 17: CLI package size and no headless/Linux docs)_
- [x] Commit.

## Stretch (only if everything above is done)

- [x] `list_sessions {series?, limit}` tool (dates, durations and version counts only).
- [x] A CloudWatch alarm on collector errors (no notifications wired up). _(`between-sessions-collector-errors`, 2 or more errors in an hour)_
- [x] Tidy: remove dead code, make sure `yarn typecheck` and `yarn test` pass. _(39 tests pass)_

## Not tonight

Alexa bridge (needs the user's Amazon developer account and ASK CLI), Cognito OAuth, a web UI, document upload, and running Bedrock on real data.

## Morning report

Fill this in as the last step. List each phase as ✅ done, ⚠️ partial or ⏭️ skipped, with one line each. Then:

- the go/no-go result (Bee CLI in Lambda: yes or no, with the evidence as counts)
- what's deployed (stack outputs: names and URL only)
- decisions you made that the plan didn't cover
- the commands the user should run first thing (for example connecting Claude Code to the remote MCP, enabling Bedrock on real data)
- anything that needs the user's decision

_Filled in Oct 21, 2026, at the end of the overnight run on branch `claude/overnight-build-c2f0ca` (not pushed)._

### Phases

- ✅ **Phase 0, setup**: done earlier.
- ✅ **Phase 1, tests**: done earlier.
- ✅ **Phase 2, storage**: done earlier; typecheck and tests reconfirmed at the start of this run.
- ⚠️ **Phase 3, MCP tools**: all five tools, voice-friendly descriptions, tests and `yarn seed` are done. Seeding from `series.local.json` was blocked, because the sandbox refuses reads outside the worktree.
- ⚠️ **Phase 4, AWS stack**: deployed and working, and the go/no-go passed after the Oct 21 seed (2 sessions matched). Still open: the remote tool calls need the token, and `asm-exec` isn't installed.
- ⚠️ **Phase 5, Bedrock**: code, tests and the collector hook are done, deployed disabled. The one live run failed on account access: Sonnet 5.5 isn't enabled for the account, and Nova Lite hit its daily token quota. There's no `docs/sample-note.md`.
- ✅ **Phase 6, docs**: README (Mermaid architecture, data use, AWS setup, Claude Code connection, cost) and friction log entry 17.
- ✅ **Stretch**: `list_sessions` tool, collector error alarm, tidy (39 tests pass).

### Go/no-go: does the Bee CLI run in Lambda?

**Passed**, by counts:

- 2 manual invokes, each reading 107 conversations and 111 insights: 6.8 s cold, 2.4 s warm, 168 MB of 1024 MB used.
- 0 error lines in the collector logs. The scheduled runs also succeed.
- The file-store login from the secret worked as is; no token refresh has been needed yet (`configRefreshed: false`).
- Matched sessions: 0 overnight, only because no series config was in the table yet. After the seed on Oct 21, one invoke read 109 conversations and 120 insights in 3.0 s and matched and wrote 2 sessions (1 version each), with no error and no login refresh.
- The REST fallback (`src/bee/rest.ts`) wasn't needed.

### Deployed (stack `BetweenSessions`, us-east-1)

- `McpUrl`: https://<api-id>.execute-api.us-east-1.amazonaws.com/mcp
- `TableName`: `between-sessions`
- `CollectorFunctionName`: `between-sessions-collector` (EventBridge schedule `between-sessions-collector`, every 15 min, enabled)
- `McpFunctionName`: `between-sessions-mcp`
- `BeeSecretName`: `between-sessions/bee-cli-config` (yours; the stack only reads and refreshes it)
- `McpTokenSecretName`: `between-sessions/mcp-token` (generated by the stack)
- Alarm: `between-sessions-collector-errors` (no notifications)
- Collector: `BEDROCK_NOTES_ENABLED=false`, `BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5-5`

### Decisions the plan didn't cover

- The `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && ...` prefix was refused by the permission checker. The default `node` is already v22.23.3, so commands ran as plain `corepack yarn ...`.
- Added `@beeai/cli@0.8.0` (pinned) and `esbuild` as dev dependencies. The CLI was only installed globally, outside the worktree, and CDK's local bundling needs esbuild as a direct dependency.
- The AWS SDK is bundled into both Lambdas rather than taken from the runtime, so versions match the lockfile.
- The collector restores the Bee login from the secret on every run, not just on cold start, so the secret is always the source of truth. It writes changed files back even when the run fails after a refresh.
- The MCP Lambda can write to the table, because `add_agenda_item` and `save_takeaway` write. Session data stays collector-only by convention.
- An agenda item is "open" until a session starts after it was added; there's no done flag.
- Bedrock briefs are written only for the latest session per series, not for rewrites of older sessions. A Bedrock failure is counted and logged by error name, and never fails the run.
- Bedrock on/off and the model are CDK context (`-c notes=true`, `-c bedrockModelId=...`). The collector's IAM policy covers both Sonnet 5.5 and Nova Lite.
- The tool replies are JSON for data and short sentences for confirmations, so they read well aloud.
- Log groups are named `/aws/lambda/between-sessions-*` (so `bee-agent` can read them), kept for 2 weeks, and deleted with the stack.

### First commands to run (from this worktree)

1. _(Done Oct 21: seeded, and the go/no-go passed.)_ Seed the series and finish the go/no-go (the `bee-agent` profile can do both):
   ```bash
   corepack yarn seed --store dynamo --file <main checkout>/series.local.json
   corepack yarn seed --store file --file <main checkout>/series.local.json
   aws lambda invoke --function-name between-sessions-collector --cli-read-timeout 320 cdk.out/run.json && cat cdk.out/run.json
   ```
   Pass = `matched` of at least 1. The file prints counts only.
2. Connect Claude Code to the remote MCP. Use your admin profile, since `bee-agent` can't read secret values:
   ```bash
   TOKEN=$(aws secretsmanager get-secret-value --profile aws-admin --region us-east-1 \
     --secret-id between-sessions/mcp-token --query SecretString --output text)
   claude mcp add --transport http between-sessions https://<api-id>.execute-api.us-east-1.amazonaws.com/mcp \
     --header "Authorization: Bearer $TOKEN"
   MCP_TOKEN="$TOKEN" corepack yarn check:remote   # tools/list and get_last_session, shape only
   unset TOKEN
   ```
   With `asm-exec` installed, the smoke test can instead run as `MCP_TOKEN='{{resolve:secretsmanager:between-sessions/mcp-token}}' asm-exec -- corepack yarn check:remote`. I couldn't confirm that exact syntax, so check `asm-exec --help`.
3. Bedrock: in the Bedrock console, enable Claude Sonnet 5.5 for the account, or raise the Nova Lite tokens-per-day quota. Then try it on synthetic data and commit the sample:
   ```bash
   corepack yarn try-notes --write docs/sample-note.md                 # or --model us.amazon.nova-lite-v1:0
   ```

### Needs your decision

- Whether to turn Bedrock on for real data: `corepack yarn cdk deploy BetweenSessions --require-approval never -c notes=true` (add `-c bedrockModelId=us.amazon.nova-lite-v1:0` for Nova).
- Whether Sonnet 5.5 access or a Nova quota increase is the better route, given the deadline.
- `scripts/check-mcp.ts` prints the series name in its shape-only output. It runs only on your machine; say if you'd rather it print a length.
- Merging this branch into `main` and pushing; nothing has been pushed.
- The schedule is already running every 15 minutes. Until the seed runs it reads Bee and stores nothing.
