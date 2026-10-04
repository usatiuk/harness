import {
  clientConfigSchema,
  preparedRuntimeSchema,
  serverInfoRequest,
  type ClientConfig,
  type Host,
  type ConnectionCommand,
  type ServerIdentity,
} from "@harness/connections";
import { DesktopSession } from "./session.ts";
import { connectionCommand, connectNative, disconnectNative } from "./transport.ts";

export interface HostView {
  host: Host;
  session?: DesktopSession;
  nativeId?: number;
  identity?: ServerIdentity;
  runtime?: ReturnType<typeof preparedRuntimeSchema.parse>;
  progress?: string;
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
  async initialize(): Promise<void> {
    this.acceptConfig(clientConfigSchema.parse(await connectionCommand({ type: "config.read" })));
    await this.connect(this.config!.selectedHostId).catch(() => undefined);
  }
  private acceptConfig(config: ClientConfig): void {
    this.config = config;
    for (const host of config.hosts) {
      const view = this.views.get(host.id);
      if (view) view.host = host;
      else this.views.set(host.id, { host });
    }
    this.changed();
  }
  async edit(
    command: Extract<ConnectionCommand, { type: "host.save" | "host.remove" | "preferences" }>,
  ): Promise<void> {
    if (command.type === "host.save") {
      const current = this.views.get(command.host.id);
      if (current && JSON.stringify(current.host) !== JSON.stringify(command.host))
        await this.disconnect(command.host.id);
    } else if (command.type === "host.remove") await this.disconnect(command.id);
    this.acceptConfig(clientConfigSchema.parse(await connectionCommand(command)));
    if (command.type === "host.remove") this.views.delete(command.id);
    this.changed();
  }
  async select(id: string): Promise<void> {
    this.acceptConfig(
      clientConfigSchema.parse(await connectionCommand({ type: "host.select", id })),
    );
    await this.connect(id);
  }
  connect(id: string): Promise<HostView> {
    const pending = this.operations.get(id);
    if (pending) {
      if (pending.kind !== "connect")
        return Promise.reject(new Error("Host upload is in progress"));
      return pending.result;
    }
    const abort = new AbortController();
    const result = this.open(id, abort.signal);
    this.operations.set(id, { kind: "connect", abort, result });
    void result.finally(() => this.operations.delete(id)).catch(() => undefined);
    return result;
  }
  private async open(id: string, signal: AbortSignal): Promise<HostView> {
    const view = this.views.get(id);
    if (!view) throw new Error("Unknown host");
    if (view.session && !view.session.disconnected) return view;
    if (view.nativeId !== undefined) await disconnectNative(view.nativeId);
    delete view.error;
    view.progress = "Connecting…";
    this.changed();
    try {
      if (view.host.kind !== "local") await this.prepare(view, signal);
      signal.throwIfAborted();
      view.progress = "Connecting…";
      this.changed();
      let session: DesktopSession | undefined = undefined;
      const transport = await connectNative(view.host, view.runtime ?? null, (message) => {
        session?.disconnect(message);
        if (view.session === session) {
          view.error = message;
          this.changed();
        }
      });
      view.nativeId = transport.id;
      session = new DesktopSession(transport.connection, id);
      const ready = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
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
        ready.removeEventListener("abort", cancel);
      }
      session.setServerScope(identity.serverId);
      view.session = session;
      session.subscribe(() => this.changed());
      view.identity = identity;
      return view;
    } catch (error) {
      if (view.nativeId !== undefined) await disconnectNative(view.nativeId);
      view.error = error instanceof Error ? error.message : String(error);
      delete view.nativeId;
      delete view.session;
      throw error;
    } finally {
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
    view.session?.client.closeConnection();
    if (view.nativeId !== undefined) await disconnectNative(view.nativeId);
    delete view.nativeId;
    delete view.session;
    this.changed();
  }
  async reconnect(id: string): Promise<void> {
    await this.disconnect(id);
    await this.connect(id);
  }
  async refresh(id: string): Promise<void> {
    const view = this.views.get(id);
    if (!view || view.host.kind === "local") return;
    if (this.operations.has(id)) throw new Error("Host operation is in progress");
    const abort = new AbortController();
    const result = this.prepare(view, abort.signal);
    this.operations.set(id, { kind: "refresh", result, abort });
    try {
      await result;
    } finally {
      this.operations.delete(id);
    }
  }
  cancel(id: string): void {
    this.operations.get(id)?.abort.abort();
  }
  private async prepare(view: HostView, signal: AbortSignal): Promise<HostView> {
    try {
      view.runtime = preparedRuntimeSchema.parse(
        await connectionCommand(
          { type: "runtime.prepare", host: view.host },
          (message) => {
            view.progress = message;
            this.changed();
          },
          signal,
        ),
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
    await connectionCommand({
      type: "server.stop",
      host: view.host,
      identity: view.identity,
      runtime: view.runtime ?? null,
    });
    await this.disconnect(id);
  }
  async restart(id: string): Promise<void> {
    await this.refresh(id);
    await this.stop(id);
    await this.connect(id);
  }
}
