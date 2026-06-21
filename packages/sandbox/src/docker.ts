import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ByteRange, PluginEvent, ToolContext } from "@harness/protocol";
import type {
  ExecutionContext,
  OutputStore,
  Relationship,
  SpawnedProcess,
} from "@harness/execution";
import { LocalOutputStore, streamProcess } from "@harness/execution";
import { capture, captureText } from "./docker-cli.ts";
import { provisionDevcontainer, stopSandbox, type Provisioned } from "./devcontainer.ts";
import type { SandboxConfig } from "./plugin.ts";

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
  readonly #config: SandboxConfig;
  #provision: Promise<Provisioned> | undefined;
  #emit: ((event: PluginEvent) => void) | undefined;

  constructor(hostRoot: string | null, config: SandboxConfig) {
    this.workspaceRoot = hostRoot;
    this.#config = config;
  }

  /** Capture the latest emit channel so lazy provisioning can stream `sandbox.status` progress. */
  bind(ctx: ToolContext): void {
    this.#emit = (event) => ctx.emit(event);
  }

  async read(path: string, range?: ByteRange): Promise<Uint8Array> {
    const h = await this.#ready();
    const cp = this.#cpath(h, path);
    // Range read via `dd` with byte-granular skip/count (GNU `iflag`), so a large block size still
    // reads exactly `[offset, offset+length)` in a couple of syscalls rather than one byte at a time.
    const argv = range
      ? [...this.#exec(h), "dd", `if=${cp}`, "bs=65536", `skip=${range.offset}`, `count=${range.length}`, "iflag=skip_bytes,count_bytes", "status=none"] // prettier-ignore
      : [...this.#exec(h), "cat", "--", cp];
    const r = await capture("docker", argv);
    if (r.exitCode !== 0) this.#fail("read", path, r);
    return r.stdout;
  }

  async stat(path: string): Promise<{ isDirectory: boolean } | undefined> {
    const h = await this.#ready();
    // One probe: `d`/`f`/empty — distinguishes directory, file, and absent without two round-trips.
    const r = await captureText("docker", [
      ...this.#exec(h),
      "sh",
      "-c",
      'if [ -d "$1" ]; then echo d; elif [ -e "$1" ]; then echo f; fi',
      "sh",
      this.#cpath(h, path),
    ]);
    if (r.exitCode !== 0) this.#fail("stat", path, r);
    const kind = r.stdout.trim();
    if (kind === "d") return { isDirectory: true };
    if (kind === "f") return { isDirectory: false };
    return undefined;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const h = await this.#ready();
    const r = await captureText(
      "docker",
      [
        ...this.#exec(h, { interactive: true }),
        "sh",
        "-c",
        'mkdir -p "$(dirname "$1")" && cat > "$1"',
        "sh",
        this.#cpath(h, path),
      ],
      { input: bytes },
    );
    if (r.exitCode !== 0) this.#fail("write", path, r);
  }

  async remove(path: string): Promise<void> {
    const h = await this.#ready();
    const r = await captureText("docker", [...this.#exec(h), "rm", "--", this.#cpath(h, path)]);
    if (r.exitCode !== 0) this.#fail("remove", path, r);
  }

  async list(pattern: string): Promise<string[]> {
    if (!this.workspaceRoot) throw new Error("list requires a workspace");
    const h = await this.#ready();
    // Pass the pattern as a positional ($1), never interpolated: bash glob-expands the value but does
    // not re-scan it for command substitution, so `$(...)`/backticks in a pattern can't execute.
    // `IFS=` disables word splitting so a pattern with spaces stays one glob (matching node-glob);
    // `globstar` gives `**` (dotfiles excluded by default, like node `dot:false`). `nullglob` drops a
    // glob with no match, and the `[ -e ]` guard drops a literal pattern (no glob chars) that doesn't
    // exist — together that matches node-glob's "existing matches only". cwd = workspace ⇒ relative.
    const script = `shopt -s globstar nullglob; IFS=; for f in $1; do if [ -e "$f" ]; then printf '%s\\n' "$f"; fi; done`; // prettier-ignore
    const r = await captureText("docker", [...this.#exec(h, { cwd: true }), "bash", "-lc", script, "bash", pattern]); // prettier-ignore
    if (r.exitCode !== 0) this.#fail("list", pattern, r);
    return r.stdout.split("\n").filter(Boolean).sort();
  }

  spawn(command: string): SpawnedProcess {
    // docker exec does not forward signals to the in-container process, so tag the shell with a
    // unique marker (an inert trailing comment) and reap its process group by marker on kill.
    const marker = `harness_act_${randomUUID().slice(0, 8)}`;
    const script = `${command}\n# ${marker}`;
    const listeners: ((chunk: string) => void)[] = [];
    let child: ChildProcess | undefined;
    let killed = false;
    let resolveExit!: (r: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>(
      (res) => (resolveExit = res),
    );

    const kill = (): void => {
      if (killed) return;
      killed = true;
      void this.#reap(marker);
      if (child?.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // client already gone
        }
      }
    };

    // spawn() is synchronous but the container handle is async; start the exec once provisioned,
    // bridging its stream/exit into the SpawnedProcess we return immediately.
    void this.#ready().then(
      (h) => {
        if (killed) {
          resolveExit({ code: null, signal: "SIGTERM" });
          return;
        }
        const c = nodeSpawn("docker", [...this.#exec(h, { cwd: true }), "bash", "-lc", script], {
          detached: true,
        });
        child = c;
        const inner = streamProcess(c, () => {});
        inner.onData((chunk) => {
          for (const l of listeners) l(chunk);
        });
        void inner.exit.then(resolveExit);
      },
      (err: Error) => {
        for (const l of listeners) l(`sandbox provisioning failed: ${err.message}\n`);
        resolveExit({ code: 1, signal: null });
      },
    );

    return {
      get pid() {
        return child?.pid;
      },
      exit,
      onData: (listener) => listeners.push(listener),
      kill,
    };
  }

  /** Output spills host-side under the bind-mounted workspace, so in-container reads still see it. */
  outputStore(conversationId: string): OutputStore {
    return new LocalOutputStore(this.workspaceRoot, conversationId);
  }

  /**
   * The container is the trust boundary, so every call is "in-workspace": with the default approval
   * policy (`inWorkspace: allow`) the agent acts prompt-free inside the sandbox. File IO routes
   * through the container, so it cannot reach host paths outside the bind mount regardless.
   */
  classify(): Relationship {
    return "in-workspace";
  }

  /** Tear down the workspace's container(s) by id-label and drop the cached handle. Idempotent. */
  async stop(): Promise<void> {
    this.#provision = undefined;
    if (this.workspaceRoot) await stopSandbox(this.workspaceRoot);
  }

  /** Stop the container then re-provision (streaming progress via the bound emit). */
  async rebuild(): Promise<Provisioned> {
    await this.stop();
    return this.#ready();
  }

  #ready(): Promise<Provisioned> {
    if (!this.#provision) {
      const root = this.workspaceRoot;
      if (!root) return Promise.reject(new Error("sandbox requires a workspace root"));
      // Clear the cache on failure so a later call retries rather than wedging the conversation.
      this.#provision = provisionDevcontainer(root, {
        configPath: this.#config.configPath,
        onStatus: (s) => this.#emit?.(s),
      }).catch((err: unknown) => {
        this.#provision = undefined;
        throw err;
      });
    }
    return this.#provision;
  }

  /** `docker exec` argv prefix as the remote user; `interactive` adds `-i`, `cwd` runs in the workspace. */
  #exec(h: Provisioned, opts?: { interactive?: boolean; cwd?: boolean }): string[] {
    return [
      "exec",
      ...(opts?.interactive ? ["-i"] : []),
      "-u",
      h.remoteUser,
      ...(opts?.cwd ? ["-w", h.remoteWorkspaceFolder] : []),
      h.containerId,
    ];
  }

  /** Resolve a tool path (relative to the workspace, or absolute) to a container path. */
  #cpath(h: Provisioned, path: string): string {
    return posix.resolve(h.remoteWorkspaceFolder, path);
  }

  /** Note possible container loss, then throw a uniform IO error. */
  #fail(op: string, path: string, r: { stderr: string; exitCode: number }): never {
    this.#checkLiveness(r.stderr);
    throw new Error(`${op} failed: ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  /**
   * If an exec failed because the container is gone (stopped from elsewhere, e.g. `harness sandbox
   * stop` or the overlay), drop the cached handle so the next call re-provisions instead of wedging
   * the conversation on a dead container id.
   */
  #checkLiveness(stderr: string): void {
    if (/no such container|is not running/i.test(stderr)) this.#provision = undefined;
  }

  /** Best-effort reap of a spawned command's in-container process group, TERM then KILL. */
  async #reap(marker: string): Promise<void> {
    const h = await this.#provision?.catch(() => undefined);
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
