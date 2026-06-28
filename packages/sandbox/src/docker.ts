import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ByteRange, PluginEvent } from "@harness/protocol";
import type {
  ExecutionContext,
  OutputStore,
  Relationship,
  SpawnedProcess,
} from "@harness/execution";
import { LocalOutputStore, matchGlob, streamProcess } from "@harness/execution";
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
  #abort: AbortController | undefined;
  #emit: ((event: PluginEvent) => void) | undefined;
  /** Idle-reap timer; armed/re-armed on every IO, cleared on teardown. */
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** In-flight `spawn`s; an idle reap is deferred while any command is still running. */
  #inflight = 0;

  constructor(hostRoot: string | null, config: SandboxConfig) {
    this.workspaceRoot = hostRoot;
    this.#config = config;
  }

  /** Capture the latest emit channel so lazy provisioning can stream `sandbox.status` progress. */
  bind(emit: (event: PluginEvent) => void): void {
    this.#emit = emit;
  }

  async read(path: string, range?: ByteRange): Promise<Uint8Array> {
    // Range read via `dd` with byte-granular skip/count (GNU `iflag`), so a large block size still
    // reads exactly `[offset, offset+length)` in a couple of syscalls rather than one byte at a time.
    const r = await this.#withRetry((h) => {
      const cp = this.#cpath(h, path);
      const argv = range
        ? [...this.#exec(h), "dd", `if=${cp}`, "bs=65536", `skip=${range.offset}`, `count=${range.length}`, "iflag=skip_bytes,count_bytes", "status=none"] // prettier-ignore
        : [...this.#exec(h), "cat", "--", cp];
      return capture("docker", argv);
    });
    if (r.exitCode !== 0) this.#fail("read", path, r);
    return r.stdout;
  }

  async stat(path: string): Promise<{ isDirectory: boolean } | undefined> {
    // One probe: `d`/`f`/empty — distinguishes directory, file, and absent without two round-trips.
    const r = await this.#withRetry((h) =>
      captureText("docker", [
        ...this.#exec(h),
        "sh",
        "-c",
        'if [ -d "$1" ]; then echo d; elif [ -e "$1" ]; then echo f; fi',
        "sh",
        this.#cpath(h, path),
      ]),
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
        { input: bytes },
      ),
    );
    if (r.exitCode !== 0) this.#fail("write", path, r);
  }

  async remove(path: string): Promise<void> {
    const r = await this.#withRetry((h) =>
      captureText("docker", [...this.#exec(h), "rm", "--", this.#cpath(h, path)]),
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
      return captureText("docker", argv);
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
    let resolveExit!: (r: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>(
      (res) => (resolveExit = res),
    );
    // A running command keeps the container busy: bump the in-flight count so an idle reap can't stop
    // it, and restart the idle clock when it ends.
    this.#inflight++;
    void exit.finally(() => {
      this.#inflight--;
      this.#touch();
    });

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

  /**
   * Tear down the workspace's container(s) by id-label and drop the cached handle. Idempotent.
   *
   * Cancels any in-flight provision and AWAITS it before reaping: `devcontainer up` labels the
   * container as it creates it, so reaping mid-build could run `docker ps` before that container
   * exists and leave it orphaned. Aborting makes the build give up promptly; waiting for it to settle
   * guarantees the label filter then sees whatever it managed to create.
   */
  async stop(): Promise<void> {
    this.#clearIdleTimer();
    this.#abort?.abort();
    const inflight = this.#provision;
    this.#provision = undefined;
    this.#abort = undefined;
    if (inflight) await inflight.catch(() => {}); // rejection (incl. the abort) is expected here
    if (this.workspaceRoot) await stopSandbox(this.workspaceRoot);
  }

  /**
   * Throw the container away and provision a fresh one, streaming build progress. Backs `/sandbox
   * rebuild` to recover from a wedged or stale container: full `rm -f` teardown (re-runs postCreate),
   * then re-provision via the lazy `#ready` gate.
   */
  async rebuild(): Promise<void> {
    await this.stop();
    await this.#ready();
  }

  /**
   * Reset the idle clock. After `idleTimeoutMinutes` of no IO, a genuinely-idle container is stopped
   * (see `#reapIfIdle`). Unref'd so a pending timer never keeps the process (or a quit TUI) alive;
   * `0` disables idle reaping entirely.
   */
  #touch(): void {
    const minutes = this.#config.idleTimeoutMinutes;
    if (minutes <= 0) return;
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => void this.#reapIfIdle(), minutes * 60_000);
    this.#idleTimer.unref();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  /**
   * Idle-timer fire: stop the container, but only if it is genuinely unused. Re-arms instead of
   * reaping when a command is in flight or an interactive session (`harness sandbox shell`) is
   * attached — a long-running build or an open shell must never be killed out from under the user.
   * Stops (not removes) the container and drops the cached handle, so the next IO restarts it by
   * id-label with no postCreate; `rm -f` stays reserved for explicit teardown (`stop`).
   */
  async #reapIfIdle(): Promise<void> {
    this.#idleTimer = undefined;
    if (this.#inflight > 0 || (await this.#hasInteractiveSession())) {
      this.#touch(); // still busy — re-arm rather than reap
      return;
    }
    // The interactive probe is itself a `docker exec` round-trip; an IO arriving during it re-arms
    // the timer (every IO calls `#touch` via `#ready`) and may have just started a command. Bail if
    // so, rather than racing a `docker stop` against fresh work.
    if (this.#idleTimer !== undefined || this.#inflight > 0) return;
    const h = await this.#provision?.catch(() => undefined);
    if (!h) return;
    this.#provision = undefined;
    await captureText("docker", ["stop", h.containerId]).catch(() => {});
  }

  /**
   * Whether an interactive (`harness sandbox shell`, the only `-t` caller) is attached: it leaves a
   * numbered pty under `/dev/pts` (agent execs don't). Best-effort — treat a failed probe as busy,
   * since a wrongly-reaped container would kill an attached shell.
   */
  async #hasInteractiveSession(): Promise<boolean> {
    const h = await this.#provision?.catch(() => undefined);
    if (!h) return false;
    const r = await captureText("docker", [
      "exec",
      h.containerId,
      "sh",
      "-c",
      "ls -1 /dev/pts 2>/dev/null | grep -vc ptmx",
    ]).catch(() => undefined);
    if (!r) return true;
    return Number(r.stdout.trim()) > 0;
  }

  /** Whether a container has been (or is being) provisioned. */
  isProvisioned(): boolean {
    return this.#provision !== undefined;
  }

  #ready(): Promise<Provisioned> {
    this.#touch(); // the common IO gate: every read/write/spawn resets the idle clock
    if (this.#provision) return this.#provision;
    const root = this.workspaceRoot;
    if (!root) return Promise.reject(new Error("sandbox requires a workspace root"));
    const abort = new AbortController();
    this.#abort = abort;
    // Clear the cache on failure so a later call retries rather than wedging the conversation — but
    // only if this is still the current attempt, so a concurrent stop/rebuild isn't clobbered.
    const provision: Promise<Provisioned> = provisionDevcontainer(root, {
      configPath: this.#config.configPath,
      onStatus: (s) => this.#emit?.(s),
      signal: abort.signal,
    }).catch((err: unknown) => {
      if (this.#provision === provision) {
        this.#provision = undefined;
        this.#abort = undefined;
      }
      throw err;
    });
    this.#provision = provision;
    return provision;
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

  /**
   * Run `docker exec`, retrying ONCE if the container was torn down out-of-band (external `docker rm`,
   * `harness sandbox stop` in another terminal): re-provision and retry so external teardown self-heals
   * instead of surfacing a failed tool call. Only idempotent file ops go through this; `spawn` (side
   * effects) deliberately doesn't retry.
   */
  async #withRetry<R extends { stderr: string; exitCode: number }>(
    build: (h: Provisioned) => Promise<R>,
  ): Promise<R> {
    const r = await build(await this.#ready());
    if (r.exitCode === 0 || !this.#isGone(r.stderr)) return r;
    this.#provision = undefined; // container vanished — re-provision and retry once
    return build(await this.#ready());
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
