// Collector Lambda, run by EventBridge Scheduler every 15 minutes: restores
// the Bee CLI login from Secrets Manager, reads recent conversations and
// insights through the CLI, and stores new versions of matched sessions in
// DynamoDB. Logs counts, durations and ids only, never Bee content.
import { access, chmod, copyFile, constants } from "node:fs/promises";
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { recordSnapshot } from "../collector.js";
import { writeBriefs } from "../notes/briefs.js";
import { collectSnapshot } from "../sessions.js";
import { dynamoStore } from "../store/dynamo-store.js";
import { changedPaths, readConfigDir, writeConfigDir, type ConfigFiles } from "./bee-config.js";

const SECRET_ID = process.env.BEE_SECRET_ID ?? "between-sessions/bee-cli-config";
const CONFIG_DIR = process.env.BEE_CONFIG_DIR ?? "/tmp/bee-config";

const secrets = new SecretsManagerClient({});
const store = dynamoStore();

export interface CollectorResult {
  conversations: number;
  insights: number;
  series: number;
  matched: number;
  written: number;
  writtenSessions: { seriesId: string; start: string; versions: number }[];
  briefs: number;
  briefsFailed: number;
  configRefreshed: boolean;
  durationMs: number;
}

// The zip may not keep the execute bit, and /var/task is read-only.
async function ensureExecutable(): Promise<void> {
  const bin = process.env.BEE_BIN ?? "bee";
  if (!bin.startsWith("/")) return;
  try {
    await access(bin, constants.X_OK);
  } catch {
    await copyFile(bin, "/tmp/bee");
    await chmod("/tmp/bee", 0o755);
    process.env.BEE_BIN = "/tmp/bee";
  }
}

async function restoreLogin(): Promise<ConfigFiles> {
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  const files = JSON.parse(res.SecretString ?? "{}") as ConfigFiles;
  if (!Object.keys(files).length) throw new Error("The Bee config secret holds no files");
  await writeConfigDir(CONFIG_DIR, files);
  return files;
}

export async function handler(): Promise<CollectorResult> {
  const started = Date.now();
  await ensureExecutable();
  const before = await restoreLogin();

  let snapshot;
  let refreshed = false;
  try {
    snapshot = await collectSnapshot();
  } finally {
    // Save a refreshed token even if the run failed after refreshing it.
    const after = await readConfigDir(CONFIG_DIR);
    const changed = changedPaths(before, after);
    if (changed.length) {
      await secrets.send(new PutSecretValueCommand({ SecretId: SECRET_ID, SecretString: JSON.stringify(after) }));
      console.log(`bee config refreshed: ${changed.length} file(s) saved back to the secret`);
    }
    refreshed = changed.length > 0;
  }

  const series = await store.listSeries();
  const run = await recordSnapshot(store, series, snapshot);
  const notes =
    process.env.BEDROCK_NOTES_ENABLED === "true" && run.written.length
      ? await writeBriefs(store, run.written)
      : { briefs: 0, failed: 0 };
  const result: CollectorResult = {
    conversations: snapshot.conversations.length,
    insights: snapshot.insights.length,
    series: run.series,
    matched: run.matched,
    written: run.written.length,
    writtenSessions: run.written.map((v) => ({ seriesId: v.seriesId, start: v.start, versions: v.versions })),
    briefs: notes.briefs,
    briefsFailed: notes.failed,
    configRefreshed: refreshed,
    durationMs: Date.now() - started,
  };
  console.log(JSON.stringify({ msg: "collector run", ...result }));
  return result;
}
