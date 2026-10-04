import { resolve } from "node:path";
import { captureText } from "./docker-cli.ts";
import {
  containerRoot,
  provisionDevcontainer,
  stopSandbox,
  type Provisioned,
  type SandboxStatus,
} from "./devcontainer.ts";
import type { DockerSandboxConfig } from "./config.ts";

export interface DockerOwner {
  readonly idleTimeoutMinutes: number;
  emit(status: SandboxStatus): void;
}

/** One pool per sandbox plugin composition, never process-global or owned by the kernel. */
export class DockerEnvironmentPool {
  readonly #environments = new Map<string, DockerEnvironment>();

  async acquire(
    hostRoot: string,
    config: DockerSandboxConfig,
    owner: DockerOwner,
  ): Promise<DockerEnvironment> {
    const root = await containerRoot(hostRoot);
    const configPath = resolve(root, config.configPath);
    const pathKey = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
    const key = JSON.stringify([pathKey(root), pathKey(configPath)]);
    for (;;) {
      let environment = this.#environments.get(key);
      if (environment?.closing) {
        await environment.closing;
        continue;
      }
      if (!environment) {
        environment = new DockerEnvironment(root, configPath, () => {
          if (this.#environments.get(key) === environment) this.#environments.delete(key);
        });
        this.#environments.set(key, environment);
      }
      environment.attach(owner);
      return environment;
    }
  }
}

/** Owns the physical resource. Conversation views own their IO/process handles separately. */
export class DockerEnvironment {
  readonly #owners = new Set<DockerOwner>();
  #provision: Promise<Provisioned> | undefined;
  #abort: AbortController | undefined;
  #transition: Promise<void> = Promise.resolve();
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #busy = 0;
  #used = false;
  closing: Promise<void> | undefined;

  constructor(
    readonly root: string,
    readonly configPath: string,
    readonly onClosed: () => void,
  ) {}

  attach(owner: DockerOwner): void {
    if (this.closing) throw new Error("cannot attach to a closing Docker environment");
    if (this.#owners.has(owner)) throw new Error("Docker owner already attached");
    this.#owners.add(owner);
    this.#touch();
  }

  release(owner: DockerOwner): Promise<void> {
    if (!this.#owners.delete(owner)) throw new Error("Docker owner is not attached");
    if (this.#owners.size > 0) {
      this.#touch();
      return Promise.resolve();
    }
    this.#clearIdleTimer();
    this.#abort?.abort();
    this.closing = this.#mutate(() => this.#stop(false)).finally(this.onClosed);
    return this.closing;
  }

  /** Held through provisioning and every IO/command until its observable completion. */
  beginActivity(): () => void {
    if (this.closing) throw new Error("Docker environment is closing");
    this.#busy++;
    this.#touch();
    let ended = false;
    return () => {
      if (ended) throw new Error("Docker activity already ended");
      ended = true;
      this.#busy--;
      this.#touch();
    };
  }

  async ready(): Promise<Provisioned> {
    await this.#transition;
    if (this.closing) throw new Error("Docker environment is closing");
    this.#touch();
    return this.#startProvision();
  }

  isProvisioned(): boolean {
    return this.#provision !== undefined;
  }

  /** Current handle for killing a view's own processes; never provisions during teardown. */
  async current(): Promise<Provisioned | undefined> {
    return this.#provision?.catch(() => undefined);
  }

  async invalidate(handle: Provisioned): Promise<void> {
    // A stale IO failure cannot discard a new handle installed by a shared rebuild.
    const provision = this.#provision;
    const current = await provision?.catch(() => undefined);
    if (this.#provision === provision && current === handle) this.#provision = undefined;
  }

  stop(): Promise<void> {
    this.#warn("Stopping");
    return this.#mutate(() => this.#stop(true));
  }

  rebuild(signal?: AbortSignal): Promise<void> {
    this.#warn("Rebuilding");
    return this.#mutate(async () => {
      if (signal?.aborted) throw new Error("sandbox rebuild cancelled");
      await this.#stop(true);
      if (signal?.aborted || this.closing) throw new Error("sandbox rebuild cancelled");
      const cancel = () => {
        if (this.#owners.size === 1) this.#abort?.abort();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        await this.#startProvision();
      } catch (error) {
        if (signal?.aborted) await this.#stop(false);
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    });
  }

  #mutate(action: () => Promise<void>): Promise<void> {
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
    let started = false;
    const provision = provisionDevcontainer(this.root, {
      configPath: this.configPath,
      signal: abort.signal,
      onStarted: () => {
        started = true;
        this.#used = true;
      },
      onStatus: (status) => {
        for (const owner of this.#owners) owner.emit(status);
      },
    })
      .catch(async (error: unknown) => {
        // Failed builds may have created labeled resources before returning a handle. Reap before
        // admitting a retry. Explicit stop/last release owns cleanup of an aborted attempt.
        if (started && !abort.signal.aborted) {
          try {
            await stopSandbox(this.root, this.configPath);
            this.#used = false;
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Docker provisioning and cleanup failed",
              { cause: cleanupError },
            );
          }
        }
        throw error;
      })
      .finally(() => {
        if (this.#provision === provision && abort.signal.aborted) this.#provision = undefined;
      });
    this.#provision = provision;
    // Rejections remain observable to all users of the attempt; a later operation can retry.
    void provision.catch(() => {
      if (this.#provision === provision) this.#provision = undefined;
    });
    return provision;
  }

  async #stop(explicit: boolean): Promise<void> {
    this.#clearIdleTimer();
    this.#abort?.abort();
    const provision = this.#provision;
    this.#provision = undefined;
    this.#abort = undefined;
    await provision?.catch(() => undefined);
    if (explicit || this.#used) await stopSandbox(this.root, this.configPath);
    this.#used = false;
    this.#clearIdleTimer();
  }

  #warn(action: string): void {
    if (this.#owners.size < 2) return;
    const message = `${action} the shared Docker environment affects ${this.#owners.size} conversations and may interrupt their running commands.`;
    for (const owner of this.#owners)
      owner.emit({ type: "sandbox.status", phase: "warning", message });
  }

  #touch(): void {
    this.#clearIdleTimer();
    if (this.closing || this.#owners.size === 0) return;
    const timeouts = [...this.#owners].map((owner) => owner.idleTimeoutMinutes);
    if (timeouts.includes(0)) return;
    this.#idleTimer = setTimeout(() => void this.#reapIfIdle(), Math.max(...timeouts) * 60_000);
    this.#idleTimer.unref();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  async #reapIfIdle(): Promise<void> {
    this.#idleTimer = undefined;
    if (this.#busy > 0 || this.closing) {
      this.#touch();
      return;
    }
    const h = await this.current();
    if (!h) return;
    const probe = await captureText("docker", [
      "exec",
      h.containerId,
      "sh",
      "-c",
      'entries=$(ls -1 /dev/pts 2>/dev/null) || exit 1; printf "%s\\n" "$entries" | awk \'NF && $0 != "ptmx" { n++ } END { print n+0 }\'',
    ]).catch(() => undefined);
    if (!probe || probe.exitCode !== 0 || Number(probe.stdout.trim()) > 0) {
      this.#touch();
      return;
    }
    // IO/controls may arrive while the interactive-session probe is outstanding.
    if (this.#idleTimer !== undefined || this.#busy > 0 || this.closing) return;
    await this.#mutate(async () => {
      if (this.#idleTimer !== undefined || this.#busy > 0 || this.closing) return;
      const current = await this.current();
      if (current !== h) return;
      const stopped = await captureText("docker", ["stop", h.containerId]).catch(
        (error: unknown) => {
          // The CLI may become unavailable between the probe and stop. This is a process edge;
          // preserve the handle and retry only at the next bounded idle boundary.
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            (error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "EPERM")
          )
            throw error;
          for (const owner of this.#owners)
            owner.emit({
              type: "sandbox.status",
              phase: "error",
              message: `Could not idle-stop Docker (${error.code}); retaining the environment.`,
            });
          return undefined;
        },
      );
      if (!stopped || stopped.exitCode !== 0) {
        this.#touch();
        return;
      }
      this.#provision = undefined;
    });
  }
}
