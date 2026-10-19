import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { LocalExecutionContext } from "./local.ts";
import { discoverUserShellEnvironment, quoteShell, selectUserShell } from "./shell.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const bash = ["/bin/bash", "/usr/bin/bash"].find(existsSync);
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(existsSync);
async function fixture(shell: string) {
  const home = await mkdtemp(join(tmpdir(), "harness startup 'space-"));
  directories.push(home);
  return { home, env: { HOME: home, SHELL: shell, PATH: "/usr/bin:/bin" } };
}
async function command(context: LocalExecutionContext, source: string) {
  const child = context.spawn(source);
  let output = "";
  child.onData((chunk) => (output += chunk));
  const exit = await child.exit;
  expect(exit.code).toBe(0);
  return output;
}
function stopped(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A reparented zombie is no longer executing, but PID 1 in test containers may not reap it.
    return (
      process.platform === "linux" && /State:\s+Z/.test(readFileSync(`/proc/${pid}/status`, "utf8"))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

describe.skipIf(process.platform === "win32")("target-user startup exports", () => {
  it("uses the effective account when SHELL/HOME are absent and rejects unsupported selections", () => {
    const account = userInfo();
    if (account.shell?.endsWith("/bash") || account.shell?.endsWith("/zsh")) {
      expect(selectUserShell({}).executable).toBe(account.shell);
      expect(selectUserShell({}).env["HOME"]).toBe(account.homedir);
    }
    expect(() => selectUserShell({ SHELL: "bash" })).toThrow("absolute");
    expect(() => selectUserShell({ SHELL: "/bin/fish" })).toThrow("Unsupported user shell");
    expect(() => selectUserShell({ SHELL: "" })).toThrow("absolute");
  });

  it.runIf(bash)(
    "loads login profile, guarded/noisy Bash rc and BASH_ENV once, preserving exact exports only",
    async () => {
      const { home, env } = await fixture(bash!);
      const envHome = await mkdtemp(join(tmpdir(), "harness-bash-env-"));
      directories.push(envHome);
      const bashEnv = join(envHome, "env");
      await writeFile(
        join(home, ".bash_profile"),
        'export LOGIN_EXPORT=profile\nsource "$HOME/.bashrc"\n',
      );
      await writeFile(
        join(home, ".bashrc"),
        [
          'echo invocation >> "$HOME/rc-invocations"',
          "case $- in *i*) ;; *) return;; esac",
          "echo startup-noise; echo startup-warning >&2",
          'echo run >> "$HOME/rc-count"',
          'export EXACT_EXPORT="line one\nline two=value"',
          'alias startup_alias="echo should-not-persist"',
          "startup_function() { echo should-not-persist; }; export -f startup_function",
          'export PATH="$HOME/bin:$PATH"',
        ].join("\n"),
      );
      await writeFile(
        bashEnv,
        'echo bash-env-startup-noise\nexport COMMAND_EXPORT=once\necho env-run >> "$HOME/env-count"\n',
      );
      const shell = await discoverUserShellEnvironment({ env: { ...env, BASH_ENV: bashEnv } });
      expect(shell.kind).toBe("bash");
      expect(shell.env["LOGIN_EXPORT"]).toBe("profile");
      expect(shell.env["EXACT_EXPORT"]).toBe("line one\nline two=value");
      expect(shell.env["PATH"]).toContain(`${home}/bin:`);
      expect(shell.env["COMMAND_EXPORT"]).toBe("once");
      expect(shell.env["BASH_ENV"]).toBeUndefined();
      expect(Object.keys(shell.env).some((key) => key.startsWith("BASH_FUNC_"))).toBe(false);
      const context = new LocalExecutionContext(home, shell);
      expect(context.shellKind).toBe("bash");
      expect(
        await command(
          context,
          'printf "%s" "$EXACT_EXPORT"; ! type startup_alias >/dev/null 2>&1; ! type startup_function >/dev/null 2>&1',
        ),
      ).toBe("line one\nline two=value");
      await command(context, ":");
      expect(await readFile(join(home, "rc-count"), "utf8")).toBe("run\n");
      expect(await readFile(join(home, "rc-invocations"), "utf8")).toBe("invocation\n");
      expect(await readFile(join(home, "env-count"), "utf8")).toBe("env-run\n");
    },
  );

  it.runIf(bash)(
    "does not carry exported Bash options or intrinsic readonly state into fresh commands",
    async () => {
      const { home, env } = await fixture(bash!);
      await writeFile(
        join(home, ".bash_profile"),
        "set -o noclobber\nshopt -s nullglob\nexport SHELLOPTS BASHOPTS UID EUID PPID\n",
      );
      const shell = await discoverUserShellEnvironment({ env });
      expect(shell.env["SHELLOPTS"]).toBeUndefined();
      expect(shell.env["BASHOPTS"]).toBeUndefined();
      for (const key of ["UID", "EUID", "PPID"]) expect(shell.env[key]).toBeUndefined();
      const context = new LocalExecutionContext(home, shell);
      expect(
        await command(context, "[[ ! -o noclobber ]] && ! shopt -q nullglob && printf fresh"),
      ).toBe("fresh");
    },
  );

  it.runIf(bash)("drains a large successful export record before completing", async () => {
    const { home, env } = await fixture(bash!);
    await writeFile(join(home, ".bash_profile"), 'export LARGE_EXPORT=$(printf "%060000d" 0)\n');
    const shell = await discoverUserShellEnvironment({ env });
    expect(shell.env["LARGE_EXPORT"]).toBe("0".repeat(60000));
  });

  it.runIf(bash)(
    "bounds oversized private export data and reaps the startup child before rejecting",
    async () => {
      const { home, env } = await fixture(bash!);
      await writeFile(
        join(home, ".bash_profile"),
        [
          'echo $$ > "$HOME/startup-pid"',
          `${quoteShell(process.execPath)} -e ${quoteShell("process.stdout.write(Buffer.alloc(1024 * 1024 + 1))")} >&3`,
          "wait",
        ].join("\n"),
      );
      await expect(discoverUserShellEnvironment({ env })).rejects.toThrow("exceed 1 MiB");
      const pid = Number(await readFile(join(home, "startup-pid"), "utf8"));
      expect(stopped(pid)).toBe(true);
    },
  );

  for (const mode of ["cancel", "timeout", "failure"] as const) {
    it.runIf(bash && process.platform === "linux")(
      `bounds ${mode} with a detached descendant holding the private export descriptor`,
      async () => {
        const { home, env } = await fixture(bash!);
        await writeFile(
          join(home, ".bash_profile"),
          [
            'echo $$ > "$HOME/startup-pid"',
            `setsid ${quoteShell(process.execPath)} -e ${quoteShell('require("node:fs").writeFileSync(process.env.HOME + "/holder-pid", String(process.pid)); setTimeout(() => {}, 60000)')} >&3 &`,
            'while [ ! -e "$HOME/holder-pid" ]; do :; done',
            mode === "timeout" ? "exit 0" : mode === "failure" ? "exit 7" : "wait",
          ].join("\n"),
        );
        const controller = new AbortController();
        let outcome: unknown;
        const initialization = discoverUserShellEnvironment({
          env,
          signal: controller.signal,
          timeoutMs: mode === "timeout" ? 1500 : 10000,
        }).then(
          (value) => {
            outcome = value;
          },
          (error) => {
            outcome = error;
          },
        );
        let holder: number | undefined;
        let parent: number | undefined;
        try {
          await vi.waitFor(async () => {
            holder = Number(await readFile(join(home, "holder-pid"), "utf8"));
            parent = Number(await readFile(join(home, "startup-pid"), "utf8"));
            expect(Number.isSafeInteger(holder) && holder > 1).toBe(true);
            expect(Number.isSafeInteger(parent) && parent > 1).toBe(true);
          });
          expect(stopped(holder!)).toBe(false);
          if (mode === "timeout") await vi.waitFor(() => expect(stopped(parent!)).toBe(true));
          if (mode !== "failure") expect(outcome).toBeUndefined();
          if (mode === "cancel") controller.abort();
          await vi.waitFor(() => expect(outcome).toBeInstanceOf(Error), { timeout: 3000 });
          expect((outcome as Error).message).toContain(
            mode === "cancel" ? "cancelled" : mode === "failure" ? "exit 7" : "timed out",
          );
          // Failure is not delivered before physical exit, nor delayed by the escaped FD holder.
          expect(stopped(parent!)).toBe(true);
          expect(stopped(holder!)).toBe(false);
        } finally {
          controller.abort();
          for (const file of ["holder-pid", "startup-pid"]) {
            if (existsSync(join(home, file))) {
              const pid = Number(await readFile(join(home, file), "utf8"));
              if (Number.isSafeInteger(pid) && pid > 1) {
                if (!stopped(pid)) process.kill(pid, "SIGKILL");
                await vi.waitFor(() => expect(stopped(pid)).toBe(true));
              }
            }
          }
          await initialization;
        }
      },
    );
  }

  it.runIf(bash)(
    "follows native Bash login semantics instead of replaying a bashrc the login profile did not source",
    async () => {
      const { home, env } = await fixture(bash!);
      await writeFile(join(home, ".bash_profile"), "export LOGIN_ONLY=yes\n");
      await writeFile(join(home, ".bashrc"), "export RC_ONLY=yes\n");
      const shell = await discoverUserShellEnvironment({ env });
      expect(shell.env["LOGIN_ONLY"]).toBe("yes");
      expect(shell.env["RC_ONLY"]).toBeUndefined();
    },
  );

  it.runIf(zsh)(
    "honors ZDOTDIR and native zshenv/profile/guarded rc/login ordering without rerunning rc for commands",
    async () => {
      const { home, env } = await fixture(zsh!);
      const dotdir = await mkdtemp(join(tmpdir(), "harness zdotdir 'space-"));
      directories.push(dotdir);
      await writeFile(
        join(dotdir, ".zshenv"),
        'export STARTUP_ORDER=env\necho env >> "$HOME/zshenv-count"\n',
      );
      await writeFile(join(dotdir, ".zprofile"), 'export STARTUP_ORDER="$STARTUP_ORDER,profile"\n');
      await writeFile(
        join(dotdir, ".zshrc"),
        '[[ -o interactive ]] || return\necho noise\nexport STARTUP_ORDER="$STARTUP_ORDER,rc"\nalias startup_alias="echo no"\nstartup_function() { echo no; }\n',
      );
      await writeFile(join(dotdir, ".zlogin"), 'export STARTUP_ORDER="$STARTUP_ORDER,login"\n');
      const shell = await discoverUserShellEnvironment({ env: { ...env, ZDOTDIR: dotdir } });
      expect(shell.kind).toBe("zsh");
      expect(shell.env["STARTUP_ORDER"]).toBe("env,profile,rc,login");
      const context = new LocalExecutionContext(home, shell);
      expect(context.shellKind).toBe("zsh");
      expect(
        await command(
          context,
          'printf "%s" "$STARTUP_ORDER"; ! type startup_alias >/dev/null 2>&1; ! type startup_function >/dev/null 2>&1',
        ),
      ).toBe("env,profile,rc,login");
      expect(await readFile(join(home, "zshenv-count"), "utf8")).toBe("env\n");
    },
  );

  it.runIf(bash)(
    "matches native BASH_ENV pathname handling instead of evaluating or manually sourcing its value",
    async () => {
      const { home, env } = await fixture(bash!);
      await writeFile(join(home, ".bash_profile"), ":\n");
      const file = join(home, "native env");
      await writeFile(file, "export BASH_ENV_PATH_VALUE=native\n");
      for (const bashEnv of [file, "${HOME}/native env"]) {
        const inherited = { ...env, BASH_ENV: bashEnv };
        const native = spawnSync(bash!, ["-c", 'printf "%s" "${BASH_ENV_PATH_VALUE-}"'], {
          env: inherited,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(native.status).toBe(0);
        const captured = await discoverUserShellEnvironment({ env: inherited });
        expect(captured.env["BASH_ENV_PATH_VALUE"] ?? "").toBe(native.stdout);
      }
    },
  );

  for (const shell of [bash, zsh].filter((value): value is string => !!value)) {
    it(`reports explicit failing startup for ${shell}, without exposing startup content`, async () => {
      const { home, env } = await fixture(shell);
      await writeFile(
        join(home, shell.endsWith("zsh") ? ".zshrc" : ".bash_profile"),
        "echo secret-diagnostic >&2\nexit 7\n",
      );
      await expect(discoverUserShellEnvironment({ env })).rejects.toThrow("exit 7");
    });

    it(`bounds hanging startup and kills its process tree for ${shell}`, async () => {
      const { home, env } = await fixture(shell);
      await writeFile(
        join(home, shell.endsWith("zsh") ? ".zshrc" : ".bash_profile"),
        'sleep 60 &\necho $! > "$HOME/child-pid"\nwait\n',
      );
      const controller = new AbortController();
      const initialization = discoverUserShellEnvironment({ env, signal: controller.signal });
      // Observe the actual prerequisite rather than assuming startup has reached the fork.
      await vi.waitFor(() => expect(existsSync(join(home, "child-pid"))).toBe(true));
      const pid = Number(await readFile(join(home, "child-pid"), "utf8"));
      controller.abort();
      await expect(initialization).rejects.toThrow("cancelled");
      await vi.waitFor(() => expect(stopped(pid)).toBe(true));
    });

    it(`stops the fresh model-command process tree for ${shell}`, async () => {
      const { home, env } = await fixture(shell);
      await writeFile(join(home, shell.endsWith("zsh") ? ".zshrc" : ".bash_profile"), ":\n");
      const startup = await discoverUserShellEnvironment({ env });
      const context = new LocalExecutionContext(home, startup);
      const child = context.spawn('sleep 60 &\necho $! > "$HOME/command-child-pid"\nwait');
      try {
        await vi.waitFor(() => expect(existsSync(join(home, "command-child-pid"))).toBe(true));
        const pid = Number(await readFile(join(home, "command-child-pid"), "utf8"));
        child.kill();
        expect((await child.exit).signal).toBe("SIGTERM");
        await vi.waitFor(() => expect(stopped(pid)).toBe(true));
      } finally {
        child.kill();
      }
    });

    it(`bounds startup duration for ${shell}`, async () => {
      const { home, env } = await fixture(shell);
      await writeFile(join(home, shell.endsWith("zsh") ? ".zshrc" : ".bash_profile"), "sleep 60\n");
      await expect(discoverUserShellEnvironment({ env, timeoutMs: 100 })).rejects.toThrow(
        "timed out",
      );
    });
  }

  it.runIf(bash)(
    "rejects early successful exit without an export capture and missing executables",
    async () => {
      const { home, env } = await fixture(bash!);
      await writeFile(join(home, ".bash_profile"), "exit 0\n");
      await expect(discoverUserShellEnvironment({ env })).rejects.toThrow("complete export record");
      await expect(
        discoverUserShellEnvironment({ env: { ...env, SHELL: "/missing/bash" } }),
      ).rejects.toThrow("could not launch");
    },
  );
});
