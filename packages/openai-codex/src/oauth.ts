import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ProviderSignInError } from "@harness/protocol";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { platform } from "node:os";

// OAuth client + endpoints for the ChatGPT/Codex subscription flow. These mirror the
// official `openai/codex` CLI; the auth server is Ory Hydra (no OIDC discovery).
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_ORIGINATOR = "harness";

const SCOPE = "openid profile email offline_access";
// Hydra only allow-lists these redirect ports; an ephemeral port will not work.
const REDIRECT_PORTS = [1455, 1457] as const;
const AUTH_CLAIM = "https://api.openai.com/auth";
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

export interface PkceCodes {
  verifier: string;
  challenge: string;
}

/** PKCE S256: a random verifier and its SHA-256 challenge, both base64url. */
export function generatePkce(): PkceCodes {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizeUrl(input: {
  redirectUri: string;
  state: string;
  challenge: string;
  originator?: string;
}): string {
  const url = new URL(`${CODEX_ISSUER}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", input.state);
  url.searchParams.set("originator", input.originator ?? CODEX_ORIGINATOR);
  return url.toString();
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Epoch ms at which the access token expires. */
  expiresAt: number;
}

export interface ExchangeOptions {
  code: string;
  verifier: string;
  redirectUri: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function exchangeCode(opts: ExchangeOptions): Promise<OAuthTokens> {
  return tokenRequest(opts.fetch ?? fetch, opts.now ?? Date.now, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: opts.verifier,
  });
}

export function refreshTokens(opts: {
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<OAuthTokens> {
  return tokenRequest(opts.fetch ?? fetch, opts.now ?? Date.now, {
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: CODEX_CLIENT_ID,
  });
}

async function tokenRequest(
  fetchImpl: typeof fetch,
  now: () => number,
  body: Record<string, string>,
): Promise<OAuthTokens> {
  const response = await fetchImpl(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!response.ok) {
    throw new Error(
      `Codex token request failed (${response.status}): ${redact(await safeText(response))}`,
    );
  }
  const json = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof json.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.id_token !== "string"
  ) {
    throw new Error("Codex token response missing access_token/refresh_token/id_token");
  }
  const expiresIn =
    typeof json.expires_in === "number" ? json.expires_in : DEFAULT_TOKEN_TTL_SECONDS;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    expiresAt: now() + expiresIn * 1000,
  };
}

/** The ChatGPT account id, read from the access token's `chatgpt_account_id` auth claim. */
export function decodeAccountId(accessToken: string): string {
  const claim = decodeJwtPayload(accessToken)?.[AUTH_CLAIM];
  const accountId =
    typeof claim === "object" && claim !== null
      ? (claim as Record<string, unknown>)["chatgpt_account_id"]
      : undefined;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("Codex access token is missing the chatgpt_account_id claim");
  }
  return accountId;
}

/** The signed-in email, read from the id token; undefined when absent. */
export function decodeEmail(idToken: string): string | undefined {
  const email = decodeJwtPayload(idToken)?.["email"];
  return typeof email === "string" && email ? email : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface CallbackServer {
  /** The loopback redirect URI bound to the chosen allow-listed port. */
  redirectUri: string;
  /** Resolves with the authorization code, or rejects on a callback error/state mismatch. */
  waitForCode(): Promise<string>;
  /** Stops accepting callbacks and resolves after the listening socket has closed. */
  close(): Promise<void>;
}

/** Starts the loopback server that catches the OAuth redirect on an allow-listed port. */
export async function startCallbackServer(state: string): Promise<CallbackServer> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const reply = (status: number, message: string, onSent?: () => void): void => {
      res.statusCode = status;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // This is a one-shot callback server; keeping the browser connection alive would delay close.
      res.setHeader("Connection", "close");
      res.end(`<!doctype html><meta charset="utf-8"><p>${message}</p>`, onSent);
    };
    if (url.pathname !== "/auth/callback") {
      reply(404, "Not found.");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      reply(400, "State mismatch.", () => rejectCode(new Error("OAuth state mismatch")));
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      reply(400, "Sign-in could not be completed.", () =>
        rejectCode(new Error(`OAuth callback error: ${error}`)),
      );
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      reply(400, "Missing authorization code.", () =>
        rejectCode(new Error("OAuth callback missing authorization code")),
      );
      return;
    }
    reply(200, "Signed in to Codex. You can close this window.", () => resolveCode(code));
  });

  const port = await listenOnFirstFree(server, REDIRECT_PORTS);
  return {
    redirectUri: `http://localhost:${port}/auth/callback`,
    waitForCode: () => codePromise,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        // The terminal callback response has already flushed before waitForCode settles. Any
        // remaining browser connections belong to this one-shot server and must not delay exit.
        server.closeAllConnections();
      }),
  };
}

function listenOnFirstFree(server: Server, ports: readonly number[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (index: number): void => {
      const port = ports[index];
      if (port === undefined) {
        reject(
          new Error(
            `Codex login needs one of ports ${ports.join(", ")} free (redirect allow-list)`,
          ),
        );
        return;
      }
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") attempt(index + 1);
        else reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve(port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };
    attempt(0);
  });
}

/** Opens `url` in the platform browser, best-effort (failures are ignored; copy the URL). */
export function openBrowser(url: string): void {
  const os = platform();
  const windows = os === "win32";
  const command = os === "darwin" ? "open" : windows ? "cmd" : "xdg-open";
  const args = windows ? ["/d", "/s", "/c", `start "" "${url}"`] : [url];
  const child = spawn(command, args, {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
    ...(windows ? { windowsVerbatimArguments: true } : {}),
  });
  child.on("error", () => {});
  child.unref();
}

async function safeText(response: Response): Promise<string> {
  return response.text().catch(() => response.statusText);
}

function redact(text: string): string {
  return text.replace(
    /(access_token|refresh_token|id_token|code|code_verifier)=([^&\s"]+)/giu,
    "$1=<redacted>",
  );
}

const deviceCodeSchema = z.object({
  device_auth_id: z.string().min(1).max(512),
  user_code: z.string().min(1).max(128),
  interval: z
    .union([z.number(), z.string().regex(/^\d+$/u).transform(Number)])
    .pipe(z.number().int().positive().max(900)),
});
const deviceGrantSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
});

interface DeviceLoginOptions {
  fetch: typeof fetch;
  now: () => number;
  onUrl?: (url: string, userCode?: string) => void;
  signal?: AbortSignal;
}

/** Provider-hosted authorization for remote hosts; browser login remains a separate flow. */
export async function loginWithDeviceCode(opts: DeviceLoginOptions): Promise<OAuthTokens> {
  const lifetime = AbortSignal.timeout(15 * 60_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, lifetime]) : lifetime;
  try {
    return await authorizeDevice(opts, signal);
  } catch (error) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    if (lifetime.aborted)
      throw new ProviderSignInError("Device-code sign-in expired; start again.");
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new ProviderSignInError("Device-code sign-in request timed out; start again.");
    if (error instanceof TypeError && error.message === "fetch failed")
      throw new ProviderSignInError(
        "Could not reach device-code sign-in; check connectivity and try again.",
      );
    throw error;
  }
}

async function authorizeDevice(
  opts: DeviceLoginOptions,
  signal: AbortSignal,
): Promise<OAuthTokens> {
  const send: typeof fetch = (input, init) =>
    opts.fetch(input, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
  const request = (path: string, body: Record<string, string>) =>
    send(`${CODEX_ISSUER}/api/accounts/deviceauth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  signal.throwIfAborted();
  const response = await request("usercode", { client_id: CODEX_CLIENT_ID });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderSignInError(
      response.status === 404
        ? "Device-code sign-in is unavailable. Enable device-code authentication in your ChatGPT security or workspace settings."
        : `Device-code sign-in request failed (${response.status})`,
    );
  }
  const device = await parseDeviceResponse(response, deviceCodeSchema);
  opts.onUrl?.(`${CODEX_ISSUER}/codex/device`, device.user_code);
  for (;;) {
    signal.throwIfAborted();
    const result = await request("token", {
      device_auth_id: device.device_auth_id,
      user_code: device.user_code,
    });
    if (result.ok) {
      const grant = await parseDeviceResponse(result, deviceGrantSchema);
      const tokens = await exchangeCode({
        code: grant.authorization_code,
        verifier: grant.code_verifier,
        redirectUri: `${CODEX_ISSUER}/deviceauth/callback`,
        now: opts.now,
        fetch: async (input, init) => {
          const response = await send(input, init);
          if (!response.ok) {
            await response.body?.cancel();
            throw new ProviderSignInError(`Device-code token exchange failed (${response.status})`);
          }
          return response;
        },
      });
      signal.throwIfAborted();
      return tokens;
    }
    await result.body?.cancel();
    // These are the provider's pending-authorization responses.
    if (result.status !== 403 && result.status !== 404)
      throw new ProviderSignInError(`Device-code authorization failed (${result.status})`);
    await delay(device.interval * 1000, undefined, { signal });
  }
}

async function parseDeviceResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ProviderSignInError("Invalid device-code sign-in response.");
    throw error;
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new ProviderSignInError("Invalid device-code sign-in response.");
  return result.data;
}
