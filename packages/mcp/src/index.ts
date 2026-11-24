import {
  Client,
  StreamableHTTPClientTransport,
  SdkError,
  SdkErrorCode,
  OAuthError,
  OAuthClientFlowError,
  type JsonSchemaType,
  type Tool as McpTool,
  type Transport,
} from "@modelcontextprotocol/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { Agent } from "undici";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { createToolApproval } from "@harness/approval";
import {
  errorResult,
  imageContentsSchema,
  jsonValueSchema,
  type ContentBlock,
  type PluginDefinition,
  type Tool,
} from "@harness/protocol";
import type { SecretStore } from "@harness/secrets";
import {
  mcpConfigSchema,
  type McpConfig,
  type McpServerConfig,
  type McpTimeouts,
} from "./config.ts";
import { mcpStatusSchema } from "./client.ts";
import {
  authFetch,
  McpAuthRequired,
  McpUnavailable,
  McpCredentialUnavailable,
  resolveValue,
  scopedSecrets,
  storeCredential,
  targetIdentity,
} from "./credentials.ts";
import { McpOAuth, type OAuthTarget } from "./oauth.ts";
import type { z } from "zod";
export * from "./config.ts";
export * from "./client.ts";
export { McpAuthRequired, McpUnavailable } from "./credentials.ts";

type Status = z.infer<typeof mcpStatusSchema>;
interface Connection {
  client: Client;
  transport: Transport;
}
interface CatalogTool {
  serverId: string;
  name: string;
  rawName: string;
  description: string;
  readOnly: boolean;
  tool: Tool;
}

// Legacy MCP sends cancellation separately. Keep the request signal on HTTP auth
// retries too, so an expired tool call cannot be posted after credential refresh.
const toolRequest = new AsyncLocalStorage<AbortSignal>();
class HttpTransport extends StreamableHTTPClientTransport {
  override send(...[message, options]: Parameters<StreamableHTTPClientTransport["send"]>) {
    const signal = toolRequest.getStore();
    return super.send(
      message,
      signal && "id" in message
        ? {
            ...options,
            requestSignal: options?.requestSignal
              ? AbortSignal.any([signal, options.requestSignal])
              : signal,
          }
        : options,
    );
  }
}

export class McpRuntime {
  readonly config: McpConfig;
  readonly #secrets: SecretStore;
  readonly #env: NodeJS.ProcessEnv;
  // The operation signal owns the deadline, including silent HTTP responses longer than five minutes.
  readonly #http = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  readonly #connections = new Map<string, Connection>();
  readonly #catalog: CatalogTool[] = [];
  readonly #statuses = new Map<string, Status>();
  readonly #oauth = new Map<string, McpOAuth>();
  readonly #lifetime = new AbortController();
  readonly #operations = new Set<Promise<unknown>>();
  constructor(config: unknown, secrets: SecretStore, env: NodeJS.ProcessEnv = process.env) {
    this.config = mcpConfigSchema.parse(config);
    this.#secrets = secrets;
    this.#env = env;
  }
  ownsTool(name: string): boolean {
    return this.#catalog.some((tool) => tool.name === name);
  }
  tools(): Omit<CatalogTool, "tool">[] {
    return this.#catalog.map(({ serverId, name, rawName, description, readOnly }) => ({
      serverId,
      name,
      rawName,
      description,
      readOnly,
    }));
  }
  #store(id: string, namespace: "credential" | "oauth"): SecretStore {
    return scopedSecrets(this.#secrets, id, namespace);
  }
  #authTarget(config: McpServerConfig): OAuthTarget {
    if (config.transport.type !== "http" || config.transport.auth.type !== "oauth")
      throw new McpAuthRequired();
    return { url: targetIdentity(config.transport), auth: config.transport.auth };
  }
  #owner(id: string): McpOAuth {
    let owner = this.#oauth.get(id);
    if (!owner) {
      owner = new McpOAuth(this.#store(id, "oauth"), this.#store(id, "credential"), this.#env);
      this.#oauth.set(id, owner);
    }
    return owner;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    this.#lifetime.signal.throwIfAborted();
    return this.#track(work());
  }
  #track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation)).catch(() => {});
    return operation;
  }
  async initialize(
    signal?: AbortSignal,
    progress?: (message: string, completed: number, total: number) => void,
  ): Promise<void> {
    const enabled = Object.entries(this.config.servers).filter(([, server]) => server.enabled);
    const total = enabled.length;
    let completed = 0;
    if (total > 1) for (const [id] of enabled) progress?.(`Queued ${id} MCP`, completed, total);
    for (const [id, config] of Object.entries(this.config.servers)) {
      this.#statuses.set(id, this.#status(id, "disabled"));
      if (!config.enabled) continue;
      try {
        const limits = { ...this.config.timeouts, ...config.timeouts };
        const { connection, descriptors } = await this.#connect(
          id,
          config,
          signal,
          limits,
          (message) => progress?.(message, completed, total),
        );
        this.#connections.set(id, connection);
        const catalog: CatalogTool[] = [];
        const validator = new AjvJsonSchemaValidator();
        for (const descriptor of descriptors) {
          const name = `mcp_${id}_${descriptor.name}`;
          if (this.ownsTool(name) || catalog.some((tool) => tool.name === name))
            throw new McpUnavailable();
          let validate: ReturnType<typeof validator.getValidator<Record<string, unknown>>>;
          try {
            validate = validator.getValidator<Record<string, unknown>>(
              descriptor.inputSchema as JsonSchemaType,
            );
          } catch {
            throw new McpUnavailable();
          }
          const readOnly =
            descriptor.annotations?.readOnlyHint === true &&
            descriptor.annotations?.destructiveHint !== true;
          const tool: Tool = {
            name,
            description: `[${id}/${descriptor.name}] ${descriptor.description ?? descriptor.name}`,
            input: {
              kind: "json-schema",
              schema: descriptor.inputSchema,
              parse: (raw) => {
                const checked = validate(raw);
                if (!checked.valid) throw new Error("invalid MCP arguments");
                return raw;
              },
            },
            exposure: { direct: false, code: true },
            ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema } : {}),
            execute: async (args, ctx) => {
              const timeout = Math.ceil(limits.executionSeconds * 1000);
              const deadline = AbortSignal.timeout(timeout);
              try {
                const signal = AbortSignal.any([ctx.signal, deadline]);
                const result = await toolRequest.run(signal, () =>
                  connection.client.callTool(
                    { name: descriptor.name, arguments: args as Record<string, unknown> },
                    { signal, timeout },
                  ),
                );
                const images = imageContentsSchema.safeParse(
                  result.content
                    .filter((block) => block.type === "image")
                    .map((block) => ({
                      type: "image",
                      mediaType: block.mimeType,
                      data: block.data,
                    })),
                );
                if (!images.success)
                  return errorResult("MCP returned invalid or unsupported image content");
                const content: ContentBlock[] = [];
                let imageIndex = 0;
                for (const block of result.content) {
                  if (block.type === "text") {
                    content.push({ type: "text", text: block.text });
                  } else if (block.type === "image") {
                    content.push(images.data[imageIndex++]!);
                  } else {
                    return errorResult("MCP returned unsupported content");
                  }
                }
                const structured =
                  result.structuredContent === undefined
                    ? undefined
                    : jsonValueSchema.parse(result.structuredContent);
                return {
                  status: result.isError ? "error" : "ok",
                  forModel: content,
                  ...(structured === undefined ? {} : { structured }),
                };
              } catch (error) {
                if (ctx.signal.aborted) throw error;
                if (
                  deadline.aborted ||
                  (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout)
                )
                  return errorResult(
                    `${id} MCP tool ${descriptor.name} timed out after ${limits.executionSeconds} seconds (MCP tool execution limit).`,
                  );
                if (isExternal(error))
                  return errorResult(
                    error instanceof McpAuthRequired
                      ? error.message
                      : "MCP call failed; operation was not replayed",
                  );
                throw error;
              }
            },
          };
          catalog.push({
            serverId: id,
            name,
            rawName: descriptor.name,
            description: tool.description,
            readOnly,
            tool,
          });
        }
        this.#catalog.push(...catalog);
        this.#statuses.set(id, this.#status(id, "ready"));
      } catch (error) {
        await this.#connections.get(id)?.client.close();
        this.#connections.delete(id);
        if (signal?.aborted) throw error;
        if (!isExternal(error)) throw error;
        this.#statuses.set(
          id,
          this.#status(
            id,
            error instanceof McpAuthRequired ? "auth-required" : "unavailable",
            mcpFailureMessage(error),
          ),
        );
      }
      completed++;
      const status = this.#statuses.get(id)!;
      progress?.(
        `${id} MCP · ${status.status === "ready" ? "ready" : status.detail}`,
        completed,
        total,
      );
    }
  }
  #status(id: string, status: Status["status"], detail?: string): Status {
    return {
      id,
      status,
      detail:
        detail ??
        (status === "auth-required"
          ? "Credentials or sign-in required"
          : status === "unavailable"
            ? "MCP connection unavailable"
            : null),
      toolCount: this.#catalog.filter((tool) => tool.serverId === id).length,
      authenticated: status === "ready",
      signingIn: false,
      credentials: [],
    };
  }
  async statuses(config = this.config): Promise<Status[]> {
    return Promise.all(
      Object.entries(config.servers).map(async ([id, server]) => {
        const slots = new Set<string>();
        const sources =
          server.transport.type === "stdio"
            ? Object.values(server.transport.env)
            : [
                ...Object.values(server.transport.headers),
                ...(server.transport.auth.type === "bearer" ? [server.transport.auth.token] : []),
                ...(server.transport.auth.type === "oauth" && server.transport.auth.clientSecret
                  ? [server.transport.auth.clientSecret]
                  : []),
              ];
        for (const source of sources) if (source.type === "secret") slots.add(source.slot);
        const status =
          this.#statuses.get(id) ?? this.#status(id, server.enabled ? "unavailable" : "disabled");
        try {
          const authStatus =
            server.transport.type === "http" && server.transport.auth.type === "oauth"
              ? await this.#owner(id).status(this.#authTarget(server))
              : undefined;
          return {
            ...status,
            ...(authStatus
              ? {
                  authenticated: authStatus.authenticated,
                  signingIn: authStatus.signingIn,
                  ...(authStatus.failed ? { detail: "OAuth sign-in failed" } : {}),
                }
              : {}),
            credentials: await Promise.all(
              [...slots].map(async (slot) => {
                let present = false;
                try {
                  await resolveValue(
                    { type: "secret", slot },
                    targetIdentity(server.transport),
                    this.#store(id, "credential"),
                    this.#env,
                  );
                  present = true;
                } catch (error) {
                  if (!(error instanceof McpAuthRequired)) throw error;
                }
                return { slot, present };
              }),
            ),
          };
        } catch (error) {
          if (!(error instanceof McpCredentialUnavailable)) throw error;
          return {
            ...status,
            status: "unavailable" as const,
            detail: error.message,
            authenticated: false,
            signingIn: false,
            credentials: [...slots].map((slot) => ({ slot, present: false })),
          };
        }
      }),
    );
  }
  async #connect(
    id: string,
    config: McpServerConfig,
    signal: AbortSignal | undefined,
    limits: McpTimeouts,
    progress?: (message: string) => void,
  ): Promise<{ connection: Connection; descriptors: McpTool[] }> {
    const timeout = Math.ceil(limits.startupSeconds * 1000);
    const deadline = AbortSignal.timeout(timeout);
    const combined = AbortSignal.any([
      this.#lifetime.signal,
      deadline,
      ...(signal ? [signal] : []),
    ]);
    combined.throwIfAborted();
    progress?.(`Connecting to ${id} MCP`);
    const target = targetIdentity(config.transport),
      store = this.#store(id, "credential");
    let transport: Transport | undefined;
    let httpStatus: number | undefined;
    let stage = "initialization";
    const abort = () => {
      void transport?.close();
    };
    combined.addEventListener("abort", abort, { once: true });
    try {
      if (config.transport.type === "stdio") {
        const env = Object.fromEntries(
          await Promise.all(
            Object.entries(config.transport.env).map(
              async ([key, source]) =>
                [key, await resolveValue(source, target, store, this.#env, combined)] as const,
            ),
          ),
        );
        transport = new StdioClientTransport({
          command: config.transport.executable,
          args: config.transport.args,
          env,
          ...(config.transport.cwd ? { cwd: config.transport.cwd } : {}),
          stderr: "pipe",
        });
        (transport as StdioClientTransport).stderr?.on("data", () => {});
      } else {
        const settings = config.transport;
        const headers = new Headers();
        for (const [key, source] of Object.entries(settings.headers)) {
          const value = await resolveValue(source, target, store, this.#env, combined);
          if (/[\r\n\0]/u.test(value)) throw new McpAuthRequired();
          headers.set(key, value);
        }
        const auth = settings.auth;
        const bearerToken =
          auth.type === "bearer"
            ? await resolveValue(auth.token, target, store, this.#env, combined)
            : undefined;
        const authProvider =
          auth.type === "oauth"
            ? this.#owner(id).authProvider(this.#authTarget(config), (url, init) =>
                authFetch(
                  url,
                  {
                    ...init,
                    signal: AbortSignal.any([
                      this.#lifetime.signal,
                      AbortSignal.timeout(
                        Math.ceil(1000 * Math.max(limits.startupSeconds, limits.executionSeconds)),
                      ),
                      ...(init?.signal ? [init.signal] : []),
                    ]),
                  },
                  this.#http,
                ),
              )
            : auth.type === "bearer"
              ? { token: () => Promise.resolve(bearerToken) }
              : undefined;

        transport = new HttpTransport(new URL(settings.url), {
          ...(authProvider ? { authProvider } : {}),
          reconnectionOptions: {
            maxRetries: 0,
            maxReconnectionDelay: 0,
            initialReconnectionDelay: 0,
            reconnectionDelayGrowFactor: 1,
          },
          fetch: async (input, init) => {
            const url = typeof input === "string" ? input : input.href;
            const outgoing = new Headers(init?.headers);
            if (new URL(url).href === target)
              for (const [key, value] of headers) outgoing.set(key, value);
            const response = await authFetch(input, { ...init, headers: outgoing }, this.#http);
            httpStatus = response.ok ? undefined : response.status;
            return response;
          },
        });
      }
      const client = new Client(
        { name: "Harness", version: "0.0.0" },
        {
          capabilities: {},
          versionNegotiation: {
            mode: "auto",
            probe: {
              timeoutMs:
                config.transport.type === "http"
                  ? timeout
                  : Math.ceil(1000 * Math.min(limits.stdioProbeSeconds, limits.startupSeconds / 2)),
              maxRetries: 0,
            },
          },
        },
      );

      combined.throwIfAborted();
      await client.connect(transport, { signal: combined, timeout });
      httpStatus = undefined;
      stage = "tool discovery";
      progress?.(`Discovering tools on ${id} MCP`);
      const descriptors = (await client.listTools({}, { signal: combined, timeout })).tools;
      combined.throwIfAborted();
      if (descriptors.length > 1_000 || JSON.stringify(descriptors).length > 2_000_000)
        throw new McpUnavailable();
      return { connection: { client, transport }, descriptors };
    } catch (error) {
      await transport?.close();
      if (signal?.aborted || this.#lifetime.signal.aborted) throw error;
      if (deadline.aborted)
        throw new McpUnavailable(
          stage === "tool discovery"
            ? `${id} MCP connected, but tool discovery did not finish within the ${limits.startupSeconds}-second startup limit.`
            : `${id} MCP initialization timed out after ${limits.startupSeconds} seconds (startup limit).`,
        );
      if (error instanceof McpAuthRequired || error instanceof McpCredentialUnavailable)
        throw error;
      if (httpStatus !== undefined && isExternal(error))
        throw new McpUnavailable(`MCP ${stage} failed (HTTP ${httpStatus})`);
      if (isExternal(error)) {
        const code =
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          [
            "ENOENT",
            "ECONNREFUSED",
            "ECONNRESET",
            "EACCES",
            "EPERM",
            "ETIMEDOUT",
            "EPIPE",
          ].includes(error.code)
            ? ` (${error.code})`
            : "";
        throw new McpUnavailable(`MCP ${stage} failed${code}`);
      }
      throw error;
    } finally {
      combined.removeEventListener("abort", abort);
    }
  }
  async test(
    id: string,
    config: McpServerConfig,
    signal?: AbortSignal,
    defaults = this.config.timeouts,
  ): Promise<Status> {
    return this.#track(
      (async () => {
        try {
          const { connection, descriptors } = await this.#connect(id, config, signal, {
            ...defaults,
            ...config.timeouts,
          });
          try {
            return { ...this.#status(id, "ready"), toolCount: descriptors.length };
          } finally {
            await connection.client.close();
          }
        } catch (error) {
          if (signal?.aborted || !isExternal(error)) throw error;
          if (error instanceof McpCredentialUnavailable)
            return { ...this.#status(id, "unavailable"), detail: error.message };
          return this.#status(
            id,
            error instanceof McpAuthRequired ? "auth-required" : "unavailable",
            mcpFailureMessage(error),
          );
        }
      })(),
    );
  }
  async setCredential(
    id: string,
    config: McpServerConfig,
    slot: string,
    value: string,
  ): Promise<void> {
    await storeCredential(
      this.#store(id, "credential"),
      targetIdentity(config.transport),
      slot,
      value,
    );
  }
  async deleteCredential(id: string, slot: string): Promise<void> {
    await this.#store(id, "credential").delete(slot);
  }
  hasAttempt(attemptId: string): boolean {
    return [...this.#oauth.values()].some((owner) => owner.attemptId === attemptId);
  }
  async startAuth(id: string, config: McpServerConfig, signal?: AbortSignal) {
    return this.#track(this.#owner(id).start(this.#authTarget(config), signal));
  }
  async completeAuth(attemptId: string, callbackUrl: string): Promise<void> {
    const owner = [...this.#oauth.values()].find((owner) => owner.attemptId === attemptId);
    if (!owner) throw new McpAuthRequired();
    await this.#track(owner.complete(attemptId, callbackUrl));
  }
  async cancelAuth(attemptId: string): Promise<void> {
    const owner = [...this.#oauth.values()].find((owner) => owner.attemptId === attemptId);
    await owner?.cancel(attemptId);
  }
  async logout(id: string, config: McpServerConfig): Promise<void> {
    this.#authTarget(config);
    await this.#owner(id).logout();
  }

  plugin(): PluginDefinition {
    return {
      id: "mcp",
      configScope: "global",
      configSchema: mcpConfigSchema,
      create: (reader) => {
        const approve = createToolApproval(reader);
        return {
          id: "mcp",
          tools: () => this.#catalog.map((tool) => tool.tool),
          windowInstructions: async ({ toolNames }) => {
            const available = new Set(toolNames);
            const servers = [
              ...new Set(
                this.#catalog
                  .filter((tool) => available.has(tool.name))
                  .map((tool) => tool.serverId),
              ),
            ].sort();
            return servers.length
              ? [
                  {
                    type: "text",
                    text: `Available MCP servers: ${servers.join(", ")}. Search tool names and descriptions using these server names together with task keywords.`,
                  },
                ]
              : [];
          },
          toolMiddleware: () => [
            {
              id: "mcp",
              wrap: async (call, ctx, next) => {
                const tool = this.#catalog.find((tool) => tool.name === call.name);
                if (!tool) return next(call);
                const server = this.config.servers[tool.serverId]!;
                const category = tool.readOnly ? "readOnly" : "other";
                return approve(
                  (Object.hasOwn(server.tools, tool.rawName)
                    ? server.tools[tool.rawName]
                    : undefined) ??
                    server.defaults[category] ??
                    this.config.defaults[category],
                  call,
                  ctx,
                  next,
                );
              },
            },
          ],
        };
      },
    };
  }
  async close(): Promise<void> {
    this.#lifetime.abort();
    const results = await Promise.allSettled([
      ...[...this.#connections.values()].map(({ client }) => client.close()),
      ...[...this.#oauth.values()].map((owner) => owner.close()),
      ...this.#operations,
      this.#http.destroy(),
    ]);
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected" && !isExternal(r.reason),
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason as unknown),
        "MCP shutdown failed",
      );
  }
}
function isExternal(error: unknown): boolean {
  return (
    error instanceof McpAuthRequired ||
    error instanceof McpUnavailable ||
    error instanceof SdkError ||
    error instanceof OAuthError ||
    error instanceof OAuthClientFlowError ||
    (error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ECONNRESET", "EPIPE", "ECONNREFUSED", "ETIMEDOUT", "EACCES", "EPERM"].includes(
        String(error.code),
      ))
  );
}

export function mcpFailureMessage(error: unknown): string | undefined {
  if (error instanceof McpUnavailable) return error.message;
  if (error instanceof McpAuthRequired) return error.message;
  if (isExternal(error)) return "MCP authentication or connection failed";
  return undefined;
}
