// Remote MCP server: a Lambda behind an API Gateway HTTP API, route POST /mcp.
// Stateless Streamable HTTP with JSON responses, like src/local/mcp-http.ts,
// guarded by a bearer token from Secrets Manager. Reads DynamoDB only.
import { createHash, timingSafeEqual } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "../mcp/server.js";
import { dynamoStore } from "../store/dynamo-store.js";
import type { SessionStore } from "../store/types.js";

// The parts of an HTTP API (payload v2) event and result this handler uses.
export interface HttpEvent {
  rawPath: string;
  rawQueryString?: string;
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string }; domainName?: string };
}

export interface HttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function makeHandler(store: SessionStore, loadToken: () => Promise<string>) {
  let expected: Promise<Buffer> | undefined;

  return async (event: HttpEvent): Promise<HttpResult> => {
    const started = Date.now();
    const method = event.requestContext.http.method;
    const log = (status: number) => console.log(`${method} ${event.rawPath} ${status} ${Date.now() - started}ms`);
    const reply = (statusCode: number, headers?: Record<string, string>) => (log(statusCode), { statusCode, headers });

    expected ??= loadToken()
      .then(digest)
      .catch((err) => {
        expected = undefined; // retry on the next request
        throw err;
      });
    let want: Buffer;
    try {
      want = await expected;
    } catch (err) {
      console.error("token load failed:", (err as Error).message);
      return reply(500);
    }
    const header = event.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!timingSafeEqual(digest(presented), want)) return reply(401, { "WWW-Authenticate": "Bearer" });
    if (method !== "POST") return reply(405, { Allow: "POST" });

    const raw = event.body ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8").toString("utf8") : "";
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400);
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(event.headers)) if (v !== undefined) headers.set(k, v);
    const url = `https://${event.requestContext.domainName ?? "localhost"}${event.rawPath}${
      event.rawQueryString ? `?${event.rawQueryString}` : ""
    }`;
    const request = new Request(url, { method, headers, body: raw });

    const server = createMcpServer(store);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody: body });
      const out: HttpResult = {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
      log(out.statusCode);
      return out;
    } catch (err) {
      console.error("request failed:", (err as Error).message);
      return reply(500);
    } finally {
      await transport.close();
      await server.close();
    }
  };
}

const secrets = new SecretsManagerClient({});

export const handler = makeHandler(dynamoStore(), async () => {
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.MCP_TOKEN_SECRET_ID ?? "between-sessions/mcp-token" }),
  );
  const token = res.SecretString ?? "";
  if (token.length < 32) throw new Error("The MCP token secret is missing or too short");
  return token;
});
