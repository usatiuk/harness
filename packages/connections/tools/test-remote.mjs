import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, rm } from "node:fs/promises";
import process from "node:process";
import console from "node:console";

const exec = promisify(execFile);
const { canonicalHome } = await import("../src/local.ts");
const directory = await canonicalHome(join(tmpdir(), `harness-ssh-${randomUUID()}`));
const container = `harness-ssh-${randomUUID()}`;
let running = false;
try {
  await exec(
    "docker",
    ["build", "-t", "harness-ssh-qualification", "packages/connections/tests/ssh"],
    { maxBuffer: 1024 * 1024 },
  );
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(directory, "identity")], {
    windowsHide: true,
  });
  await exec("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "-p",
    "127.0.0.1::22",
    "harness-ssh-qualification",
  ]);
  running = true;
  await exec("docker", ["cp", join(directory, "identity.pub"), `${container}:/tmp/identity.pub`]);
  await exec("docker", [
    "exec",
    container,
    "sh",
    "-c",
    "install -d -m 700 -o harness -g harness /home/harness/.ssh; install -m 600 -o harness -g harness /tmp/identity.pub /home/harness/.ssh/authorized_keys",
  ]);
  const key = (
    await exec("docker", ["exec", container, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"])
  ).stdout
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
  const port = (await exec("docker", ["port", container, "22"])).stdout.trim().split(":").at(-1);
  await writeFile(join(directory, "known_hosts"), `[127.0.0.1]:${port} ${key}\n`);
  const sshPath = (path) => path.replaceAll("\\", "/");
  await writeFile(
    join(directory, "config"),
    `Host harness-fixture harness-password harness-unknown\n HostName 127.0.0.1\n Port ${port}\n User harness\n IdentityFile "${sshPath(join(directory, "identity"))}"\n IdentitiesOnly yes\nHost harness-fixture harness-password\n UserKnownHostsFile "${sshPath(join(directory, "known_hosts"))}"\n StrictHostKeyChecking yes\nHost harness-password\n PubkeyAuthentication no\n PreferredAuthentications password\nHost harness-unknown\n UserKnownHostsFile "${sshPath(join(directory, "unknown_hosts"))}"\n StrictHostKeyChecking ask\n`,
  );
  const child = spawn(
    process.execPath,
    [
      "--conditions=development",
      resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "packages/connections/src/remote.integration.test.ts",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, HARNESS_REMOTE_SSH_CONFIG: join(directory, "config") },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (running) await exec("docker", ["rm", "--force", container]);
  await rm(directory, { recursive: true, force: true });
}
