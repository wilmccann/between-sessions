// Local stand-in for the DynamoDB table: every item in one git-ignored JSON
// file under snapshots/, readable only by you (0600).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TableStore, type Item, type Table } from "./table-store.js";

const DEFAULT_PATH = process.env.STORE_FILE ?? "snapshots/store.json";

class FileTable implements Table {
  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, Item>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, Item>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async get(pk: string, sk: string) {
    return (await this.load())[`${pk}|${sk}`];
  }

  async put(item: Item) {
    const items = await this.load();
    items[`${item.PK}|${item.SK}`] = item;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(items), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  async query(pk: string, prefix: string, { descending = false, limit = Infinity } = {}) {
    const items = Object.values(await this.load())
      .filter((i) => i.PK === pk && i.SK.startsWith(prefix))
      .sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0));
    if (descending) items.reverse();
    return items.slice(0, limit);
  }

  async scanSk(sk: string) {
    return Object.values(await this.load()).filter((i) => i.SK === sk);
  }
}

export function fileStore(path = DEFAULT_PATH): TableStore {
  return new TableStore(new FileTable(path));
}
