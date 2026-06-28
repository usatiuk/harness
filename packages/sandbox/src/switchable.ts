import type { ByteRange, PluginEvent, ToolCall } from "@harness/protocol";
import type { ExecutionContext, OutputStore, Relationship } from "@harness/execution";
import { LocalExecutionContext } from "@harness/execution";
import { DockerExecutionContext } from "./docker.ts";
import type { SandboxConfig } from "./plugin.ts";

/**
 * Live control surface for the switching proxy: flip the substrate and drive the container lifecycle
 * without touching the engine's per-conversation service cache — the cached proxy is the mutability
 * seam that makes `/sandbox on|off` apply to the running conversation.
 */
export interface SandboxControl {
  /** Flip routing; on disable, tear down the container (best-effort, fire-and-forget). */
  setEnabled(next: boolean): void;
  readonly enabled: boolean;
  /** A container is provisioned or provisioning right now. */
  readonly running: boolean;
  /** Stop and re-provision the container (no-op when disabled). */
  rebuild(): Promise<void>;
  /** Tear down the container, keeping the enabled preference. */
  stop(): Promise<void>;
}

/**
 * An `ExecutionContext` whose substrate flips at runtime between local and docker, so `/sandbox on|off`
 * applies live. The engine caches one proxy per conversation; that cache now holds a mutable object,
 * which is what makes the toggle live — no config re-read or cache invalidation needed. IO delegates to
 * whichever substrate is active; `outputStore` always uses the local store (identical to docker's, and
 * avoids forcing a provision just to spill output). The docker context is created lazily when first
 * needed while enabled, and re-binds the captured emit so provisioning streams build progress.
 */
export class SwitchableSandboxContext implements ExecutionContext, SandboxControl {
  readonly workspaceRoot: string | null;
  readonly #local: LocalExecutionContext;
  readonly #config: SandboxConfig;
  #docker: DockerExecutionContext | undefined;
  #enabled: boolean;
  #emit: ((event: PluginEvent) => void) | undefined;

  constructor(root: string | null, config: SandboxConfig) {
    this.workspaceRoot = root;
    this.#config = config;
    this.#local = new LocalExecutionContext(root);
    this.#enabled = config.enabled;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get running(): boolean {
    return this.#docker?.isProvisioned() ?? false;
  }

  /** Lazily create (and memoize) the docker substrate, binding the captured emit if present. */
  #dockerCtx(): DockerExecutionContext {
    if (!this.#docker) {
      this.#docker = new DockerExecutionContext(this.workspaceRoot, this.#config);
      if (this.#emit) this.#docker.bind(this.#emit);
    }
    return this.#docker;
  }

  #active(): ExecutionContext {
    return this.#enabled ? this.#dockerCtx() : this.#local;
  }

  /** `executionOf` rebinds per call with the live tool context's emit; keep it cheap and idempotent. */
  bind(emit: (event: PluginEvent) => void): void {
    this.#emit = emit;
    this.#docker?.bind(emit);
  }

  read(path: string, range?: ByteRange): Promise<Uint8Array> {
    return this.#active().read(path, range);
  }
  stat(path: string): Promise<{ isDirectory: boolean } | undefined> {
    return this.#active().stat(path);
  }
  write(path: string, bytes: Uint8Array): Promise<void> {
    return this.#active().write(path, bytes);
  }
  remove(path: string): Promise<void> {
    return this.#active().remove(path);
  }
  list(pattern: string): Promise<string[]> {
    return this.#active().list(pattern);
  }
  spawn(command: string) {
    return this.#active().spawn(command);
  }
  classify(call: ToolCall): Relationship {
    return this.#active().classify(call);
  }
  outputStore(conversationId: string): OutputStore {
    // Identical to docker's store (host-side under the bind mount); avoid forcing a provision here.
    return this.#local.outputStore(conversationId);
  }

  setEnabled(next: boolean): void {
    if (next === this.#enabled) return;
    this.#enabled = next;
    // Tear down on disable; enabling needs no work — provisioning stays lazy on the next IO.
    // Best-effort, fire-and-forget: swallow rejections (e.g. docker missing) so they don't surface
    // as an unhandled rejection and take down the TUI.
    if (!next) void this.#docker?.stop().catch(() => {});
  }

  async rebuild(): Promise<void> {
    if (this.#enabled) await this.#dockerCtx().rebuild();
  }

  async stop(): Promise<void> {
    await this.#docker?.stop();
  }
}
