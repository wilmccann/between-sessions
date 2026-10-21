# Overnight build plan (Oct 20-21, 2026)

This plan is written for an unattended Claude Code session. It works through the phases in order, on its own branch, and records progress here: tick each box as it's done, then fill in the **Morning report** at the end. Before starting, read `CLAUDE.md` (constraints, secrets rules) and `README.md`.

## Ground rules (never break these)

- **Never push** to GitHub. Never merge into `main`. Commit to this worktree's branch after every phase (or sub-step that works), with a clear message and the attribution line from the system prompt.
- **Secrets:** never call `secretsmanager get-secret-value` or `batch-get-secret-value`, never print, log or commit a token, and never read `~/.aws`, the Keychain, or `.env` values. Application code may read secrets at runtime inside Lambda (that's its job); you may not.
- **Real Bee data:** never print, log or read real Bee content (summaries, insights, utterances) into the transcript. Verify real-data steps by counts, ids, dates and lengths only. Tests and examples use synthetic data only. **Bedrock runs on synthetic data only tonight**: deploy the Bedrock step disabled.
- **Personal details** (the user's schedule, series names, anything from `series.local.json`) never go into committed files. This repo is public.
- **AWS:** use only `AWS_PROFILE=agent-toolkit`, region `us-east-1`. You may run `cdk bootstrap` and `cdk deploy` for the `BetweenSessions` stack, and `aws lambda invoke` on its functions. Do not create, change or delete anything outside that stack, except the Bee secret, which the user created and the stack only reads. No em dashes in resource names or descriptions.
- **Don't stall.** Nobody can answer questions overnight. Take the default given here; if something isn't covered, pick the simplest option, note it in the Morning report, and continue. If a step fails twice, write down what happened, mark it ⚠️, and move on to the next step that doesn't depend on it. If a command is blocked by permissions, do the same.
- **Node 22:** prefix shell commands with `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` and use `corepack yarn`. Every Bee CLI call on macOS takes about 20s (Keychain stall), so avoid local `bee` calls except where a step needs them.

## Phase 0: Setup (about 10 min)

- [ ] `corepack yarn install` in the worktree. `corepack yarn typecheck` passes.
- [ ] Note what's missing in the worktree: git-ignored files (`.env`, `series.local.json`, `snapshots/`) live only in the main checkout at `<main checkout>`. You may read the main checkout's `series.local.json` for the seed step (Phase 3), but never copy it into the worktree's tracked files or print its contents.
- [ ] Check AWS: `aws sts get-caller-identity --profile agent-toolkit` (print the ARN with the account id masked). The user may still be signing in when you start: if it fails, do Phases 1 to 3 first and check again before Phase 4. If `agent-toolkit` (IAM user `claude-agent`) is denied CloudFormation, Lambda, DynamoDB, Secrets Manager or Bedrock calls the stack needs, the user approved falling back to `--profile aws-admin --region us-east-1`, but only if its credentials already work. Never run `aws login` yourself, and never use the `fts-website` profile. Check the Bee secret exists with `aws secretsmanager describe-secret --secret-id between-sessions/bee-cli-config` (metadata only). If it doesn't exist, skip the real-data parts of Phase 4 and say so in the report.
- [ ] Check Bedrock models available to the account (`aws bedrock list-foundation-models`, `aws bedrock list-inference-profiles`). Default model: an Anthropic Claude Sonnet inference profile if listed and invokable, else Amazon Nova Lite (latest). Record the choice.

## Phase 1: Tests for what exists (about 30 min)

- [ ] Add a test runner: `node --import tsx --test` via a `test` script. No new framework.
- [ ] Synthetic fixtures in `test/fixtures/` (made-up conversations and insights in the Bee JSON shapes from `src/bee/cli.ts`).
- [ ] Tests for `matchSessions` (one part, split parts merged, conversations under `minOverlapMinutes` dropped, wrong weekday, timezone/DST edge) and `insightsAfter` (first batch only, none within window).
- [ ] Commit.

## Phase 2: Storage layer (about 45 min)

The cloud must not hold every Bee conversation. Store only what the tools need: matched sessions and their first insight batch.

- [ ] `src/store/types.ts`: a `SessionStore` interface: `putSessionVersion(seriesId, session)`, `getLatestSession(seriesId)`, `listSessions(seriesId, limit)`, `addAgendaItem`, `listAgenda`, `saveTakeaway`, `listTakeaways`, `putPrepBrief`, `getPrepBrief`, `getSeries`, `putSeries`.
- [ ] Session versions: write a new version only when the content hash (summary + insight ids) changes, so Bee's later rewrites are kept alongside the original. Each version records `collectedAt`.
- [ ] `src/store/file-store.ts` (local, JSON under `snapshots/`, git-ignored, files 0600) and `src/store/dynamo-store.ts` (AWS SDK v3, `@aws-sdk/lib-dynamodb`).
- [ ] DynamoDB single-table layout: `PK = SERIES#<id>`; `SK = SESSION#<startISO>#V#<collectedAt>`, `LATEST#SESSION`, `AGENDA#<createdISO>#<uuid>`, `TAKEAWAY#<sessionStartISO>#<uuid>`, `BRIEF#<sessionStartISO>`, `CONFIG`. Series config lives in `CONFIG` items.
- [ ] Refactor `src/mcp/server.ts` to take a `SessionStore` (local server uses the file store; the local collector writes sessions into it too). Existing `yarn collect` / `yarn check` keep working.
- [ ] Tests against the file store. Commit.

## Phase 3: More MCP tools (about 45 min)

Keep each tool's answer under 500 ms, reading precomputed data only.

- [ ] `get_last_session` (exists; now from the store; include `parts`, `versions` count, and `collectedAt`).
- [ ] `add_agenda_item {series?, text}`: something to bring up next session.
- [ ] `list_agenda {series?}`: open agenda items.
- [ ] `save_takeaway {series?, text}`: the user's own takeaway, attached to the latest session.
- [ ] `get_prep_brief {series?}`: the precomputed brief if there is one; otherwise a plain assembled brief (last session's date, short summary, insight titles, open agenda items, takeaways), with no Bedrock call.
- [ ] Clear tool descriptions written for voice use (Alexa will read them). Tests. Commit.
- [ ] `scripts/seed-series.ts --file <path> --store dynamo|file`: writes series config to the store. Run it locally with the file store from the main checkout's `series.local.json`.

## Phase 4: AWS stack (about 2 h; includes the go/no-go)

CDK app in `infra/` (TypeScript, same package; add `aws-cdk-lib`, `constructs`, `aws-cdk` as dev deps and a `cdk` script). Stack `BetweenSessions`, `us-east-1`, tags `project=between-sessions`.

- [ ] **DynamoDB** table `between-sessions`, on-demand, point-in-time recovery on, encryption AWS-owned, removal policy DESTROY (personal data should go away with the stack).
- [ ] **Collector Lambda** (`src/aws/collector.ts`): Node 22, arm64, 1024 MB, 5 min timeout. Bundle with `NodejsFunction` (esbuild, no Docker) and copy the Bee CLI's `linux-arm64` binary (from the installed `@beeai/cli` package, `dist/platforms/linux-arm64/bee`) into the asset with a command hook. Env: `BEE_BIN=/var/task/bee`, `BEE_FORCE_FILE_STORE=1`, `BEE_CONFIG_DIR=/tmp/bee-config`, `HOME=/tmp`, `BEDROCK_NOTES_ENABLED=false`.
  - Startup: read secret `between-sessions/bee-cli-config` (JSON of `{relative path: base64 content}`, made by `scripts/setup-bee-secret.sh`), write those files into `BEE_CONFIG_DIR` with mode 0600.
  - Run: `collectSnapshot()`, match every series from `CONFIG`, write new session versions, update `LATEST#SESSION`.
  - After the run: if any file in `BEE_CONFIG_DIR` changed (the CLI refreshed its token), write the new set back with `PutSecretValue`.
  - Log only counts, durations and ids. Never log Bee content or file contents.
- [ ] **EventBridge Scheduler**: every 15 minutes, invoking the collector. Create it **enabled**.
- [ ] **Remote MCP Lambda** (`src/aws/mcp-handler.ts`) behind an **API Gateway HTTP API**, route `POST /mcp` (GET/DELETE return 405). Auth: bearer token compared in constant time with a CDK-generated secret `between-sessions/mcp-token` (`generateSecretString`, 48 chars, no punctuation). Stateless Streamable HTTP with JSON responses, like `src/local/mcp-http.ts`. Use the SDK's web-standard transport if `@modelcontextprotocol/sdk` has one; otherwise adapt the API Gateway event to Node `IncomingMessage`/`ServerResponse` objects. Reads DynamoDB only. 256 MB, 10 s timeout. Throttling: 10 requests/s, burst 20.
- [ ] Stack outputs: MCP URL, table name, collector function name, secret names (not values).
- [ ] `cdk synth` passes. Commit.
- [ ] `cdk bootstrap aws://<account>/us-east-1` if the `CDKToolkit` stack doesn't exist. Then `cdk deploy --require-approval never`.
- [ ] Seed series config into DynamoDB: `scripts/seed-series.ts --store dynamo --file <main checkout>/series.local.json`.
- [ ] **Go/no-go: does the Bee CLI run in Lambda?** `aws lambda invoke` the collector once. Pass = it reports a non-zero conversation count and at least one matched session, by count only. Read CloudWatch logs for errors (they hold no content by design).
  - **If it fails:** try up to three fixes (missing shared libraries, `HOME`/permissions, binary not executable, timeout, the file store not being picked up). Still failing: write `src/bee/rest.ts` as the fallback, calling `https://api.developer.bee.amazon.dev/v1/conversations` and the insights path with the bearer token read inside the Lambda from the config files. If the token's location in those files is unclear, log only the JSON key names (never values) to find it. Timebox the fallback to 1 hour, then mark ⚠️ and continue.
- [ ] Remote MCP smoke test from the Mac: a script `scripts/check-remote.ts` that reads the MCP URL from stack outputs and the token **only via** `asm-exec` with `{{resolve:secretsmanager:between-sessions/mcp-token}}` substituted into an environment variable at runtime (never printed). Call `tools/list` and `get_last_session`, printing shape only. If `asm-exec` isn't installed, skip this, and write the exact command for the user to run in the morning.
- [ ] Commit.

## Phase 5: Bedrock notes, synthetic only (about 1 h)

- [ ] `src/notes/bedrock.ts`: Converse API. Inputs: one session (all parts' summaries), its first insight batch, takeaways and agenda. Outputs, as JSON:
  - a **session note** (under 200 words, second person, neutral, no diagnosis)
  - a **prep brief** for next session (3 to 5 bullet points to bring up, plus open agenda items)
  - the **relevant insight ids** (insights about the session vs. about the rest of the week)
- [ ] Called by the collector only when a session version is new and `BEDROCK_NOTES_ENABLED=true`. Results stored as `BRIEF#...`. Leave it **disabled** in the deployed stack.
- [ ] `scripts/try-notes.ts`: runs the prompt on the synthetic fixture and prints the result (synthetic content may be printed). Run it once against Bedrock. Commit with a sample output in `docs/sample-note.md` (synthetic).

## Phase 6: Docs (about 30 min)

- [ ] README: architecture diagram (Mermaid: Bee → CLI in the collector Lambda → DynamoDB → MCP Lambda → API Gateway → assistants), "How it uses Bee data" (what's stored, what isn't), AWS setup steps (the secret script, deploy, connect Claude Code to the remote MCP), cost notes, and the local quickstart.
- [ ] Friction log: add an entry for anything Bee-related that slowed you down tonight (format in `docs/FRICTION_LOG.md`; it's public, so keep it free of personal data).
- [ ] Commit.

## Stretch (only if everything above is done)

- [ ] `list_sessions {series?, limit}` tool (dates, durations and version counts only).
- [ ] A CloudWatch alarm on collector errors (no notifications wired up).
- [ ] Tidy: remove dead code, make sure `yarn typecheck` and `yarn test` pass.

## Not tonight

Alexa bridge (needs the user's Amazon developer account and ASK CLI), Cognito OAuth, a web UI, document upload, and running Bedrock on real data.

## Morning report

Fill this in as the last step. List each phase as ✅ done, ⚠️ partial or ⏭️ skipped, with one line each. Then:

- the go/no-go result (Bee CLI in Lambda: yes or no, with the evidence as counts)
- what's deployed (stack outputs: names and URL only)
- decisions you made that the plan didn't cover
- the commands the user should run first thing (for example connecting Claude Code to the remote MCP, enabling Bedrock on real data)
- anything that needs the user's decision

_(not started)_
