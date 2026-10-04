import type { ProviderSecrets } from "@harness/protocol";
import {
  buildAuthorizeUrl,
  decodeAccountId,
  decodeEmail,
  exchangeCode,
  generatePkce,
  loginWithDeviceCode,
  openBrowser,
  randomState,
  refreshTokens,
  startCallbackServer,
  type OAuthTokens,
} from "./oauth.ts";
import { parseCodexSession, type CodexSession } from "./session.ts";

const STORE_KEY = "oauth";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface CodexAuthOptions {
  store: ProviderSecrets;
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
  onUrl?: (url: string, userCode?: string) => void;
}

interface TokenRefresh {
  promise: Promise<CodexSession>;
  abort: AbortController;
  waiters: number;
}

/**
 * Owns the Codex OAuth lifecycle over instance-scoped secrets: browser login, status, logout, and
 * lazy refresh. Caches the active session in memory and persists every refresh.
 */
export class CodexAuth {
  readonly #store: ProviderSecrets;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #openBrowser: boolean;
  #cached: CodexSession | undefined;
  #refresh: TokenRefresh | undefined;
  #epoch = 0;
  #authChange: "login" | "logout" | undefined;

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
    if (this.#authChange) throw new Error("Codex authentication change is already in progress");
    this.#authChange = "login";
    try {
      return await this.#loginWithBrowser(opts);
    } finally {
      this.#authChange = undefined;
    }
  }

  async #loginWithBrowser(opts: LoginOptions): Promise<CodexSession> {
    const epoch = ++this.#epoch;
    this.#refresh?.abort.abort(new Error("Codex authentication changed"));
    await this.#refresh?.promise.catch(() => undefined);
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

  /** Runs device authorization while keeping credentials on this executing host. */
  async loginWithDeviceCode(opts: LoginOptions = {}): Promise<CodexSession> {
    if (this.#authChange) throw new Error("Codex authentication change is already in progress");
    this.#authChange = "login";
    try {
      const epoch = ++this.#epoch;
      this.#refresh?.abort.abort(new Error("Codex authentication changed"));
      await this.#refresh?.promise.catch(() => undefined);
      const tokens = await loginWithDeviceCode({ fetch: this.#fetch, now: this.#now, ...opts });
      opts.signal?.throwIfAborted();
      return await this.#persist(tokens, epoch);
    } finally {
      this.#authChange = undefined;
    }
  }

  /** A non-expired session, refreshing within the skew window. Throws if not signed in. */
  async getValidSession(
    opts: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<CodexSession> {
    opts.signal?.throwIfAborted();
    this.#assertInvocationAllowed();
    const epoch = this.#epoch;
    const session = await this.#load();
    opts.signal?.throwIfAborted();
    if (epoch !== this.#epoch)
      throw new Error("Codex authentication changed during credential access");
    this.#assertInvocationAllowed();
    if (!session) throw new Error("Not signed in to Codex. Run `harness auth login`.");
    if (opts.forceRefresh || session.expiresAt <= this.#now() + REFRESH_SKEW_MS) {
      if (!this.#refresh) {
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
        const promise = refreshTokens({
          refreshToken: session.refreshToken,
          fetch: (input, init) => this.#fetch(input, { ...init, signal }),
          now: this.#now,
        }).then((tokens) => this.#persist(tokens, epoch));
        const refresh: TokenRefresh = { promise, abort: controller, waiters: 0 };
        this.#refresh = refresh;
        void promise
          .finally(() => {
            if (this.#refresh === refresh) {
              this.#refresh = undefined;
            }
          })
          .catch(() => undefined);
      }
      return this.#waitForRefresh(this.#refresh, opts.signal);
    }
    return session;
  }

  #assertInvocationAllowed(): void {
    if (this.#authChange)
      throw new Error(
        `Codex sign-${this.#authChange === "login" ? "in" : "out"} is in progress; finish authentication before invoking this connection`,
      );
  }

  async #waitForRefresh(refresh: TokenRefresh, signal?: AbortSignal): Promise<CodexSession> {
    refresh.waiters++;
    let cancel: (() => void) | undefined;
    try {
      if (!signal) return await refresh.promise;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => {
          // AbortSignal permits any reason; preserve its identity for cancellation classification.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason as unknown);
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
      return await Promise.race([refresh.promise, cancelled]);
    } finally {
      if (cancel) signal!.removeEventListener("abort", cancel);
      refresh.waiters--;
      if (signal?.aborted && refresh.waiters === 0) {
        // A dispatched rotation may already have consumed the old token. Drain and persist it
        // even when generation is cancelled; only login/logout may replace this auth owner.
        await refresh.promise;
      }
    }
  }

  async logout(): Promise<boolean> {
    if (this.#authChange) throw new Error("Codex authentication change is already in progress");
    this.#authChange = "logout";
    try {
      ++this.#epoch;
      this.#refresh?.abort.abort(new Error("Codex authentication changed"));
      // Drain an already-started rotation before removing the durable session.
      await this.#refresh?.promise.catch(() => undefined);
      this.#cached = undefined;
      return await this.#store.delete(STORE_KEY);
    } finally {
      this.#authChange = undefined;
    }
  }

  async #load(): Promise<CodexSession | undefined> {
    if (this.#authChange === "logout") return undefined;
    if (this.#cached) return this.#cached;
    const epoch = this.#epoch;
    const raw = await this.#store.get(STORE_KEY);
    if (epoch !== this.#epoch) return undefined;
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
    await this.#store.set(STORE_KEY, JSON.stringify(session));
    this.#cached = session;
    return session;
  }
}
