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
  storeKey?: string;
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
  signal?: AbortSignal;
  /** Receives the authorize URL so a caller can print it as a manual fallback. */
  onUrl?: (url: string) => void;
}

/**
 * Owns the Codex OAuth lifecycle over a `SecretStore`: browser login, status, logout, and
 * lazy refresh. Caches the active session in memory and persists every refresh.
 */
export class CodexAuth {
  readonly #store: SecretStore;
  readonly #storeKey: string;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #openBrowser: boolean;
  #cached: CodexSession | undefined;
  #refresh: Promise<CodexSession> | undefined;
  #epoch = 0;

  constructor(opts: CodexAuthOptions) {
    this.#store = opts.store;
    this.#storeKey = opts.storeKey ?? STORE_KEY;
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
    const epoch = ++this.#epoch;
    await this.#refresh?.catch(() => undefined);
    opts.signal?.throwIfAborted();
    const pkce = generatePkce();
    const state = randomState();
    const server = await startCallbackServer(state);
    let abort: (() => void) | undefined;
    try {
      const url = buildAuthorizeUrl({
        redirectUri: server.redirectUri,
        state,
        challenge: pkce.challenge,
      });
      opts.onUrl?.(url);
      if (this.#openBrowser) openBrowser(url);
      const code = await new Promise<string>((resolve, reject) => {
        abort = (): void => reject(new DOMException("Provider sign-in cancelled", "AbortError"));
        opts.signal?.addEventListener("abort", abort, { once: true });
        if (opts.signal?.aborted) abort();
        void server.waitForCode().then(resolve, reject);
      });
      const tokens = await exchangeCode({
        code,
        verifier: pkce.verifier,
        redirectUri: server.redirectUri,
        fetch: (input, init) =>
          this.#fetch(input, { ...init, ...(opts.signal ? { signal: opts.signal } : {}) }),
        now: this.#now,
      });
      opts.signal?.throwIfAborted();
      return await this.#persist(tokens, epoch);
    } finally {
      if (abort) opts.signal?.removeEventListener("abort", abort);
      await server.close();
    }
  }

  /** A non-expired session, refreshing within the skew window. Throws if not signed in. */
  async getValidSession(opts: { forceRefresh?: boolean } = {}): Promise<CodexSession> {
    const epoch = this.#epoch;
    const session = await this.#load();
    if (epoch !== this.#epoch)
      throw new Error("Codex authentication changed during credential access");
    if (!session) throw new Error("Not signed in to Codex. Run `harness auth login`.");
    if (opts.forceRefresh || session.expiresAt <= this.#now() + REFRESH_SKEW_MS) {
      if (!this.#refresh) {
        const refresh = refreshTokens({
          refreshToken: session.refreshToken,
          fetch: this.#fetch,
          now: this.#now,
        }).then((tokens) => this.#persist(tokens, epoch));
        this.#refresh = refresh;
        void refresh
          .finally(() => {
            if (this.#refresh === refresh) this.#refresh = undefined;
          })
          .catch(() => undefined);
      }
      return this.#refresh;
    }
    return session;
  }

  async logout(): Promise<boolean> {
    ++this.#epoch;
    // Drain an already-started rotation before removing the durable session.
    await this.#refresh?.catch(() => undefined);
    this.#cached = undefined;
    return this.#store.delete(this.#storeKey);
  }

  async #load(): Promise<CodexSession | undefined> {
    if (this.#cached) return this.#cached;
    const raw = await this.#store.get(this.#storeKey);
    if (!raw) return undefined;
    this.#cached = parseCodexSession(raw);
    return this.#cached;
  }

  async #persist(tokens: OAuthTokens, epoch = this.#epoch): Promise<CodexSession> {
    if (epoch !== this.#epoch)
      throw new Error("Codex authentication changed during sign-in or refresh");
    const email = decodeEmail(tokens.idToken);
    const session: CodexSession = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      accountId: decodeAccountId(tokens.accessToken),
      expiresAt: tokens.expiresAt,
      ...(email ? { email } : {}),
    };
    await this.#store.set(this.#storeKey, JSON.stringify(session));
    this.#cached = session;
    return session;
  }
}
