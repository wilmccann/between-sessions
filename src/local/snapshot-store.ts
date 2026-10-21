// Local stand-in for the DynamoDB snapshot table: one git-ignored JSON file.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Snapshot } from "../sessions.js";

const PATH = process.env.SNAPSHOT_FILE ?? "snapshots/latest.json";

export async function readSnapshot(): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(PATH, "utf8")) as Snapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeSnapshot(snapshot: Snapshot): Promise<string> {
  await mkdir(dirname(PATH), { recursive: true, mode: 0o700 });
  await writeFile(PATH, JSON.stringify(snapshot), { mode: 0o600 });
  return PATH;
}
