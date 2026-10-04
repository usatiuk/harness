import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultHome } from "@harness/config";
import {
  clientConfigSchema,
  serverInfoRequest,
  type ClientConfig,
  type Host,
  type ServerIdentity,
  type ConnectionCommand,
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
  constructor(
    readonly env: NodeJS.ProcessEnv = {},
    readonly localLaunch: ServerLaunch = {
      executable: process.execPath,
      args: [
        ...process.execArgv,
        fileURLToPath(import.meta.resolve("@harness/server/entry")),
        "--background",
      ],
    },
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
  accept(config: ClientConfig): void {
    this.config = config;
    for (const host of config.hosts) {
      const view = this.views.get(host.id);
      if (view) view.host = host;
      else this.views.set(host.id, { host, presentation: { drafts: new Map() } });
    }
    this.changed();
  }
  async initialize(destination?: string, selectedId?: string): Promise<void> {
    this.accept(
      await clientConfigSchema.parseAsync(await runConnectionCommand({ type: "config.read" }, "")),
    );
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

          runtime: { source: "managed" },
        };
        await this.edit({ type: "host.save", host });
        selectedId = host.id;
      }
    }
    if (selectedId)
      this.accept(
        clientConfigSchema.parse(
          await runConnectionCommand({ type: "host.select", id: selectedId }, ""),
        ),
      );
  }
  async edit(
    command: Extract<ConnectionCommand, { type: "host.save" | "host.remove" | "preferences" }>,
  ): Promise<void> {
    if (command.type === "host.save") {
      const current = this.views.get(command.host.id);
      if (current && JSON.stringify(current.host) !== JSON.stringify(command.host)) {
        await this.disconnect(command.host.id);
      }
    }
    if (command.type === "host.remove") await this.disconnect(command.id);
    this.accept(clientConfigSchema.parse(await runConnectionCommand(command, "")));
    if (command.type === "host.remove") this.views.delete(command.id);
  }
  async select(id: string): Promise<void> {
    this.accept(
      clientConfigSchema.parse(await runConnectionCommand({ type: "host.select", id }, "")),
    );
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
    const result = this.open(id, abort.signal);
    this.operations.set(id, { kind: "connect", abort, result });
    void result.finally(() => this.operations.delete(id)).catch(() => undefined);
    return result;
  }
  private async prepare(view: TuiHostView, signal: AbortSignal): Promise<PreparedRuntime> {
    const host = view.host;
    if (host.kind === "local") throw new Error("Local does not need remote provisioning");
    const progress = (text: string) => {
      view.progress = text;
      this.changed();
    };
    const configured = process.env["HARNESS_SERVER_PAYLOAD"];
    const payload = configured ?? (await mkdtemp(join(tmpdir(), "harness-tui-payload-")));
    try {
      if (!configured) {
        progress("Building current local server bundle");
        await promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(new URL("../../connections/tools/bundle-server.mjs", import.meta.url)),
            payload,
          ],
          { windowsHide: true, signal, timeout: 120_000, maxBuffer: 1024 * 1024 },
        );
      }
      return await prepareRemoteRuntime(host, payload, { signal, env: this.env, progress });
    } finally {
      if (!configured) await rm(payload, { recursive: true, force: true });
    }
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
        const local = await ensureLocalServer(defaultHome(), {
          ...this.localLaunch,
          env: { ...this.localLaunch.env, ...this.env },
        });
        transport = {
          connection: local.connection,
          failure: undefined,
          close: async () => local.close(),
        };
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
    const view = this.views.get(id);
    if (!view || view.host.kind === "local") return;
    if (this.operations.has(id)) throw new Error("Host operation is in progress");
    const abort = new AbortController();
    const result = (async () => {
      try {
        view.runtime = await this.prepare(view, abort.signal);
        return view;
      } finally {
        delete view.progress;
        this.changed();
      }
    })();
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
    await runConnectionCommand(
      {
        type: "server.stop",
        host: view.host,
        identity: view.identity,
        runtime: view.runtime ?? null,
      },
      "",
      { env: this.env },
    );
    await this.disconnect(id);
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
