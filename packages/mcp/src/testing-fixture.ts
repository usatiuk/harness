import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";

export const fixtureSchema = {
  type: "object" as const,
  properties: { value: { type: "string" }, mode: { enum: ["ok", "error", "image", "hold"] } },
  required: ["value"],
  additionalProperties: false,
  allOf: [{ if: { properties: { value: { const: "forbidden" } } }, then: false }],
};
export function fixtureServer(
  calls: unknown[] = [],
  hold?: (signal: AbortSignal) => Promise<void>,
) {
  const server = new McpServer({ name: "fixture", version: "1" });
  server.registerTool(
    "echo/with spaces",
    {
      inputSchema: fromJsonSchema<{ value: string; mode?: string }>(fixtureSchema),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args, ctx): Promise<CallToolResult> => {
      calls.push(args);
      if (args.mode === "hold") await hold?.(ctx.mcpReq.signal);
      if (args.mode === "image")
        return { content: [{ type: "image", mimeType: "image/png", data: "eA==" }] };
      return {
        content: [{ type: "text", text: args.value }],
        structuredContent: {
          value: args.value,
          env: process.env["FIXTURE_SECRET"] ?? null,
          cwd: process.cwd(),
        },
        ...(args.mode === "error" ? { isError: true } : {}),
      };
    },
  );
  server.registerTool(
    "mutate",
    { inputSchema: fromJsonSchema<{ value: string }>(fixtureSchema) },
    async (args) => {
      calls.push(args);
      return { content: [{ type: "text", text: "mutated" }] };
    },
  );
  return server;
}
/** Real HTTP boundary around the SDK's standard Request handler. */
export async function httpFixture(
  options: {
    before?: (
      request: IncomingMessage,
      response: ServerResponse,
      origin: string,
    ) => boolean | Promise<boolean>;
    hold?: (signal: AbortSignal) => Promise<void>;
    catalog?: (cursor?: string) => { tools: Tool[]; nextCursor?: string };
  } = {},
) {
  const calls: unknown[] = [];
  const requests: { url: string; authorization?: string; custom?: string }[] = [];
  const handler = createMcpHandler(() => {
    const fixture = fixtureServer(calls, options.hold);
    if (options.catalog)
      fixture.server.setRequestHandler("tools/list", (request) =>
        options.catalog!(request.params?.cursor),
      );
    return fixture;
  });
  let origin = "";
  const server = createServer((request, response) => {
    void (async () => {
      requests.push({
        url: request.url ?? "/",
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.headers["x-secret"] ? { custom: String(request.headers["x-secret"]) } : {}),
      });
      if (await options.before?.(request, response, origin)) return;
      const chunks: Buffer[] = [];
      for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const controller = new AbortController();
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const result = await handler.fetch(
        new Request(new URL(request.url ?? "/", origin), {
          method: request.method!,
          headers,
          signal: controller.signal,
          ...(body ? { body } : {}),
        }),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch((error: unknown) => {
      response.writeHead(500).end();
      console.error(error);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: `${origin}/mcp`,
    calls,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export async function oauthFixture(options: { dcr?: boolean; metadataClient?: boolean } = {}) {
  const registrations: Record<string, unknown>[] = [],
    exchanges: URLSearchParams[] = [];
  let validToken = "access-1",
    holdRefresh: (() => Promise<void>) | undefined;
  const fixture = await httpFixture({
    before: async (request, response, origin) => {
      const json = (value: unknown) =>
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
      const path = request.url!;
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["read"],
        });
        return true;
      }
      if (path.startsWith("/.well-known/oauth-authorization-server")) {
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(options.dcr === false ? {} : { registration_endpoint: `${origin}/register` }),
          ...(options.metadataClient ? { client_id_metadata_document_supported: true } : {}),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
        });
        return true;
      }
      if (path === "/register" || path === "/token") {
        const chunks: Buffer[] = [];
        for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        if (path === "/register") {
          const metadata = JSON.parse(body) as Record<string, unknown>;
          registrations.push(metadata);
          json({ ...metadata, client_id: "registered" });
        } else {
          const params = new URLSearchParams(body);
          exchanges.push(params);
          if (params.get("grant_type") === "refresh_token") await holdRefresh?.();
          json({
            access_token: validToken,
            token_type: "Bearer",
            refresh_token: `refresh-${exchanges.length}`,
            expires_in: 3600,
          });
        }
        return true;
      }
      if (path === "/mcp" && request.headers.authorization !== `Bearer ${validToken}`) {
        response
          .writeHead(401, {
            "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
        return true;
      }
      return false;
    },
  });
  return {
    ...fixture,
    registrations,
    exchanges,
    expire() {
      validToken = "access-2";
    },
    hold(work: () => Promise<void>) {
      holdRefresh = work;
    },
  };
}
