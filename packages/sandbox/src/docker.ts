import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix, relative, sep } from "node:path";
import type { ByteRange, PluginEvent, ToolCall } from "@harness/protocol";
import type {
  ExecutionContext,
  OutputStore,
  Relationship,
  SpawnedProcess,
} from "@harness/execution";
import { LocalOutputStore, matchGlob, streamProcess } from "@harness/execution";
import { capture, captureText } from "./docker-cli.ts";
import { type Provisioned } from "./devcontainer.ts";
import {
  DockerEnvironmentPool,
  type DockerEnvironment,
  type DockerOwner,
} from "./docker-environment.ts";
import type { DockerSandboxConfig } from "./config.ts";

/**
 * Runs the conversation's IO and commands inside the workspace's dev container. Every method goes
 * through `docker exec`, so file reads/writes and commands all act on the container's filesystem:
 * the agent reaches container-only files (installed tools, `/etc`, postCreate output), and the host
 * stays untouched beyond the bind-mounted workspace — the container is the confinement boundary.
 *
 * Provisioning (`devcontainer up`) is lazy and memoized: the first IO/command triggers it, with
 * build progress streamed via the emit channel captured in `bind`. `workspaceRoot` stays the HOST
 * path (for `classify` and the host-side output store); paths resolve against the container's
 * `remoteWorkspaceFolder`.
 */
export class DockerExecutionContext implements ExecutionContext {
  readonly workspaceRoot: string | null;
  readonly shellKind = "bash" as const;
  readonly #environment: Promise<DockerEnvironment> | undefined;
  #resolvedEnvironment: DockerEnvironment | undefined;
  readonly #owner: DockerOwner;
  readonly #lifetime = new AbortController();
  readonly #processes = new Set<SpawnedProcess>();
  readonly #io = new Set<Promise<unknown>>();
  #emit: ((event: PluginEvent) => void) | undefined;
  #disposed = false;
  #disposing: Promise<void> | undefined;
  readonly #managedTools = new Set<string>();

  constructor(
    hostRoot: string | null,
    config: DockerSandboxConfig,
    pool = new DockerEnvironmentPool(),
  ) {
    this.workspaceRoot = hostRoot;
    this.#owner = {
      idleTimeoutMinutes: config.idleTimeoutMinutes,
      emit: (event) => {
        if (!this.#disposed) this.#emit?.(event);
      },
    };
    if (hostRoot !== null) {
      this.#environment = pool.acquire(hostRoot, config, this.#owner).then((environment) => {
        this.#resolvedEnvironment = environment;
        return environment;
      });
      // The acquisition is observed by bind, IO, and disposal. It can begin before a client binds.
      void this.#environment.catch(() => {});
    }
  }

  bind(emit: (event: PluginEvent) => void): void | Promise<unknown> {
    this.#emit = emit;
    // Return the already-observed acquisition, rather than minting an unobserved rejected promise
    // when a synchronous tool accessor rebinds events. Prepare and IO await the same lifetime.
    return this.#environment;
  }

  async read(path: string, range?: ByteRange): Promise<Uint8Array> {
    // Range read via `dd` with byte-granular skip/count (GNU `iflag`), so a large block size still
    // reads exactly `[offset, offset+length)` in a couple of syscalls rather than one byte at a time.
    const r = await this.#withRetry((h) => {
      const cp = this.#cpath(h, path);
      const argv = range
        ? [...this.#exec(h), "dd", `if=${cp}`, "bs=65536", `skip=${range.offset}`, `count=${range.length}`, "iflag=skip_bytes,count_bytes", "status=none"] // prettier-ignore
        : [...this.#exec(h), "cat", "--", cp];
      return capture("docker", argv, { signal: this.#lifetime.signal });
    });
    if (r.exitCode !== 0) this.#fail("read", path, r);
    return r.stdout;
  }

  async stat(path: string): Promise<{ isDirectory: boolean } | undefined> {
    // One probe: `d`/`f`/empty — distinguishes directory, file, and absent without two round-trips.
    const r = await this.#withRetry((h) =>
      captureText(
        "docker",
        [
          ...this.#exec(h),
          "sh",
          "-c",
          'if [ -d "$1" ]; then echo d; elif [ -e "$1" ]; then echo f; fi',
          "sh",
          this.#cpath(h, path),
        ],
        { signal: this.#lifetime.signal },
      ),
    );
    if (r.exitCode !== 0) this.#fail("stat", path, r);
    const kind = r.stdout.trim();
    if (kind === "d") return { isDirectory: true };
    if (kind === "f") return { isDirectory: false };
    return undefined;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const r = await this.#withRetry((h) =>
      captureText(
        "docker",
        [
          ...this.#exec(h, { interactive: true }),
          "sh",
          "-c",
          'mkdir -p "$(dirname "$1")" && cat > "$1"',
          "sh",
          this.#cpath(h, path),
        ],
        { input: bytes, signal: this.#lifetime.signal },
      ),
    );
    if (r.exitCode !== 0) this.#fail("write", path, r);
  }

  async remove(path: string): Promise<void> {
    const r = await this.#withRetry((h) =>
      captureText("docker", [...this.#exec(h), "rm", "--", this.#cpath(h, path)], {
        signal: this.#lifetime.signal,
      }),
    );
    if (r.exitCode !== 0) this.#fail("remove", path, r);
  }

  async list(pattern: string): Promise<string[]> {
    if (!this.workspaceRoot) throw new Error("list requires a workspace");
    // Enumerate every path under the workspace, then filter host-side through the shared matcher.
    // `find` is invoked directly (no shell), so the pattern never reaches a shell and the result is
    // free of login-shell banner noise; the `( … )` are find's own grouping operators, passed as
    // plain argv. The pattern is never sent to the container at all. cwd = workspace ⇒ relative.
    const r = await this.#withRetry((h) => {
      const argv = [...this.#exec(h, { cwd: true }), "find", ".", "(", "-type", "f", "-o", "-type", "d", ")"]; // prettier-ignore
      return captureText("docker", argv, { signal: this.#lifetime.signal });
    });
    if (r.exitCode !== 0) this.#fail("list", pattern, r);
    const paths = r.stdout
      .split("\n")
      .map((line) => line.replace(/^\.\//, ""))
      .filter((line) => line && line !== ".");
    return matchGlob(paths, pattern);
  }

  spawn(command: string): SpawnedProcess {
    // docker exec does not forward signals to the in-container process, so tag the shell with a
    // unique marker (an inert trailing comment) and reap its process group by marker on kill.
    const marker = `harness_act_${randomUUID().slice(0, 8)}`;
    const script = `${command}\n# ${marker}`;
    const listeners: ((chunk: string) => void)[] = [];
    let child: ChildProcess | undefined;
    let killed = false;
    // The activity can remain unsettled while exited-client stdio drains. Never signal a process
    // group after the client terminal event, when its id may already belong to another process.
    let terminal = false;
    let resolveExit!: (r: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>(
      (res) => (resolveExit = res),
    );
    // A running command keeps the container busy: bump the in-flight count so an idle reap can't stop
    // it, and restart the idle clock when it ends.
    let endActivity: (() => void) | undefined;
    void exit.then(() => {
      endActivity?.();
      this.#processes.delete(handle);
    });

    const kill = (): void => {
      if (killed || terminal) return;
      killed = true;
      if (child === undefined) {
        terminal = true;
        resolveExit({ code: null, signal: "SIGTERM" });
        return;
      }
      void this.#reap(marker);
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // client already gone
        }
      }
    };

    // spawn() is synchronous but the container handle is async; start the exec once provisioned,
    // bridging its stream/exit into the SpawnedProcess we return immediately.
    const ready = this.#openEnvironment().then(async (environment) => {
      if (killed) return undefined;
      endActivity = environment.beginActivity();
      return this.#whileOpen(environment.ready());
    });
    void ready.then(
      (h) => {
        if (killed || !h) {
          terminal = true;
          resolveExit({ code: null, signal: "SIGTERM" });
          return;
        }
        const c = nodeSpawn("docker", [...this.#exec(h, { cwd: true }), "bash", "-lc", script], {
          detached: true,
          windowsHide: true,
        });
        child = c;
        c.once("exit", () => (terminal = true));
        c.once("error", () => (terminal = true));
        const inner = streamProcess(c, () => {});
        inner.onData((chunk) => {
          for (const l of listeners) l(chunk);
        });
        void inner.exit.then((result) => {
          terminal = true;
          resolveExit(result);
        });
      },
      (err: Error) => {
        if (terminal) return;
        for (const l of listeners) l(`sandbox provisioning failed: ${err.message}\n`);
        terminal = true;
        resolveExit({ code: 1, signal: null });
      },
    );

    const handle: SpawnedProcess = {
      get pid() {
        return child?.pid;
      },
      exit,
      onData: (listener) => listeners.push(listener),
      kill,
    };
    this.#processes.add(handle);
    return handle;
  }

  /** Output spills host-side under the bind-mounted workspace, so in-container reads still see it. */
  outputStore(conversationId: string): OutputStore {
    return new LocalOutputStore(this.workspaceRoot, conversationId);
  }

  /** Only tools registered as execution-managed are known to run inside the container boundary. */
  registerManagedTool(name: string): void {
    this.#managedTools.add(name);
  }

  classify(call: ToolCall): Relationship {
    return this.#managedTools.has(call.name) ? "in-workspace" : "unknown";
  }

  /** Explicit shared control: warn all owners, then perform the requested teardown. */
  async stop(): Promise<void> {
    await (await this.#openEnvironment()).stop();
  }

  /** Close only this handle's work, then release its resource ownership. */
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#disposed = true;
    this.#lifetime.abort();
    for (const process of this.#processes) process.kill();
    this.#disposing = (async () => {
      await Promise.allSettled([
        ...this.#io,
        ...[...this.#processes].map((process) => process.exit),
      ]);
      const environment = await this.#environment;
      await environment?.release(this.#owner);
    })();
    return this.#disposing;
  }

  async rebuild(signal?: AbortSignal): Promise<void> {
    const environment = await this.#openEnvironment();
    const rebuilding = environment.rebuild(signal);
    await this.#whileOpen(rebuilding, signal);
  }

  isProvisioned(): boolean {
    return this.#resolvedEnvironment?.isProvisioned() ?? false;
  }

  async #openEnvironment(): Promise<DockerEnvironment> {
    if (this.#disposed) throw new Error("Docker execution context is disposed");
    if (!this.#environment) throw new Error("sandbox requires a workspace root");
    return this.#whileOpen(this.#environment);
  }

  /** An owner's cancellation detaches its wait, never aborting another owner's shared build. */
  #whileOpen<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    const lifetime = signal
      ? AbortSignal.any([this.#lifetime.signal, signal])
      : this.#lifetime.signal;
    return new Promise<T>((resolvePromise, reject) => {
      const cancel = () => reject(new Error("Docker operation cancelled"));
      if (lifetime.aborted) {
        cancel();
      } else {
        lifetime.addEventListener("abort", cancel, { once: true });
      }
      void promise
        .then(resolvePromise, reject)
        .finally(() => lifetime.removeEventListener("abort", cancel));
    });
  }

  #workspaceFolder(h: Provisioned): string {
    if (!this.#resolvedEnvironment || this.workspaceRoot === null)
      throw new Error("Docker workspace has not been acquired");
    const suffix = relative(this.#resolvedEnvironment.root, this.workspaceRoot)
      .split(sep)
      .join("/");
    return posix.resolve(h.remoteWorkspaceFolder, suffix);
  }

  /** `docker exec` argv prefix as the remote user; `interactive` adds `-i`, `cwd` runs in the workspace. */
  #exec(h: Provisioned, opts?: { interactive?: boolean; cwd?: boolean }): string[] {
    return [
      "exec",
      ...(opts?.interactive ? ["-i"] : []),
      "-u",
      h.remoteUser,
      ...(opts?.cwd ? ["-w", this.#workspaceFolder(h)] : []),
      h.containerId,
    ];
  }

  /** Resolve a tool path (relative to the workspace, or absolute) to a container path. */
  #cpath(h: Provisioned, path: string): string {
    return posix.resolve(this.#workspaceFolder(h), path);
  }

  /**
   * Run `docker exec`, retrying ONCE if the container was torn down out-of-band (external `docker rm`,
   * `harness sandbox stop` in another terminal): re-provision and retry so external teardown self-heals
   * instead of surfacing a failed tool call. Only idempotent file ops go through this; `spawn` (side
   * effects) deliberately doesn't retry.
   */
  #withRetry<R extends { stderr: string; exitCode: number }>(
    build: (h: Provisioned) => Promise<R>,
  ): Promise<R> {
    const operation = this.#executeIO(build);
    this.#io.add(operation);
    void operation.then(
      () => this.#io.delete(operation),
      () => this.#io.delete(operation),
    );
    return operation;
  }

  async #executeIO<R extends { stderr: string; exitCode: number }>(
    build: (h: Provisioned) => Promise<R>,
  ): Promise<R> {
    const environment = await this.#openEnvironment();
    const endActivity = environment.beginActivity();
    try {
      const handle = await this.#whileOpen(environment.ready());
      const r = await build(handle);
      if (r.exitCode === 0 || !this.#isGone(r.stderr)) return r;
      await environment.invalidate(handle);
      return await build(await this.#whileOpen(environment.ready()));
    } finally {
      endActivity();
    }
  }

  /** Whether an exec failure means the container is gone (stopped/removed out-of-band). */
  #isGone(stderr: string): boolean {
    return /no such container|is not running/i.test(stderr);
  }

  /** Throw a uniform IO error. (Container-loss recovery is handled by `#withRetry`.) */
  #fail(op: string, path: string, r: { stderr: string; exitCode: number }): never {
    throw new Error(`${op} failed: ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  /** Best-effort reap of a spawned command's in-container process group, TERM then KILL. */
  async #reap(marker: string): Promise<void> {
    const h = await this.#resolvedEnvironment?.current();
    if (!h) return;
    const killGroup = (sig: string): string =>
      `for p in $(pgrep -f '${marker}' 2>/dev/null); do ` +
      `pg=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' '); ` +
      `[ -n "$pg" ] && kill -${sig} -"$pg" 2>/dev/null; done; true`;
    await captureText("docker", ["exec", h.containerId, "bash", "-lc", killGroup("TERM")]).catch(
      () => {},
    );
    setTimeout(() => {
      void captureText("docker", ["exec", h.containerId, "bash", "-lc", killGroup("KILL")]).catch(
        () => {},
      );
    }, 5000).unref();
  }
}
