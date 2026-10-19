import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteShell } from "@harness/execution";
import { capture } from "./docker-cli.ts";
import {
  containerShellEnvironment,
  CONTAINER_COMMAND,
  encodeContainerEnvironment,
} from "./container-shell.ts";
import type { Provisioned } from "./devcontainer.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

/** A real process adapter substitutes only Docker transport; the target shell/rc and IO are real. */
async function target(shell: string) {
  const directory = await mkdtemp(join(tmpdir(), "harness container 'space-"));
  directories.push(directory);
  const getent = join(directory, "getent");
  await writeFile(
    getent,
    `#!/bin/sh\nprintf '%s\\n' ${quoteShell(`target-user:x:1000:1000::${directory}:${shell}`)}\n`,
  );
  await chmod(getent, 0o755);
  const executable = join(directory, "docker");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "set -eu",
      '[ "$1" = exec ]; shift',
      'if [ "${1-}" = -i ]; then shift; fi',
      '[ "$1" = -u ]; shift; [ "$1" = target-user ]; shift',
      '[ "$1" = fixture-container ]; shift',
      `exec /usr/bin/env -i HOME=/deliberately-wrong-container-home SHELL=${quoteShell(shell)} PATH=${quoteShell(`${directory}:/usr/bin:/bin`)} "$@"`,
    ].join("\n"),
  );
  await chmod(executable, 0o755);
  vi.stubEnv("PATH", `${directory}:${process.env["PATH"]}`);
  const handle: Provisioned = {
    containerId: "fixture-container",
    remoteUser: "target-user",
    remoteWorkspaceFolder: directory,
  };
  return { directory, handle };
}

describe.skipIf(process.platform !== "linux")(
  "container shell target adapter (not live Docker)",
  () => {
    it.each(["/bin/bash", "/bin/zsh"].filter(existsSync))(
      "captures %s target exports only once per physical handle, then executes fresh Bash",
      async (shell) => {
        const { directory, handle } = await target(shell);
        const rc =
          'echo startup-noise; echo warning >&2\necho run >> "$HOME/count"\nexport TARGET_EXPORT="target\nvalue=exact"\nalias target_alias="echo no"\ntarget_function() { echo no; }\n';
        if (shell.endsWith("bash")) {
          await writeFile(join(directory, ".bash_profile"), 'source "$HOME/.bashrc"\n');
          await writeFile(
            join(directory, ".bashrc"),
            "case $- in *i*) ;; *) return;; esac\nset -o noclobber\nshopt -s nullglob\nexport SHELLOPTS BASHOPTS UID EUID PPID\n" +
              rc,
          );
        } else {
          await writeFile(join(directory, ".zshrc"), "[[ -o interactive ]] || return\n" + rc);
        }
        const [first, second] = await Promise.all([
          containerShellEnvironment(handle),
          containerShellEnvironment(handle),
        ]);
        expect(first).toBe(second);
        expect(first["HOME"]).toBe(directory);
        expect(first["TARGET_EXPORT"]).toBe("target\nvalue=exact");
        expect(first["SHELL"]).toBe(shell);
        expect(first["SHELLOPTS"]).toBeUndefined();
        expect(first["BASHOPTS"]).toBeUndefined();
        for (const key of ["UID", "EUID", "PPID"]) expect(first[key]).toBeUndefined();
        const result = await capture(
          "docker",
          [
            "exec",
            "-i",
            "-u",
            handle.remoteUser,
            handle.containerId,
            "/usr/bin/env",
            "-i",
            "/bin/bash",
            "-c",
            CONTAINER_COMMAND,
            "harness-command",
            '[[ -n "$BASH_VERSION" ]] && [[ ! -o noclobber ]] && ! shopt -q nullglob && ! type target_alias >/dev/null 2>&1 && ! type target_function >/dev/null 2>&1 && printf "%s" "$TARGET_EXPORT"',
          ],
          { input: encodeContainerEnvironment(first) },
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout.toString()).toBe("target\nvalue=exact");
        expect(result.stderr).toBe("");
        expect(await readFile(join(directory, "count"), "utf8")).toBe("run\n");
      },
    );

    it("does not retry failing startup or leak startup diagnostics", async () => {
      const { directory, handle } = await target("/bin/bash");
      await writeFile(
        join(directory, ".bash_profile"),
        'echo secret >&2\necho run >> "$HOME/count"\nexit 9\n',
      );
      const first = containerShellEnvironment(handle);
      const second = containerShellEnvironment(handle);
      expect(first).toBe(second);
      await expect(first).rejects.toThrow("exit 9");
      await expect(second).rejects.not.toThrow("secret");
      expect(await readFile(join(directory, "count"), "utf8")).toBe("run\n");
    });

    it("rejects unsupported target selection rather than substituting a host shell", async () => {
      const { handle } = await target("/bin/fish");
      await expect(containerShellEnvironment(handle)).rejects.toThrow("exit 64");
    });

    it("bounds captured bytes and reports a killed capture as failure", async () => {
      await expect(
        capture("/bin/bash", ["-c", "printf '1234567890'"], { maxBytes: 2 }),
      ).rejects.toThrow("byte limit");
      expect((await capture("/bin/bash", ["-c", "kill -KILL $$"])).exitCode).not.toBe(0);
    });
  },
);
