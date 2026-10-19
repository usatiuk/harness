import { randomUUID } from "node:crypto";
import { defaultHome } from "@harness/config";
import {
  serverInfoRequest,
  sameExecutionTarget,
  type ClientConfig,
  type Host,
  type ServerIdentity,
  type ConnectionCommand,
  type ClientConfigCommand,
} from "@harness/connections";
import {
  ensureLocalServer,
  connectRemote,
  prepareRemoteRuntime,
  runConnectionCommand,
  type PreparedRuntime,
  type RemoteConnection,
  type ServerLaunch,
} from "@harness/connections/node";
import { buildClientHarness, type Harness } from "./client-harness.ts";
import { prepareServerLaunch } from "./server-launch.ts";

export interface TuiHostView {
  host: Host;
  harness?: Harness;
  identity?: ServerIdentity;
  runtime?: PreparedRuntime;
  progress?: string;
  error?: string;
  presentation: { activeId?: string; workspace?: string; drafts: Map<string, string> };
  disconnected?: boolean;
}
export class TuiHosts {
  config: ClientConfig | undefined;
  readonly views = new Map<string, TuiHostView>();
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<
    string,
    { kind: "connect" | "refresh"; result: Promise<TuiHostView>; abort: AbortController }
  >();
  private revision = 0;
  private stopping = false;
  private configTail: Promise<void> = Promise.resolve();
  constructor(
    readonly env: NodeJS.ProcessEnv = {},
    readonly localLaunch?: ServerLaunch,
  ) {}
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
  get selected(): TuiHostView | undefined {
    return this.views.get(this.config?.selectedHostId ?? "local");
  }
  setActive(id: string, conversationId: string): void {
    const view = this.views.get(id);
    if (view) view.presentation.activeId = conversationId;
  }
  newConversation(id: string, workspace?: string): void {
    const view = this.views.get(id);
    if (!view) throw new Error("Unknown host");
    delete view.presentation.activeId;
    if (workspace !== undefined) view.presentation.workspace = workspace;
  }
  private async accept(config: ClientConfig): Promise<void> {
    const entries = new Map(config.hosts.map((host) => [host.id, host]));
    for (const [id, view] of this.views) {
      const next = entries.get(id);
      if (!next || !sameExecutionTarget(view.host, next)) {
        await this.disconnect(id);
        delete view.identity;
        delete view.runtime;
        view.presentation = { drafts: new Map() };
        if (!next) this.views.delete(id);
      }
    }
    this.config = config;
    for (const host of config.hosts) {
      const view = this.views.get(host.id);
      if (view) view.host = host;
      else this.views.set(host.id, { host, presentation: { drafts: new Map() } });
    }
    this.changed();
  }
  private updateConfig(command: ClientConfigCommand): Promise<void> {
    const result = this.configTail.then(async () =>
      this.accept(await runConnectionCommand(command, "")),
    );
    this.configTail = result.catch(() => undefined);
    return result;
  }
  async initialize(destination?: string, selectedId?: string): Promise<void> {
    await this.updateConfig({ type: "config.read" });
    if (destination) {
      const existing = this.config!.hosts.find(
        (host) => host.kind === "ssh" && host.destination === destination,
      );
      if (existing) selectedId = existing.id;
      else {
        const host: Host = {
          id: randomUUID(),
          label: destination,
          kind: "ssh",
          destination,
        };
        await this.edit({ type: "host.save", host });
        selectedId = host.id;
      }
    }
    if (selectedId) await this.updateConfig({ type: "host.select", id: selectedId });
  }
  async edit(
    command: Extract<ConnectionCommand, { type: "host.save" | "host.remove" }>,
  ): Promise<void> {
    await this.updateConfig(command);
  }
  async select(id: string): Promise<void> {
    await this.updateConfig({ type: "host.select", id });
    await this.connect(id);
  }
  connect(id: string): Promise<TuiHostView> {
    if (this.stopping) return Promise.reject(new Error("TUI is shutting down"));
    const pending = this.operations.get(id);
    if (pending) {
      if (pending.kind !== "connect")
        return Promise.reject(new Error("Host upload is in progress"));
      return pending.result;
    }
    const abort = new AbortController();
    const result = this.configReady(abort.signal).then(() => {
      if (this.stopping) throw new Error("TUI is shutting down");
      return this.open(id, abort.signal);
    });
    this.operations.set(id, { kind: "connect", abort, result });
    void result.finally(() => this.operations.delete(id)).catch(() => undefined);
    return result;
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
  private async prepare(view: TuiHostView, signal: AbortSignal): Promise<PreparedRuntime> {
    const host = view.host;
    if (host.kind === "local") throw new Error("Local does not need remote provisioning");
    const progress = (text: string) => {
      view.progress = text;
      this.changed();
    };
    return prepareRemoteRuntime(host, "", { signal, env: this.env, progress });
  }
  private async open(id: string, signal: AbortSignal): Promise<TuiHostView> {
    const view = this.views.get(id);
    if (!view) throw new Error("Unknown host");
    if (view.harness?.client.peer.ready) return view;
    await view.harness?.close();
    delete view.harness;
    delete view.error;
    const host = view.host;
    view.progress = "Connecting";
    this.changed();
    let transport: RemoteConnection | undefined;
    try {
      if (host.kind === "local") {
        const prepared = this.localLaunch
          ? { launch: this.localLaunch, close: async () => {} }
          : await prepareServerLaunch("background", signal);
        try {
          const local = await ensureLocalServer(
            defaultHome(),
            {
              ...prepared.launch,
              env: { ...prepared.launch.env, ...this.env },
            },
            signal,
          );
          transport = {
            connection: local.connection,
            failure: undefined,
            close: async () => local.close(),
          };
        } finally {
          await prepared.close();
        }
      } else {
        view.runtime = await this.prepare(view, signal);
        signal.throwIfAborted();
        transport = await connectRemote(host, view.runtime, { env: this.env, signal });
      }
      const ready = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const cancel = () => transport!.connection.dispose();
      ready.addEventListener("abort", cancel, { once: true });
      let harness: Harness;
      let identity: ServerIdentity;
      try {
        harness = await buildClientHarness(transport.connection, () => transport!.close(), ready);
        identity = await harness.client.peer.request(serverInfoRequest, {});
        ready.throwIfAborted();
      } finally {
        ready.removeEventListener("abort", cancel);
      }
      if (view.identity && view.identity.serverId !== identity.serverId)
        view.presentation = { drafts: new Map() };
      view.harness = harness;
      transport.connection.onClose(() => {
        view.error =
          "Connection lost. Reconnect for fresh server state; a last submission may have been accepted.";
        this.changed();
      });
      view.identity = identity;
      delete view.disconnected;
      return view;
    } catch (error) {
      view.error =
        transport?.failure?.message ?? (error instanceof Error ? error.message : String(error));
      await transport?.close();
      delete view.harness;
      throw error;
    } finally {
      delete view.progress;
      this.changed();
    }
  }
  cancel(id: string): void {
    this.operations.get(id)?.abort.abort();
  }
  async disconnect(id: string): Promise<void> {
    const pending = this.operations.get(id);
    if (pending) {
      pending.abort.abort();
      await pending.result.catch(() => undefined);
    }
    const view = this.views.get(id);
    if (view) {
      await view.harness?.close();
      delete view.harness;
      view.disconnected = true;
    }
    this.changed();
  }
  async reconnect(id: string): Promise<void> {
    await this.disconnect(id);
    await this.connect(id);
  }
  async refresh(id: string): Promise<void> {
    if (this.stopping) throw new Error("TUI is shutting down");
    if (this.operations.has(id)) throw new Error("Host operation is in progress");
    const abort = new AbortController();
    const result = this.configReady(abort.signal).then(async () => {
      if (this.stopping) throw new Error("TUI is shutting down");
      const view = this.views.get(id);
      if (!view) throw new Error("Unknown host");
      if (view.host.kind === "local") return view;
      try {
        view.runtime = await this.prepare(view, abort.signal);
        return view;
      } finally {
        delete view.progress;
        this.changed();
      }
    });
    this.operations.set(id, { kind: "refresh", abort, result });
    try {
      await result;
    } finally {
      this.operations.delete(id);
    }
  }
  async stop(id: string): Promise<void> {
    const view = this.views.get(id);
    if (!view?.identity) throw new Error("Connect before stopping this host");
    const harness = view.harness;
    if (view.host.kind !== "local" && !view.runtime)
      throw new Error("Missing prepared remote runtime");
    await runConnectionCommand(
      {
        type: "server.stop",
        ...(view.host.kind === "local"
          ? { host: view.host, runtime: null }
          : { host: view.host, runtime: view.runtime! }),
        identity: view.identity,
      },
      "",
      { env: this.env },
    );
    await harness?.close();
    if (view.harness === harness) {
      delete view.harness;
      view.disconnected = true;
      this.changed();
    }
  }
  async restart(id: string): Promise<void> {
    await this.refresh(id);
    await this.stop(id);
    await this.connect(id);
  }
  async close(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled(
      [...this.views.keys()].map((id) => this.disconnect(id)),
    );
    const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    if (errors.length) throw new AggregateError(errors, "Host disconnection failed");
  }
}
