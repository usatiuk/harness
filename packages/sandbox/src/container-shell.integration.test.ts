import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quoteShell, SHELL_STARTUP_TIMEOUT_MS } from "@harness/execution";
import { capture, captureText } from "./docker-cli.ts";
import {
  containerShellEnvironment,
  CONTAINER_COMMAND,
  encodeContainerEnvironment,
} from "./container-shell.ts";
import type { Provisioned } from "./devcontainer.ts";

// Explicitly opt in to a cached local image: never pull/build or touch existing containers.
const image = process.env["HARNESS_DOCKER_SHELL_TEST_IMAGE"];
describe.skipIf(!image)("container startup exports (live Docker, owned no-network fixture)", () => {
  let id = "";
  let handle: Provisioned;
  async function target(source: string) {
    const result = await captureText("docker", ["exec", id, "/bin/sh", "-c", source]);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  }
  beforeAll(async () => {
    const result = await captureText("docker", [
      "run",
      "--pull=never",
      "--network=none",
      "--rm",
      "-d",
      "--label",
      `harness.shell-probe=${randomUUID()}`,
      "-e",
      "SHELL=/bin/bash",
      "-e",
      "HOME=/root", // Deliberately wrong for the non-root remoteUser regression.
      "-e",
      "BASH_ENV=/root/harness-env",
      "--entrypoint",
      "/bin/sleep",
      image!,
      "120",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    id = result.stdout.trim();
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    handle = { containerId: id, remoteUser: "root", remoteWorkspaceFolder: "/root" };
  });
  afterAll(async () => {
    if (id) {
      const result = await captureText("docker", ["rm", "-f", id]);
      expect(result.exitCode, result.stderr).toBe(0);
    }
  });

  it("uses target login/guarded rc/BASH_ENV exports exactly once and executes startup-free Bash", async () => {
    const rc = [
      "case $- in *i*) ;; *) return;; esac",
      "echo noisy-rc; echo noisy-stderr >&2",
      "echo run >> /root/rc-count",
      'export TARGET_VALUE="line one\nline two=value"',
      'alias target_alias="echo no"',
      "target_function() { echo no; }; export -f target_function",
      "set -o noclobber",
      "shopt -s nullglob",
      "export SHELLOPTS BASHOPTS UID EUID PPID",
    ].join("\n");
    const env = "echo noisy-bash-env\nexport TARGET_BASH_ENV=native\necho run >> /root/env-count\n";
    await target(
      `printf %s ${quoteShell('source "$HOME/.bashrc"\n')} > /root/.bash_profile; printf %s ${quoteShell(rc)} > /root/.bashrc; printf %s ${quoteShell(env)} > /root/harness-env`,
    );
    const exports = await containerShellEnvironment(handle);
    expect(exports["HOME"]).toBe("/root");
    expect(exports["TARGET_VALUE"]).toBe("line one\nline two=value");
    expect(exports["TARGET_BASH_ENV"]).toBe("native");
    expect(exports["BASH_ENV"]).toBeUndefined();
    expect(exports["SHELLOPTS"]).toBeUndefined();
    expect(exports["BASHOPTS"]).toBeUndefined();
    const result = await capture(
      "docker",
      [
        "exec",
        "-i",
        "-u",
        "root",
        id,
        "/usr/bin/env",
        "-i",
        "/bin/bash",
        "--norc",
        "-c",
        CONTAINER_COMMAND,
        "harness-command",
        '[[ ! -o noclobber ]] && ! shopt -q nullglob && ! type target_alias >/dev/null 2>&1 && ! type target_function >/dev/null 2>&1 && printf "%s" "$TARGET_VALUE"',
      ],
      { input: encodeContainerEnvironment(exports) },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.toString()).toBe("line one\nline two=value");
    expect(await target("cat /root/rc-count /root/env-count")).toBe("run\nrun\n");
    expect(await containerShellEnvironment(handle)).toBe(exports);
  });

  it("resolves non-root remoteUser HOME from the target account, not container or client HOME", async () => {
    await target(
      `useradd -m -d /home/shell-target -s /bin/bash shell-target; printf %s ${quoteShell('export TARGET_ACCOUNT_PROFILE=loaded\necho run >> "$HOME/profile-count"\n')} > /home/shell-target/.bash_profile; chown shell-target:shell-target /home/shell-target/.bash_profile`,
    );
    const remote: Provisioned = {
      ...handle,
      remoteUser: "shell-target",
      remoteWorkspaceFolder: "/home/shell-target",
    };
    // Docker exec -u changes identity but retains the deliberately incorrect container HOME.
    const inherited = await captureText("docker", [
      "exec",
      "-u",
      remote.remoteUser,
      id,
      "/usr/bin/env",
    ]);
    expect(inherited.exitCode).toBe(0);
    expect(inherited.stdout.split("\n")).toContain("HOME=/root");
    const exports = await containerShellEnvironment(remote);
    expect(exports["HOME"]).toBe("/home/shell-target");
    expect(exports["TARGET_ACCOUNT_PROFILE"]).toBe("loaded");
    const result = await capture(
      "docker",
      [
        "exec",
        "-i",
        "-u",
        remote.remoteUser,
        id,
        "/usr/bin/env",
        "-i",
        "/bin/bash",
        "--norc",
        "-c",
        CONTAINER_COMMAND,
        "harness-command",
        'printf "%s:%s" "$HOME" "$TARGET_ACCOUNT_PROFILE"',
      ],
      { input: encodeContainerEnvironment(exports) },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.toString()).toBe("/home/shell-target:loaded");
    expect(await target("cat /home/shell-target/profile-count")).toBe("run\n");
  });

  it("reports target startup failure without silently reinitializing the existing owner", async () => {
    await target("printf 'exit 7\\n' > /root/.bash_profile");
    expect((await containerShellEnvironment(handle))["TARGET_VALUE"]).toBe(
      "line one\nline two=value",
    );
    await expect(containerShellEnvironment({ ...handle })).rejects.toThrow("exit 7");
  });

  it(
    "bounds hanging target startup and terminates its process group even without a persistent terminal",
    async () => {
      await target(
        `printf %s ${quoteShell("sleep 60 &\necho $! > /root/hang-pid\nwait\n")} > /root/.bash_profile`,
      );
      await expect(containerShellEnvironment({ ...handle })).rejects.toThrow("exit 137");
      const pid = Number((await target("cat /root/hang-pid")).trim());
      expect(Number.isSafeInteger(pid)).toBe(true);
      await target(`test ! -e /proc/${pid}/status || grep -q '^State:.*Z' /proc/${pid}/status`);
    },
    SHELL_STARTUP_TIMEOUT_MS + 5000,
  );
});
