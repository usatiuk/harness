import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface CapturedRequest {
  path: string;
  key: string;
  body: Record<string, unknown>;
}
export async function httpGateway(
  handler: (
    request: CapturedRequest,
    response: ServerResponse,
    raw: IncomingMessage,
  ) => void | Promise<void>,
) {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const captured = {
        path: request.url ?? "",
        key: String(request.headers.authorization ?? request.headers["x-api-key"] ?? "").replace(
          /^Bearer /,
          "",
        ),
        body: chunks.length
          ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
          : {},
      };
      requests.push(captured);
      await handler(captured, response, request);
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
export function sse(response: ServerResponse, events: unknown[], named = false): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events)
    response.write(
      `${named ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
    );
  response.end();
}
