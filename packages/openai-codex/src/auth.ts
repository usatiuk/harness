import type { SecretStore } from "@harness/secrets";
import {
  buildAuthorizeUrl,
  decodeAccountId,
  decodeEmail,
  exchangeCode,
  generatePkce,
  openBrowser,
  randomState,
  refreshTokens,
  startCallbackServer,
  type OAuthTokens,
} from "./oauth.ts";
import { parseCodexSession, type CodexSession } from "./session.ts";

const STORE_KEY = "openai-codex";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface CodexAuthOptions {
  store: SecretStore;
  now?: () => number;
  fetch?: typeof fetch;
  /** Open the browser during login; default true. Set false for tests/headless. */
  openBrowser?: boolean;
}

export interface CodexStatus {
  authenticated: boolean;
  accountId?: string;
  email?: string;
  /** Epoch ms the access token expires (when signed in). */
  expiresAt?: number;
}

export interface LoginOptions {
  /** Receives the authorize URL so a caller can print it as a manual fallback. */
  onUrl?: (url: string) => void;
}

/**
 * Owns the Codex OAuth lifecycle over a `SecretStore`: browser login, status, logout, and
 * lazy refresh. Caches the active session in memory and persists every refresh.
 */
export class CodexAuth {
  readonly #store: SecretStore;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #openBrowser: boolean;
  #cached: CodexSession | undefined;

  constructor(opts: CodexAuthOptions) {
    this.#store = opts.store;
    this.#now = opts.now ?? (() => Date.now());
    this.#fetch = opts.fetch ?? fetch;
    this.#openBrowser = opts.openBrowser ?? true;
  }

  async status(): Promise<CodexStatus> {
    const session = await this.#load();
    if (!session) return { authenticated: false };
    return {
      authenticated: true,
      accountId: session.accountId,
      expiresAt: session.expiresAt,
      ...(session.email ? { email: session.email } : {}),
    };
  }

  /** Runs the loopback browser flow end to end, persisting the resulting session. */
  async loginWithBrowser(opts: LoginOptions = {}): Promise<CodexSession> {
    const pkce = generatePkce();
    const state = randomState();
    const server = await startCallbackServer(state);
    try {
      const url = buildAuthorizeUrl({
        redirectUri: server.redirectUri,
        state,
        challenge: pkce.challenge,
      });
      opts.onUrl?.(url);
      if (this.#openBrowser) openBrowser(url);
      const code = await server.waitForCode();
      const tokens = await exchangeCode({
        code,
        verifier: pkce.verifier,
        redirectUri: server.redirectUri,
        fetch: this.#fetch,
        now: this.#now,
      });
      return await this.#persist(tokens);
    } finally {
      await server.close();
    }
  }

  /** A non-expired session, refreshing within the skew window. Throws if not signed in. */
  async getValidSession(opts: { forceRefresh?: boolean } = {}): Promise<CodexSession> {
    const session = await this.#load();
    if (!session) throw new Error("Not signed in to Codex. Run `harness auth login`.");
    if (opts.forceRefresh || session.expiresAt <= this.#now() + REFRESH_SKEW_MS) {
      const tokens = await refreshTokens({
        refreshToken: session.refreshToken,
        fetch: this.#fetch,
        now: this.#now,
      });
      return this.#persist(tokens);
    }
    return session;
  }

  async logout(): Promise<boolean> {
    this.#cached = undefined;
    return this.#store.delete(STORE_KEY);
  }

  async #load(): Promise<CodexSession | undefined> {
    if (this.#cached) return this.#cached;
    const raw = await this.#store.get(STORE_KEY);
    if (!raw) return undefined;
    this.#cached = parseCodexSession(raw);
    return this.#cached;
  }

  async #persist(tokens: OAuthTokens): Promise<CodexSession> {
    const email = decodeEmail(tokens.idToken);
    const session: CodexSession = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      accountId: decodeAccountId(tokens.accessToken),
      expiresAt: tokens.expiresAt,
      ...(email ? { email } : {}),
    };
    await this.#store.set(STORE_KEY, JSON.stringify(session));
    this.#cached = session;
    return session;
  }
}
