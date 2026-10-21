// The collector's Bee CLI login lives in Secrets Manager as
// {relative path: base64 content} (see scripts/setup-bee-secret.sh). These
// helpers write it into BEE_CONFIG_DIR and read it back, so a token the CLI
// refreshed during a run can be saved. They never log file contents.
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export type ConfigFiles = Record<string, string>; // relative path -> base64

export async function writeConfigDir(root: string, files: ConfigFiles): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [rel, b64] of Object.entries(files)) {
    const path = resolve(root, rel);
    if (!path.startsWith(resolve(root) + sep)) throw new Error("Config path escapes the config dir");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.from(b64, "base64"), { mode: 0o600 });
    await chmod(path, 0o600);
  }
}

export async function readConfigDir(root: string): Promise<ConfigFiles> {
  const out: ConfigFiles = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out[relative(root, path)] = (await readFile(path)).toString("base64");
    }
  };
  await walk(root);
  return out;
}

// Paths whose content was added or changed (deletions don't matter: the CLI
// only removes files on logout).
export function changedPaths(before: ConfigFiles, after: ConfigFiles): string[] {
  return Object.keys(after).filter((k) => before[k] !== after[k]);
}
