import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { changedPaths, readConfigDir, writeConfigDir } from "../src/aws/bee-config.js";
import { makeHandler, type HttpEvent } from "../src/aws/mcp-handler.js";
import { fileStore } from "../src/store/file-store.js";
import { series } from "./fixtures/index.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("bee config files", () => {
  it("restores files 0600 and spots a refreshed one", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "bs-cfg-")), "bee-config");
    const before = { "config.json": b64('{"synthetic":true}'), "nested/token": b64("fake-1") };
    await writeConfigDir(root, before);
    assert.equal((await stat(join(root, "nested/token"))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(root, "config.json"), "utf8"), '{"synthetic":true}');
    assert.deepEqual(await readConfigDir(root), before);

    await writeFile(join(root, "nested/token"), "fake-2");
    const after = await readConfigDir(root);
    assert.deepEqual(changedPaths(before, after), ["nested/token"]);
    assert.deepEqual(changedPaths(before, before), []);
  });

  it("refuses paths outside the config dir", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "bs-cfg-")), "bee-config");
    await assert.rejects(writeConfigDir(root, { "../escape": b64("x") }));
  });
});

describe("remote MCP handler", async () => {
  const TOKEN = "synthetic-test-token-0123456789abcdef0123456789";
  const store = fileStore(join(await mkdtemp(join(tmpdir(), "bs-lambda-")), "store.json"));
  await store.putSeries(series);
  const handler = makeHandler(store, async () => TOKEN);

  const event = (method: string, body?: unknown, token = TOKEN): HttpEvent => ({
    rawPath: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method }, domainName: "example.test" },
  });

  it("rejects a wrong token and non-POST methods", async () => {
    assert.equal((await handler(event("POST", {}, "wrong"))).statusCode, 401);
    assert.equal((await handler(event("GET"))).statusCode, 405);
    assert.equal((await handler(event("DELETE"))).statusCode, 405);
  });

  it("answers initialize and tools/list statelessly", async () => {
    const init = await handler(
      event("POST", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    );
    assert.equal(init.statusCode, 200);
    assert.equal(JSON.parse(init.body ?? "").result.serverInfo.name, "between-sessions");

    const list = await handler(event("POST", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    assert.equal(list.statusCode, 200);
    const names = JSON.parse(list.body ?? "").result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("get_last_session") && names.includes("get_prep_brief"));
  });

  it("calls a tool", async () => {
    const res = await handler(
      event("POST", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_agenda", arguments: {} } }),
    );
    assert.equal(res.statusCode, 200);
    assert.match(JSON.parse(res.body ?? "").result.content[0].text, /agenda is empty/);
  });
});
