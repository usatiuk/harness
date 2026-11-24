import {
  serverInfoRequest,
  sameExecutionTarget,
  type ClientConfig,
  type Host,
  type StartupProgress,
  type ConnectionCommand,
  type ServerIdentity,
  type PreparedRuntime,
  type HostConnectionTarget,
  type ClientConfigCommand,
} from "@harness/connections";
import { StartupAttempt, sessionTimeoutSeconds } from "./startup.ts";
import { DesktopSession } from "./session.ts";
import { connectionCommand, connectNative } from "./transport.ts";

export interface HostView {
  host: Host;
  session?: DesktopSession;
  closeTransport?: () => Promise<void>;
  identity?: ServerIdentity;
  runtime?: PreparedRuntime;
  progress?: string;
  attempt?: StartupAttempt;
  error?: string;
}
/** Selection owns presentation. Each connected host retains its own RPC session. */
export class DesktopHosts {
  config: ClientConfig | undefined;
  readonly views = new Map<string, HostView>();
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<
    string,
    { kind: "connect" | "refresh"; result: Promise<HostView>; abort: AbortController }
  >();
  revision = 0;
  private configTail: Promise<void> = Promise.resolve();
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = (): number => this.revision;
  changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  get selected(): HostView | undefined {
    return this.views.get(this.config?.selectedHostId ?? "local");
  }
  boot = new StartupAttempt();
  private bootCancel?: AbortController;
  async initialize(): Promise<void> {
    const cancel = new AbortController();
    this.bootCancel = cancel;
    this.boot = new StartupAttempt();
    this.boot.step("Reading connection settings");
    this.changed();
    try {
      await this.updateConfig({ type: "config.read" }, cancel.signal, (event) => {
        this.boot.step(event.message, event);
        this.changed();
      });
      this.selected!.attempt = this.boot;
      await this.connect(this.config!.selectedHostId, cancel.signal).catch(() => undefined);
    } finally {
      if (!this.selected?.session) this.boot.finish();
      delete this.bootCancel;
      this.changed();
    }
  }
  private async acceptConfig(config: ClientConfig): Promise<void> {
    const entries = new Map(config.hosts.map((host) => [host.id, host]));
    for (const [id, view] of this.views) {
      const next = entries.get(id);
      if (!next || !sameExecutionTarget(view.host, next)) {
        await this.disconnect(id);
        delete view.identity;
        delete view.runtime;
        if (!next) this.views.delete(id);
      }
    }
    this.config = config;
    for (const host of config.hosts) {
      const view = this.views.get(host.id);
      if (view) view.host = host;
      else this.views.set(host.id, { host });
    }
    this.changed();
  }
  private updateConfig(
    command: ClientConfigCommand,
    signal?: AbortSignal,
    progress?: (event: StartupProgress) => void,
  ): Promise<void> {
    const result = this.configTail.then(async () => {
      signal?.throwIfAborted();
      await this.acceptConfig(await connectionCommand(command, progress, signal));
    });
    this.configTail = result.catch(() => undefined);
    return result;
  }
  async edit(
    command: Extract<ConnectionCommand, { type: "host.save" | "host.remove" }>,
  ): Promise<void> {
    await this.updateConfig(command);
  }
  async select(id: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.updateConfig({ type: "host.select", id }, signal);
    await this.connect(id, signal);
  }
  async connect(id: string, signal?: AbortSignal): Promise<HostView> {
    signal?.throwIfAborted();
    let pending = this.operations.get(id);
    if (pending) {
      if (pending.kind !== "connect") throw new Error("Host upload is in progress");
    } else {
      const abort = new AbortController();
      const result = this.configReady(abort.signal).then(() => this.open(id, abort.signal));
      pending = { kind: "connect", abort, result };
      this.operations.set(id, pending);
      void result.finally(() => this.operations.delete(id)).catch(() => undefined);
    }
    if (!signal) return pending.result;
    // Joining callers cancel this connection attempt, never a later one for the same host.
    const { abort, result } = pending;
    const cancel = () => abort.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await result;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  private configReady(signal: AbortSignal): Promise<void> {
    let cancel!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      cancel = () => reject(new DOMException("Connection attempt cancelled", "AbortError"));
      signal.addEventListener("abort", cancel, { once: true });
      this.configTail.then(resolve, reject);
      if (signal.aborted) cancel();
    });
    return ready.finally(() => signal.removeEventListener("abort", cancel));
  }
  private async open(id: string, signal: AbortSignal): Promise<HostView> {
    signal.throwIfAborted();
    const view = this.views.get(id);
    if (!view) throw new Error("Unknown host");
    if (view.session && !view.session.disconnected) return view;
    await view.closeTransport?.();
    delete view.error;
    if (view.attempt !== this.boot || !this.bootCancel) view.attempt = new StartupAttempt();
    this.progress(view, "Preparing connection");
    let transportError: string | undefined;
    let ready: AbortSignal | undefined;
    try {
      signal.throwIfAborted();
      if (view.host.kind !== "local") await this.prepare(view, signal);
      signal.throwIfAborted();
      this.progress(view, "Opening host connection");
      let session: DesktopSession | undefined = undefined;
      const transport = await connectNative(
        this.target(view),
        (message) => {
          transportError ??= message;
          session?.disconnect(message);
          if (view.session === session) {
            view.error = message;
            this.changed();
          }
        },
        signal,
        (event) => this.progress(view, event.message, event),
      );
      view.closeTransport = transport.close;
      session = new DesktopSession(transport.connection, id);
      const sessionDeadline = new AbortController();
      const seconds = sessionTimeoutSeconds();
      ready = AbortSignal.any([signal, sessionDeadline.signal]);
      const timerOwner = new AbortController();
      void Promise.resolve(transport.ownerReady).then(() => {
        if (timerOwner.signal.aborted) return;
        this.progress(view, "Opening desktop session");
        const timer = AbortSignal.timeout(Math.ceil(seconds * 1000));
        timer.addEventListener(
          "abort",
          () =>
            sessionDeadline.abort(
              new Error(`Desktop session on ${view.host.label} timed out after ${seconds} seconds`),
            ),
          { once: true, signal: timerOwner.signal },
        );
      });
      const cancel = () => session.client.closeConnection();
      ready.addEventListener("abort", cancel, { once: true });
      let identity: ServerIdentity;
      try {
        ready.throwIfAborted();
        await session.start();
        identity = await session.client.peer.request(serverInfoRequest, {});
        ready.throwIfAborted();
      } catch (error) {
        ready.throwIfAborted();
        throw error;
      } finally {
        timerOwner.abort();
        ready.removeEventListener("abort", cancel);
      }
      session.setServerScope(identity.serverId);
      view.session = session;
      session.subscribeConnection(() => this.changed());
      view.identity = identity;
      view.attempt?.step("Loading workspace");
      return view;
    } catch (error) {
      const cancelled = signal.aborted || ready?.aborted;
      const failure = new Error("Connection failed", { cause: error });
      try {
        await view.closeTransport?.();
      } catch (cleanupError) {
        failure.cause = new AggregateError(
          [error, cleanupError],
          "Connection and bridge teardown failed",
        );
      } finally {
        const message = error instanceof Error ? error.message : String(error);
        view.error = cancelled ? message : (transportError ?? message);
        delete view.closeTransport;
        delete view.session;
      }
      // Reconnect callers render the rejection, so it must match the host view.
      failure.message = view.error;
      throw failure;
    } finally {
      if (!view.session) view.attempt?.finish();
      delete view.progress;
      this.changed();
    }
  }
  async disconnect(id: string): Promise<void> {
    const pending = this.operations.get(id);
    if (pending) {
      pending.abort.abort();
      await pending.result.catch(() => undefined);
    }
    const view = this.views.get(id);
    if (!view) return;
    view.attempt?.finish();
    view.session?.disconnect("Disconnected");
    view.session?.client.closeConnection();
    await view.closeTransport?.();
    delete view.closeTransport;
    delete view.session;
    this.changed();
  }
  async reconnect(id: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.disconnect(id);
    await this.connect(id, signal);
  }
  async refresh(id: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.operations.has(id)) throw new Error("Host operation is in progress");
    const abort = new AbortController();
    const ready = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
    const result = this.configReady(ready).then(() => {
      ready.throwIfAborted();
      const view = this.views.get(id);
      if (!view) throw new Error("Unknown host");
      return view.host.kind === "local" ? view : this.prepare(view, ready);
    });
    this.operations.set(id, { kind: "refresh", result, abort });
    try {
      await result;
    } finally {
      this.operations.delete(id);
    }
  }
  private progress(view: HostView, message: string, event?: StartupProgress) {
    view.progress = message;
    if (this.operations.get(view.host.id)?.kind !== "refresh") view.attempt?.step(message, event);
    this.changed();
  }
  cancel(id?: string): void {
    if (!id) this.bootCancel?.abort();
    else this.operations.get(id)?.abort.abort();
  }
  private async prepare(view: HostView, signal: AbortSignal): Promise<HostView> {
    if (view.host.kind === "local") throw new Error("Local does not need provisioning");
    try {
      view.runtime = await connectionCommand(
        { type: "runtime.prepare", host: view.host },
        (event) => {
          this.progress(view, event.message, event);
        },
        signal,
      );
      return view;
    } finally {
      delete view.progress;
      this.changed();
    }
  }
  async stop(id: string): Promise<void> {
    const view = this.views.get(id);
    if (!view?.identity) throw new Error("Connect to the host before stopping its server");
    const session = view.session;
    const closeTransport = view.closeTransport;
    await connectionCommand({
      type: "server.stop",
      ...this.target(view),
      identity: view.identity,
    });
    session?.client.closeConnection();
    await closeTransport?.();
    if (view.session === session && view.closeTransport === closeTransport) {
      delete view.session;
      delete view.closeTransport;
      this.changed();
    }
  }
  private target(view: HostView): HostConnectionTarget {
    if (view.host.kind === "local") return { host: view.host, runtime: null };
    if (!view.runtime) throw new Error("Missing prepared remote runtime");
    return { host: view.host, runtime: view.runtime };
  }
  async restart(id: string): Promise<void> {
    await this.refresh(id);
    await this.stop(id);
    await this.connect(id);
  }
}
