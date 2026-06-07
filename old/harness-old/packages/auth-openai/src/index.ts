import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { platform } from "node:os";
import { Entry } from "@napi-rs/keyring";

export const SOURCE_FIRST_MARKER = "auth-openai:src";
export const OPENAI_CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTH_ISSUER = "https://auth.openai.com";
export const OPENAI_CHATGPT_AUTH_KIND = "openai_chatgpt_oauth";
export const OPENAI_CHATGPT_KEYRING_SERVICE = "Harness Auth";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const FALLBACK_TOKEN_TTL_MS = 60 * 60 * 1000;
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const SENSITIVE_KEYS = new Set(["access_token", "refresh_token", "id_token", "code", "state", "code_verifier", "authorization", "authorization_code"]);

export interface OpenAIChatGptSession {
  version: 1;
  kind: typeof OPENAI_CHATGPT_AUTH_KIND;
  issuer: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  createdAt: string;
  updatedAt: string;
  lastRefreshAt?: string;
  email?: string;
  planType?: string;
  workspaceId?: string;
}

export interface OpenAIChatGptAuthStatus {
  authenticated: boolean;
  storage: "keyring";
  accountId?: string;
  email?: string;
  planType?: string;
  workspaceId?: string;
  expiresAt?: string;
}

export interface OpenAIAuthStore {
  loadActive(): Promise<OpenAIChatGptSession | undefined>;
  saveActive(session: OpenAIChatGptSession): Promise<void>;
  deleteActive(): Promise<boolean>;
}

export interface SecretEntry {
  getPassword(): string | null | Promise<string | null>;
  setPassword(password: string): void | Promise<void>;
  deletePassword(): boolean | void | Promise<boolean | void>;
}

export interface SecretEntryFactory {
  entry(service: string, account: string): SecretEntry;
}

export interface OpenAIChatGptAuthManagerOptions {
  harnessHome: string;
  store?: OpenAIAuthStore;
  fetch?: typeof fetch;
  now?: () => number;
  issuer?: string;
  originator?: string;
  callbackHost?: string;
  callbackPorts?: number[];
  openBrowser?: (url: string) => Promise<void>;
}

export interface BrowserLoginOptions {
  openBrowser?: boolean;
  onAuthUrl?: (url: string) => void | Promise<void>;
}

export interface DeviceLoginOptions {
  onDeviceCode?: (info: { verificationUrl: string; userCode: string; intervalSeconds: number; expiresInSeconds: number }) => void | Promise<void>;
}

export class KeyringOpenAIAuthStore implements OpenAIAuthStore {
  private readonly account: string;
  private readonly keyring: SecretEntryFactory;

  public constructor(options: { harnessHome: string; keyring?: SecretEntryFactory }) {
    this.account = `openai-chatgpt:active:${stableHomeKey(options.harnessHome)}`;
    this.keyring = options.keyring ?? new NapiKeyringFactory();
  }

  public async loadActive(): Promise<OpenAIChatGptSession | undefined> {
    const raw = await this.entry().getPassword();
    if (!raw) {
      return undefined;
    }
    return parseSession(raw);
  }

  public async saveActive(session: OpenAIChatGptSession): Promise<void> {
    await this.entry().setPassword(JSON.stringify(session));
  }

  public async deleteActive(): Promise<boolean> {
    const result = await this.entry().deletePassword();
    return typeof result === "boolean" ? result : true;
  }

  private entry(): SecretEntry {
    return this.keyring.entry(OPENAI_CHATGPT_KEYRING_SERVICE, this.account);
  }
}

export class OpenAIChatGptAuthManager {
  private readonly store: OpenAIAuthStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly issuer: string;
  private readonly originator: string;
  private readonly callbackHost: string;
  private readonly callbackPorts: number[];
  private readonly openBrowserImpl: (url: string) => Promise<void>;

  public constructor(options: OpenAIChatGptAuthManagerOptions) {
    this.store = options.store ?? new KeyringOpenAIAuthStore({ harnessHome: options.harnessHome });
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.issuer = stripTrailingSlash(options.issuer ?? OPENAI_AUTH_ISSUER);
    this.originator = options.originator ?? "harness";
    this.callbackHost = options.callbackHost ?? "127.0.0.1";
    this.callbackPorts = options.callbackPorts ?? [1455, 1457];
    this.openBrowserImpl = options.openBrowser ?? openBrowser;
  }

  public async status(): Promise<OpenAIChatGptAuthStatus> {
    const session = await this.store.loadActive();
    if (!session) {
      return { authenticated: false, storage: "keyring" };
    }
    return {
      authenticated: true,
      storage: "keyring",
      accountId: session.accountId,
      ...(session.email ? { email: session.email } : {}),
      ...(session.planType ? { planType: session.planType } : {}),
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  public async loadSession(): Promise<OpenAIChatGptSession | undefined> {
    return this.store.loadActive();
  }

  public async getValidSession(options: { forceRefresh?: boolean } = {}): Promise<OpenAIChatGptSession> {
    const session = await this.store.loadActive();
    if (!session) {
      throw new Error("ChatGPT login required. Run `harness auth login`.");
    }
    if (options.forceRefresh || session.expiresAt <= this.now() + TOKEN_REFRESH_SKEW_MS) {
      return this.refreshSession(session);
    }
    return session;
  }

  public async refreshSession(session?: OpenAIChatGptSession): Promise<OpenAIChatGptSession> {
    const current = session ?? await this.getRequiredSession();
    const response = await this.fetchImpl(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: OPENAI_CHATGPT_OAUTH_CLIENT_ID
      })
    });
    const tokens = await readTokenResponse(response, "refresh");
    const refreshed = this.sessionFromTokens(tokens, current.createdAt, { lastRefreshAt: nowIso(this.now()) });
    await this.store.saveActive(refreshed);
    return refreshed;
  }

  public async loginWithBrowser(options: BrowserLoginOptions = {}): Promise<OpenAIChatGptSession> {
    const pkce = await generatePkce();
    const state = randomBase64Url(32);
    const callbackServer = await startCallbackServer({
      host: this.callbackHost,
      ports: this.callbackPorts,
      state
    });
    const redirectUri = `http://localhost:${callbackServer.port}/auth/callback`;
    const authUrl = buildAuthorizeUrl({
      issuer: this.issuer,
      redirectUri,
      codeChallenge: pkce.challenge,
      state,
      originator: this.originator
    });
    try {
      await options.onAuthUrl?.(authUrl);
      if (options.openBrowser !== false) {
        await this.openBrowserImpl(authUrl).catch(() => undefined);
      }
      const code = await callbackServer.waitForCode();
      const tokens = await this.exchangeAuthorizationCode(code, pkce.verifier, redirectUri);
      const session = this.sessionFromTokens(tokens, nowIso(this.now()));
      await this.store.saveActive(session);
      return session;
    } finally {
      await callbackServer.close();
    }
  }

  public async loginWithDeviceCode(options: DeviceLoginOptions = {}): Promise<OpenAIChatGptSession> {
    const device = await this.requestDeviceCode();
    await options.onDeviceCode?.({
      verificationUrl: `${this.issuer}/codex/device`,
      userCode: device.userCode,
      intervalSeconds: device.intervalSeconds,
      expiresInSeconds: DEVICE_CODE_TIMEOUT_MS / 1000
    });
    const authorization = await this.pollDeviceCode(device);
    const tokens = await this.exchangeAuthorizationCode(authorization.authorizationCode, authorization.codeVerifier, `${this.issuer}/deviceauth/callback`);
    const session = this.sessionFromTokens(tokens, nowIso(this.now()));
    await this.store.saveActive(session);
    return session;
  }

  public async logout(): Promise<boolean> {
    const session = await this.store.loadActive();
    const deleted = await this.store.deleteActive();
    if (session) {
      await this.revokeRefreshToken(session.refreshToken).catch(() => undefined);
    }
    return deleted;
  }

  private async getRequiredSession(): Promise<OpenAIChatGptSession> {
    const session = await this.store.loadActive();
    if (!session) {
      throw new Error("ChatGPT login required. Run `harness auth login`.");
    }
    return session;
  }

  private async exchangeAuthorizationCode(code: string, verifier: string, redirectUri: string): Promise<OAuthTokenResponse> {
    const response = await this.fetchImpl(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: OPENAI_CHATGPT_OAUTH_CLIENT_ID,
        code_verifier: verifier
      })
    });
    return readTokenResponse(response, "exchange");
  }

  private async requestDeviceCode(): Promise<DeviceCodeState> {
    const response = await this.fetchImpl(`${this.issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CHATGPT_OAUTH_CLIENT_ID })
    });
    if (!response.ok) {
      throw new Error(`Device code request failed (${response.status}): ${await safeResponseText(response)}`);
    }
    const json = await response.json() as Record<string, unknown>;
    const interval = typeof json.interval === "string" ? Number(json.interval.trim()) : json.interval;
    if (typeof json.device_auth_id !== "string" || typeof json.user_code !== "string" || typeof interval !== "number" || !Number.isFinite(interval)) {
      throw new Error(`Invalid device code response: ${JSON.stringify(redactOpenAIAuthValue(json))}`);
    }
    return {
      deviceAuthId: json.device_auth_id,
      userCode: json.user_code,
      intervalSeconds: interval
    };
  }

  private async pollDeviceCode(device: DeviceCodeState): Promise<DeviceAuthorization> {
    const startedAt = this.now();
    while (this.now() - startedAt < DEVICE_CODE_TIMEOUT_MS) {
      const response = await this.fetchImpl(`${this.issuer}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: device.deviceAuthId,
          user_code: device.userCode
        })
      });
      if (response.ok) {
        const json = await response.json() as Record<string, unknown>;
        if (typeof json.authorization_code === "string" && typeof json.code_verifier === "string") {
          return { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier };
        }
        throw new Error(`Invalid device authorization response: ${JSON.stringify(redactOpenAIAuthValue(json))}`);
      }
      if (response.status !== 403 && response.status !== 404) {
        throw new Error(`Device authorization failed (${response.status}): ${await safeResponseText(response)}`);
      }
      await sleep(Math.max(device.intervalSeconds, 1) * 1000);
    }
    throw new Error("Device authorization timed out after 15 minutes");
  }

  private async revokeRefreshToken(refreshToken: string): Promise<void> {
    await this.fetchImpl(`${this.issuer}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: OPENAI_CHATGPT_OAUTH_CLIENT_ID
      })
    });
  }

  private sessionFromTokens(tokens: OAuthTokenResponse, createdAt: string, metadata: { lastRefreshAt?: string } = {}): OpenAIChatGptSession {
    const idClaims = decodeJwtPayload(tokens.idToken);
    const accessClaims = decodeJwtPayload(tokens.accessToken);
    const authClaims = authClaimsFrom(idClaims) ?? authClaimsFrom(accessClaims);
    const accountId = stringField(authClaims, "chatgpt_account_id");
    if (!accountId) {
      throw new Error("ChatGPT OAuth token did not include a chatgpt_account_id claim");
    }
    const expiresAt = tokenExpiresAt(tokens, accessClaims, idClaims, this.now());
    return {
      version: 1,
      kind: OPENAI_CHATGPT_AUTH_KIND,
      issuer: this.issuer,
      accountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt,
      createdAt,
      updatedAt: nowIso(this.now()),
      ...(metadata.lastRefreshAt ? { lastRefreshAt: metadata.lastRefreshAt } : {}),
      ...optionalSessionMetadata(idClaims, authClaims)
    };
  }
}

export function createOpenAIChatGptAuthManager(options: OpenAIChatGptAuthManagerOptions): OpenAIChatGptAuthManager {
  return new OpenAIChatGptAuthManager(options);
}

export function redactOpenAIAuthValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactOpenAIAuthText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactOpenAIAuthValue(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEYS.has(key.toLowerCase()) ? "<redacted>" : redactOpenAIAuthValue(nested)
    ]));
  }
  return value;
}

export function redactOpenAIAuthText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactOpenAIAuthValue(JSON.parse(trimmed)));
    } catch {
      // Fall through to pattern redaction for non-JSON text.
    }
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer <redacted>")
    .replace(/(access_token|refresh_token|id_token|code|code_verifier|state|authorization_code)=([^&\s]+)/giu, "$1=<redacted>")
    .replace(/"(access_token|refresh_token|id_token|code|code_verifier|state|authorization_code)"\s*:\s*"[^"]*"/giu, "\"$1\":\"<redacted>\"");
}

interface OAuthTokenResponse {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

interface DeviceCodeState {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

interface DeviceAuthorization {
  authorizationCode: string;
  codeVerifier: string;
}

interface CallbackServer {
  port: number;
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

class NapiKeyringFactory implements SecretEntryFactory {
  public entry(service: string, account: string): SecretEntry {
    return new Entry(service, account);
  }
}

async function readTokenResponse(response: Response, operation: string): Promise<OAuthTokenResponse> {
  if (!response.ok) {
    throw new Error(`OpenAI ChatGPT token ${operation} failed (${response.status}): ${redactOpenAIAuthText(await safeResponseText(response))}`);
  }
  const json = await response.json() as Record<string, unknown>;
  if (typeof json.id_token !== "string" || typeof json.access_token !== "string" || typeof json.refresh_token !== "string") {
    throw new Error(`OpenAI ChatGPT token ${operation} response missing fields: ${JSON.stringify(redactOpenAIAuthValue(json))}`);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  return {
    idToken: json.id_token,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    ...(expiresIn === undefined ? {} : { expiresIn })
  };
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthorizeUrl(input: { issuer: string; redirectUri: string; codeChallenge: string; state: string; originator: string }): string {
  const url = new URL(`${input.issuer}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CHATGPT_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", input.originator);
  return url.toString();
}

async function startCallbackServer(input: { host: string; ports: number[]; state: string }): Promise<CallbackServer> {
  let lastError: unknown;
  for (const port of input.ports) {
    try {
      return await bindCallbackServer(input.host, port, input.state);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to bind OAuth callback server");
}

function bindCallbackServer(host: string, port: number, state: string): Promise<CallbackServer> {
  let server: Server | undefined;
  let settled = false;
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  server = createServer((req, res) => {
    handleCallbackRequest(req, res, state, (code) => {
      if (!settled) {
        settled = true;
        resolveCode(code);
      }
    }, (error) => {
      if (!settled) {
        settled = true;
        rejectCode(error);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(port, host, () => {
      server?.off("error", reject);
      resolve({
        port,
        waitForCode: () => codePromise,
        close: () => new Promise<void>((closeResolve) => {
          server?.close(() => closeResolve());
        })
      });
    });
  });
}

function handleCallbackRequest(req: IncomingMessage, res: ServerResponse, state: string, onCode: (code: string) => void, onError: (error: Error) => void): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/auth/callback") {
    writeHtml(res, 404, "Callback route not found.");
    return;
  }
  if (url.searchParams.get("state") !== state) {
    const error = new Error("OAuth state mismatch");
    writeHtml(res, 400, "State mismatch.");
    onError(error);
    return;
  }
  const callbackError = url.searchParams.get("error");
  if (callbackError) {
    const error = new Error(`OAuth callback failed: ${callbackError}`);
    writeHtml(res, 400, "Sign-in could not be completed.");
    onError(error);
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    const error = new Error("OAuth callback missing authorization code");
    writeHtml(res, 400, "Missing authorization code.");
    onError(error);
    return;
  }
  writeHtml(res, 200, "OpenAI authentication completed. You can close this window.");
  onCode(code);
}

function writeHtml(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><body><p>${escapeHtml(message)}</p></body></html>`);
}

function parseSession(raw: string): OpenAIChatGptSession {
  const parsed = JSON.parse(raw) as Partial<OpenAIChatGptSession>;
  if (
    parsed.version !== 1 ||
    parsed.kind !== OPENAI_CHATGPT_AUTH_KIND ||
    typeof parsed.accountId !== "string" ||
    typeof parsed.accessToken !== "string" ||
    typeof parsed.refreshToken !== "string" ||
    typeof parsed.idToken !== "string" ||
    typeof parsed.expiresAt !== "number" ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.updatedAt !== "string"
  ) {
    throw new Error("Invalid OpenAI ChatGPT auth session in keyring");
  }
  return {
    version: 1,
    kind: OPENAI_CHATGPT_AUTH_KIND,
    issuer: parsed.issuer ?? OPENAI_AUTH_ISSUER,
    accountId: parsed.accountId,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    idToken: parsed.idToken,
    expiresAt: parsed.expiresAt,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    ...(parsed.lastRefreshAt ? { lastRefreshAt: parsed.lastRefreshAt } : {}),
    ...(parsed.email ? { email: parsed.email } : {}),
    ...(parsed.planType ? { planType: parsed.planType } : {}),
    ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {})
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function authClaimsFrom(claims: Record<string, unknown>): Record<string, unknown> | undefined {
  const auth = claims[JWT_AUTH_CLAIM];
  return typeof auth === "object" && auth !== null && !Array.isArray(auth) ? auth as Record<string, unknown> : undefined;
}

function optionalSessionMetadata(idClaims: Record<string, unknown>, authClaims: Record<string, unknown> | undefined): Partial<Pick<OpenAIChatGptSession, "email" | "planType" | "workspaceId">> {
  const email = stringField(idClaims, "email");
  const planType = stringField(authClaims, "chatgpt_plan_type");
  const workspaceId = stringField(authClaims, "workspace_id");
  return {
    ...(email ? { email } : {}),
    ...(planType ? { planType } : {}),
    ...(workspaceId ? { workspaceId } : {})
  };
}

function tokenExpiresAt(tokens: OAuthTokenResponse, accessClaims: Record<string, unknown>, idClaims: Record<string, unknown>, now: number): number {
  if (tokens.expiresIn !== undefined) {
    return now + tokens.expiresIn * 1000;
  }
  const accessExp = numberField(accessClaims, "exp");
  if (accessExp !== undefined) {
    return accessExp * 1000;
  }
  const idExp = numberField(idClaims, "exp");
  if (idExp !== undefined) {
    return idExp * 1000;
  }
  return now + FALLBACK_TOKEN_TTL_MS;
}

function stableHomeKey(harnessHome: string): string {
  return createHash("sha256").update(path.resolve(harnessHome)).digest("hex").slice(0, 32);
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeResponseText(response: Response): Promise<string> {
  return redactOpenAIAuthText(await response.text().catch(() => response.statusText));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function openBrowser(url: string): Promise<void> {
  const currentPlatform = platform();
  const command = currentPlatform === "darwin" ? "open" : currentPlatform === "win32" ? "cmd" : "xdg-open";
  const args = currentPlatform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
