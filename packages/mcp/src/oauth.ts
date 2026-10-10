import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  auth,
  extractWWWAuthenticateParams,
  type AuthProvider,
  type OAuthClientProvider,
  type OAuthClientMetadata,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import type { SecretStore } from "@harness/secrets";
import type { McpOAuthConfig } from "./config.ts";
import {
  authFetch,
  decodeCredential,
  McpAuthRequired,
  McpRegistrationRequired,
  resolveValue,
} from "./credentials.ts";

const tokenSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string(),
    refresh_token: z.string().optional(),
    expires_in: z.number().positive().optional(),
    issuer: z.string().optional(),
  })
  .passthrough();
const clientSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
    issuer: z.string().optional(),
  })
  .passthrough();
const recordSchema = z.strictObject({ target: z.string(), value: z.unknown() });
export interface OAuthTarget {
  url: string;
  auth: McpOAuthConfig;
}
interface Attempt {
  target: OAuthTarget;
  discovery?: OAuthDiscoveryState;
  id: string;
  state: string;
  verifier?: string;
  url?: string;
  redirectUrl: string;
  server: Server;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

/** One server's OAuth owner. All refresh/login/logout mutations share its queue. */
export class McpOAuth {
  readonly #records: SecretStore;
  readonly #credentials: SecretStore;
  readonly #env: NodeJS.ProcessEnv;
  #attempt: Attempt | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #refresh = new Map<string, Promise<void>>();
  #loggingOut = false;
  #closed = false;
  #starting: AbortController | undefined;
  #callbackFailure = false;
  constructor(records: SecretStore, credentials: SecretStore, env: NodeJS.ProcessEnv) {
    this.#records = records;
    this.#credentials = credentials;
    this.#env = env;
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => {});
    return result;
  }
  async #read<T>(
    target: OAuthTarget,
    slot: string,
    schema: z.ZodType<T>,
    ignoreInvalid = false,
  ): Promise<T | undefined> {
    const raw = await this.#records.get(slot);
    if (raw === null) return undefined;
    try {
      const record = decodeCredential(raw, recordSchema);
      if (record.target !== this.#identity(target)) return undefined;
      return schema.parse(record.value);
    } catch {
      if (ignoreInvalid) return undefined;
      throw new McpAuthRequired();
    }
  }
  #identity(target: OAuthTarget): string {
    return JSON.stringify({
      url: target.url,
      auth: { ...target.auth, scopes: [...new Set(target.auth.scopes)].sort() },
    });
  }
  async #write(target: OAuthTarget, slot: string, value: unknown): Promise<void> {
    await this.#records.set(slot, JSON.stringify({ target: this.#identity(target), value }));
  }

  #provider(target: OAuthTarget, interactive: boolean): OAuthClientProvider {
    const metadata: OAuthClientMetadata = {
      client_name: "Harness",
      redirect_uris: [this.#attempt?.redirectUrl ?? "http://127.0.0.1/auth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: target.auth.clientSecret ? "client_secret_basic" : "none",
      ...(target.auth.scopes.length ? { scope: target.auth.scopes.join(" ") } : {}),
    };
    return {
      redirectUrl: this.#attempt?.redirectUrl ?? "http://127.0.0.1/auth/callback",
      clientMetadata: metadata,
      ...(interactive
        ? {
            discoveryState: () => this.#attempt?.discovery,
            saveDiscoveryState: (state: OAuthDiscoveryState) => {
              if (!this.#attempt) throw new McpAuthRequired();
              this.#attempt.discovery = state;
            },
          }
        : {}),
      ...(target.auth.clientMetadataUrl
        ? { clientMetadataUrl: target.auth.clientMetadataUrl }
        : {}),
      state: () => {
        if (!this.#attempt) throw new McpAuthRequired();
        return this.#attempt.state;
      },
      clientInformation: async () => {
        if (target.auth.clientId)
          return {
            client_id: target.auth.clientId,
            ...(target.auth.clientSecret
              ? {
                  client_secret: await resolveValue(
                    target.auth.clientSecret,
                    target.url,
                    this.#credentials,
                    this.#env,
                  ),
                }
              : {}),
          };
        const info = await this.#read(target, "client", clientSchema, interactive);
        if (!info && !interactive) throw new McpAuthRequired();
        return info;
      },
      saveClientInformation: (value) => this.#write(target, "client", value),
      tokens: () => this.#read(target, "tokens", tokenSchema, interactive),
      saveTokens: (value) => {
        if (interactive && (!this.#attempt || this.#attempt.controller.signal.aborted))
          throw new McpAuthRequired();
        return this.#write(target, "tokens", value);
      },
      redirectToAuthorization: (url) => {
        if (!interactive || !this.#attempt) throw new McpAuthRequired();
        this.#attempt.url = url.href;
      },
      saveCodeVerifier: (value) => {
        if (!this.#attempt) throw new McpAuthRequired();
        this.#attempt.verifier = value;
      },
      codeVerifier: () => {
        if (!this.#attempt?.verifier) throw new McpAuthRequired();
        return this.#attempt.verifier;
      },
      invalidateCredentials: async (scope) => {
        if (scope === "all" || scope === "tokens") await this.#records.delete("tokens");
        if (scope === "all" || scope === "client") await this.#records.delete("client");
      },
    };
  }
  authProvider(target: OAuthTarget): AuthProvider {
    return {
      token: async () => {
        if (this.#closed || this.#loggingOut) throw new McpAuthRequired();
        const tokens = await this.#read(target, "tokens", tokenSchema);
        if (!tokens) throw new McpAuthRequired();
        return tokens.access_token;
      },
      onUnauthorized: async ({ response }) => {
        if (this.#closed || this.#loggingOut || this.#attempt) throw new McpAuthRequired();
        const identity = this.#identity(target);
        let refresh = this.#refresh.get(identity);
        if (!refresh) {
          const challenge = extractWWWAuthenticateParams(response);
          refresh = this.#serialize(async () => {
            if (this.#closed) throw new McpAuthRequired();
            const tokens = await this.#read(target, "tokens", tokenSchema);
            if (!tokens?.refresh_token) throw new McpAuthRequired();
            const result = await auth(this.#provider(target, false), {
              serverUrl: target.url,
              ...challenge,
              fetchFn: authFetch,
            });
            if (result !== "AUTHORIZED") throw new McpAuthRequired();
          }).finally(() => {
            this.#refresh.delete(identity);
          });
          this.#refresh.set(identity, refresh);
        }
        await refresh;
      },
    };
  }

  get attemptId(): string | undefined {
    return this.#attempt?.id;
  }
  async status(
    target: OAuthTarget,
  ): Promise<{ authenticated: boolean; signingIn: boolean; failed: boolean }> {
    let authenticated = false;
    try {
      authenticated = !this.#closed && !!(await this.#read(target, "tokens", tokenSchema));
    } catch (error) {
      if (!(error instanceof McpAuthRequired)) throw error;
    }
    return { authenticated, signingIn: !!this.#attempt, failed: this.#callbackFailure };
  }
  async start(
    target: OAuthTarget,
    signal?: AbortSignal,
  ): Promise<{ attemptId: string; url: string; redirectUrl: string }> {
    signal?.throwIfAborted();
    if (this.#closed || this.#loggingOut || this.#attempt || this.#starting)
      throw new McpAuthRequired();
    const controller = new AbortController();
    this.#starting = controller;
    this.#callbackFailure = false;
    try {
      return await this.#start(
        target,
        AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]),
      );
    } finally {
      this.#starting = undefined;
    }
  }
  async #start(
    target: OAuthTarget,
    signal?: AbortSignal,
  ): Promise<{ attemptId: string; url: string; redirectUrl: string }> {
    if (this.#closed || this.#attempt) throw new McpAuthRequired();
    const id = randomUUID(),
      state = randomUUID();
    const server = createServer((request, response) => {
      const attempt = this.#attempt;
      if (!attempt) {
        response.writeHead(410).end();
        return;
      }
      const callback = new URL(request.url ?? "/", attempt.redirectUrl);
      if (callback.pathname !== "/auth/callback") {
        response.writeHead(404).end();
        return;
      }
      response.once("finish", () => {
        void this.complete(id, callback.href).catch(() => {
          this.#callbackFailure = true;
        });
      });
      response.end("Completing sign-in. Return to Harness to check status.");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (this.#closed || signal?.aborted) {
      server.close();
      server.closeAllConnections();
      throw new McpAuthRequired();
    }
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("OAuth callback listener has no address");
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void this.cancel(id);
    }, 300_000);
    this.#attempt = {
      target,
      id,
      state,
      server,
      controller,
      timer,
      redirectUrl: `http://127.0.0.1:${address.port}/auth/callback`,
    };
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.#serialize(() =>
        auth(this.#provider(target, true), {
          serverUrl: target.url,
          forceReauthorization: true,
          fetchFn: (input, init) => authFetch(input, { ...init, signal: controller.signal }),
        }),
      );
      const attempt = this.#attempt;
      if (!attempt?.url || controller.signal.aborted) throw new McpAuthRequired();
      return { attemptId: id, url: attempt.url, redirectUrl: attempt.redirectUrl };
    } catch (error) {
      await this.cancel(id);
      if (
        error instanceof Error &&
        error.message === "Incompatible auth server: does not support dynamic client registration"
      )
        throw new McpRegistrationRequired();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async complete(id: string, callbackUrl: string): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt || attempt.id !== id) throw new McpAuthRequired();
    const target = attempt.target;
    const callback = new URL(callbackUrl);
    const redirect = new URL(attempt.redirectUrl);
    if (
      callback.origin !== redirect.origin ||
      callback.pathname !== redirect.pathname ||
      callback.searchParams.get("state") !== attempt.state ||
      !callback.searchParams.get("code") ||
      callback.searchParams.has("error")
    )
      throw new McpAuthRequired();
    try {
      await this.#serialize(async () => {
        if (this.#attempt !== attempt || attempt.controller.signal.aborted)
          throw new McpAuthRequired();
        const result = await auth(this.#provider(target, true), {
          serverUrl: target.url,
          authorizationCode: callback.searchParams.get("code")!,
          ...(callback.searchParams.has("iss") ? { iss: callback.searchParams.get("iss")! } : {}),
          fetchFn: (input, init) =>
            authFetch(input, { ...init, signal: attempt.controller.signal }),
        });
        if (result !== "AUTHORIZED") throw new McpAuthRequired();
      });
    } finally {
      await this.cancel(id);
    }
  }
  async cancel(id: string): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt || attempt.id !== id) return;
    this.#attempt = undefined;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    // Do not await the current callback response while closing its listener.
    attempt.server.close();
    attempt.server.closeAllConnections();
  }
  async logout(): Promise<void> {
    this.#loggingOut = true;
    this.#starting?.abort();
    try {
      if (this.#attempt) await this.cancel(this.#attempt.id);
      await this.#serialize(async () => {
        await this.#records.delete("tokens");
        await this.#records.delete("client");
      });
    } finally {
      this.#loggingOut = false;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#starting?.abort();
    if (this.#attempt) await this.cancel(this.#attempt.id);
    await this.#tail;
  }
}
