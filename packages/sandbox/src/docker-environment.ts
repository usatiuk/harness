import { stat } from "node:fs/promises";
import { dockerInventory, controlDockerWorkspace } from "./docker-inventory.ts";
import { environmentName, workspaceProjectPrefix } from "./devcontainer.ts";
import { resolve } from "node:path";
import {
  containerRoot,
  provisionDevcontainer,
  stopSandbox,
  removeSandbox,
  type Provisioned,
  type SandboxStatus,
} from "./devcontainer.ts";
import type { DockerSandboxConfig } from "./config.ts";

export interface DockerOwner {
  emit(status: SandboxStatus): void;
}

/** Workspace lifetime is independent of conversation views. The server owns close(). */
export class DockerEnvironmentPool {
  readonly #environments = new Map<string, DockerEnvironment>();
  #closing = false;

  constructor(
    readonly scope?: string,
    private readonly beforeStart?: () => Promise<void>,
    private readonly metadataRoot?: string,
  ) {}

  async acquire(
    hostRoot: string,
    config: DockerSandboxConfig,
    owner: DockerOwner,
  ): Promise<DockerEnvironment> {
    if (this.#closing) throw new Error("Docker environment manager is closing");
    const root = await containerRoot(hostRoot);
    if (this.#closing) throw new Error("Docker environment manager is closing");
    const configPath = resolve(root, config.configPath);
    const identity = [root, configPath].map((path) =>
      process.platform === "win32" ? path.toLowerCase() : path,
    );
    const key = JSON.stringify(identity);
    let environment = this.#environments.get(key);
    if (!environment) {
      environment = new DockerEnvironment(
        root,
        configPath,
        this.scope,
        this.beforeStart,
        this.metadataRoot,
      );
      this.#environments.set(key, environment);
    }
    environment.attach(owner);
    return environment;
  }

  list() {
    return [...this.#environments.values()];
  }

  async inventory(limit: number, before?: string) {
    if (!this.scope) throw new Error("Docker manager has no server ownership scope");
    return (await dockerInventory(this.scope))
      .filter((row) => !before || row.id > before)
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        workspaceRoot: row.workspaceRoot,
        running: row.running,
        containers: row.containers.length,
      }));
  }

  async control(id: string, action: "stop" | "remove"): Promise<void> {
    if (!this.scope) throw new Error("Docker manager has no server ownership scope");
    const entry = [...this.#environments].find(
      ([, environment]) =>
        environmentName(environment.root, environment.configPath, this.scope) === id,
    );
    if (entry) {
      if (action === "stop") await entry[1].stop();
      else await entry[1].remove();
    } else await controlDockerWorkspace(this.scope, id, action);
  }

  async removeWorkspace(root: string): Promise<void> {
    for (const [key, environment] of this.#environments) {
      if (environment.root !== root) continue;
      await environment.remove();
      await environment.close();
      this.#environments.delete(key);
    }
    if (this.scope) {
      if (this.metadataRoot) {
        const marker = await stat(this.metadataRoot).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!marker) return;
      }
      for (const workspace of await dockerInventory(this.scope)) {
        if (
          workspace.workspaceRoot === root ||
          workspace.id.startsWith(workspaceProjectPrefix(root, this.scope))
        )
          await controlDockerWorkspace(this.scope, workspace.id, "remove");
      }
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    const results = await Promise.allSettled(this.list().map((environment) => environment.close()));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Could not stop Docker environments");
  }
}

/** Physical environment; a conversation view owns only its own IO and processes. */
export class DockerEnvironment {
  readonly #owners = new Set<DockerOwner>();
  #provision: Promise<Provisioned> | undefined;
  #abort: AbortController | undefined;
  #queuedStarts = new AbortController();
  #transition: Promise<void> = Promise.resolve();
  #stopped = false;
  #removed = false;
  #closed = false;
  closing: Promise<void> | undefined;

  constructor(
    readonly root: string,
    readonly configPath: string,
    readonly scope?: string,
    private readonly beforeStart?: () => Promise<void>,
    private readonly metadataRoot?: string,
  ) {}

  attach(owner: DockerOwner): void {
    if (this.#owners.has(owner)) throw new Error("Docker owner already attached");
    this.#owners.add(owner);
  }

  async release(owner: DockerOwner): Promise<void> {
    if (!this.#owners.delete(owner)) throw new Error("Docker owner is not attached");
  }

  /** Opening a conversation explicitly resumes a stopped environment. */
  start(): Promise<Provisioned> {
    const queued = this.#queuedStarts.signal;
    return this.#mutate(async () => {
      queued.throwIfAborted();
      if (this.#closed) throw new Error("Docker environment manager is closed");
      this.#removed = false;
      this.#stopped = false;
      return this.#startProvision();
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.stop();
  }

  async ready(): Promise<Provisioned> {
    await this.#transition;
    if (this.#closed) throw new Error("Docker environment manager is closed");
    if (this.#removed) throw new Error("Docker environment was removed");
    if (this.#stopped)
      throw new Error("Docker environment is stopped; reopen the conversation to start it");
    return this.#startProvision();
  }

  isProvisioned(): boolean {
    return this.#provision !== undefined && !this.#stopped;
  }

  async current(): Promise<Provisioned | undefined> {
    return this.#provision?.catch(() => undefined);
  }

  async invalidate(handle: Provisioned): Promise<void> {
    const provision = this.#provision;
    const current = await provision?.catch(() => undefined);
    if (this.#provision === provision && current === handle) this.#provision = undefined;
  }

  stop(): Promise<void> {
    this.#warn("Stopping");
    this.#stopped = true;
    this.#cancelProvision();
    return this.#mutate(async () => {
      this.#stopped = true;
      await this.#drainProvision();
      if (this.#removed) return;
      await stopSandbox(this.root, this.configPath, this.scope);
    });
  }

  remove(): Promise<void> {
    this.#warn("Removing");
    this.#stopped = true;
    this.#cancelProvision();
    return this.#mutate(async () => {
      this.#stopped = true;
      await this.#drainProvision();
      await removeSandbox(this.root, this.configPath, this.scope);
      this.#removed = true;
    });
  }

  rebuild(signal?: AbortSignal): Promise<void> {
    this.#warn("Rebuilding");
    this.#cancelProvision();
    const queued = this.#queuedStarts.signal;
    return this.#mutate(async () => {
      queued.throwIfAborted();
      if (this.#closed) throw new Error("Docker environment manager is closed");
      signal?.throwIfAborted();
      await this.#drainProvision();
      await removeSandbox(this.root, this.configPath, this.scope);
      signal?.throwIfAborted();
      queued.throwIfAborted();
      this.#stopped = false;
      this.#removed = false;
      const cancel = () => this.#abort?.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        await this.#startProvision();
      } catch (error) {
        this.#stopped = true;
        await this.#drainProvision();
        await stopSandbox(this.root, this.configPath, this.scope);
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    });
  }

  #cancelProvision(): void {
    this.#queuedStarts.abort(new Error("Docker start cancelled"));
    this.#queuedStarts = new AbortController();
    this.#abort?.abort();
  }

  #mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#transition.then(action, action);
    this.#transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #startProvision(): Promise<Provisioned> {
    if (this.#provision) return this.#provision;
    const abort = new AbortController();
    this.#abort = abort;
    const provision = (async () => {
      await this.beforeStart?.();
      abort.signal.throwIfAborted();
      return provisionDevcontainer(this.root, {
        configPath: this.configPath,
        ...(this.scope ? { scope: this.scope } : {}),
        ...(this.metadataRoot ? { metadataRoot: this.metadataRoot } : {}),
        signal: abort.signal,
        onStatus: (status) => {
          for (const owner of this.#owners) owner.emit(status);
        },
      });
    })();
    this.#provision = provision;
    void provision.catch(() => {
      if (this.#provision === provision) this.#provision = undefined;
    });
    return provision;
  }

  async #drainProvision(): Promise<void> {
    const provision = this.#provision;
    await provision?.catch(() => undefined);
    this.#provision = undefined;
    this.#abort = undefined;
  }

  #warn(action: string): void {
    if (this.#owners.size < 2) return;
    const message = `${action} the shared Docker environment affects ${this.#owners.size} conversations and may interrupt their running commands.`;
    for (const owner of this.#owners)
      owner.emit({ type: "sandbox.status", phase: "warning", message });
  }
}
