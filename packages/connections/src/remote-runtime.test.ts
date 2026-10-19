import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_PIN, type LinuxTarget } from "@harness/release";
import { prepareRemoteRuntime, shellQuote } from "./remote.ts";

const edge = vi.hoisted<{ env: NodeJS.ProcessEnv; scripts: string[] }>(() => ({
  env: {},
  scripts: [],
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((executable: string, args: string[], options: SpawnOptionsWithoutStdio) => {
      if (executable !== "ssh" && executable !== "wsl.exe")
        throw new Error(`Unexpected transport: ${executable}`);
      const script = args.at(-1)!;
      edge.scripts.push(script);
      // Only the transport is substituted. Run generated commands, uploads,
      // hashing, shell quoting and cache inspection with real processes/files.
      return actual.spawn("sh", ["-c", script], { ...options, env: edge.env });
    }),
  };
});
vi.mock("@harness/native", async (original) => ({
  ...(await original<typeof import("@harness/native")>()),
  // Signing is separately covered by native tests; this suite exercises target
  // selection and byte transfer with controlled release metadata, not signing.
  verifyRelease: vi.fn((bytes: Buffer) => bytes.toString("utf8")),
}));

const host = { kind: "ssh", id: "fixture", label: "Fixture", destination: "fixture" } as const;
const digest = (bytes: Buffer) => ({
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

// These execute GNU/Linux shell commands, not ARM instructions. Platform and
// native bootstrap edges are substituted; real ARM execution remains required.
describe.skipIf(process.platform !== "linux")("remote runtime target delivery", () => {
  let root: string;
  let userHome: string;
  let payload: string;
  let bin: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-remote-target-"));
    userHome = join(root, "account's home");
    payload = join(root, "payload");
    bin = join(root, "bin");
    await Promise.all([userHome, payload, bin].map((path) => mkdir(path, { mode: 0o700 })));
    edge.env = { PATH: `${bin}:${process.env["PATH"]}`, HOME: userHome };
    edge.scripts = [];
    // A user-namespace sandbox may expose / as overflow uid 65534. Model
    // the remote OS root ownership only; all fixture ancestry stays real.
    await command(
      "stat",
      'if test "$1" = -c && test "$2" = %u && test "$3" = /; then printf "0\\n"; else exec /usr/bin/stat "$@"; fi',
    );
    await platform("Linux aarch64");
    vi.stubEnv("HARNESS_DEVELOPMENT_REMOTE_PAYLOAD", undefined);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  async function command(name: string, body: string) {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o700);
  }
  async function platform(machine: string, libc = "glibc 2.36") {
    await command("uname", `printf '%s\\n' ${shellQuote(machine)}`);
    await command("getconf", libc === "missing" ? "exit 1" : `printf '%s\\n' ${shellQuote(libc)}`);
  }
  async function source(target: LinuxTarget) {
    const archive = Buffer.from(`representative-${target}-archive`);
    // Stand in for the native executable only: its output is consumed through
    // the real prepared-runtime schema, immutable identity and cache checks.
    const bootstrap = Buffer.from(`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const target = ${JSON.stringify(target)};
const home = process.env.HARNESS_HOME;
const directory = args[0] === '--inspect-cached-server' ? args[1] : args[0] === '--prepare-release' ? args[1] + '-' + target : 'dev-' + target + '-' + args[2];
const installed = path.join(home, 'server', directory);
if (args[0] !== '--inspect-cached-server') {
  fs.mkdirSync(installed, {recursive:true});
  fs.copyFileSync(process.argv[1], path.join(installed, 'harness-bootstrap'));
  fs.writeFileSync(path.join(installed, 'server.mjs'), '// prepared');
  fs.writeFileSync(path.join(installed, 'environment.json'), JSON.stringify(process.env));
}
console.log(JSON.stringify({node:path.join(home,'runtime',target,'node'),payload:installed,entry:path.join(installed,'server.mjs'),home}));
`);
    const metadata = {
      formatVersion: 1,
      target,
      productVersion: "0.1.0",
      nodeVersion: NODE_PIN.version,
      server: digest(archive),
      bootstrap: digest(bootstrap),
    };
    await writeFile(join(payload, "remote.json"), JSON.stringify(metadata));
    await writeFile(join(payload, "server.tar.gz"), archive);
    await writeFile(join(payload, "harness-bootstrap"), bootstrap);
    return { metadata, bootstrap };
  }

  it.each([
    ["Linux x86_64", "linux-x64-glibc"],
    ["Linux aarch64", "linux-arm64-glibc"],
    ["Linux arm64", "linux-arm64-glibc"],
  ] as const)(
    "provisions %s with the matching payload and reuses its immutable cache",
    async (machine, target) => {
      await platform(machine);
      const { metadata } = await source(target);
      const runtime = await prepareRemoteRuntime(host, payload, {
        env: { OPENAI_API_KEY: "host-secret-not-for-remote", HARNESS_HOME: "/wrong-host-home" },
      });
      expect(runtime.directory).toBe(
        join(userHome, ".harness", "server", `dev-${target}-${metadata.server.sha256}`),
      );
      expect(runtime.node).toBe(join(userHome, ".harness", "runtime", target, "node"));
      expect(runtime.transferred).toBe(true);
      const environment = JSON.parse(
        await readFile(join(runtime.directory, "environment.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(environment.OPENAI_API_KEY).toBeUndefined();
      expect(environment.HARNESS_HOME).toBe(join(userHome, ".harness"));
      expect(edge.scripts.join("\n")).not.toContain("host-secret-not-for-remote");
      expect(await prepareRemoteRuntime(host, payload)).toEqual({ ...runtime, transferred: false });
      expect(await readdir(join(runtime.home, "staging"))).toEqual([]);
    },
  );

  it("uses the detected ARM64 payload through the WSL transport too", async () => {
    const { metadata } = await source("linux-arm64-glibc");
    // WSL command construction is a Windows-client edge; the target commands
    // still run in the same isolated Linux account fixture.
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const runtime = await prepareRemoteRuntime(
      { kind: "wsl", id: "wsl", label: "ARM WSL", distribution: "Fixture", user: null },
      payload,
    );
    expect(runtime.directory).toBe(
      join(userHome, ".harness", "server", `dev-linux-arm64-glibc-${metadata.server.sha256}`),
    );
    expect(runtime.transferred).toBe(true);
  });

  it.each([
    ["Linux aarch64", "linux-x64-glibc", "linux-arm64-glibc"],
    ["Linux x86_64", "linux-arm64-glibc", "linux-x64-glibc"],
  ] as const)(
    "rejects mismatched development artifacts on %s before upload",
    async (machine, sourceTarget, actualTarget) => {
      await platform(machine);
      await source(sourceTarget);
      await expect(prepareRemoteRuntime(host, payload)).rejects.toThrow(
        `payload targets ${sourceTarget}, but the remote platform is ${actualTarget}`,
      );
      expect(edge.scripts.join("\n")).not.toContain("/staging/");
      expect(await readdir(join(userHome, ".harness"))).toEqual([]);
    },
  );

  it.each([
    ["Linux aarch64", "musl 1.2.5"],
    ["Linux aarch64", "missing"],
    ["Linux riscv64", "glibc 2.36"],
    ["Darwin arm64", "missing"],
  ])("rejects unsupported platform %s / %s clearly", async (machine, libc) => {
    await platform(machine, libc);
    await expect(prepareRemoteRuntime(host, payload)).rejects.toThrow(
      "remote servers require Linux x64 or ARM64 with glibc (musl is not supported)",
    );
    expect(await readdir(userHome)).toEqual([]);
  });

  it("rejects a selection for another platform without transferring artifacts", async () => {
    const home = join(userHome, ".harness");
    await mkdir(join(home, "server"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, "server", "current.json"),
      JSON.stringify({ formatVersion: 1, directory: "0.1.0-linux-x64-glibc" }),
    );
    await expect(prepareRemoteRuntime(host, payload)).rejects.toThrow(
      "Selected server is not for the remote platform",
    );
    expect(edge.scripts.join("\n")).not.toContain("/staging/");
  });

  it.each([
    ["matching ARM64 descriptor", true],
    ["missing ARM64 descriptor", false],
  ] as const)(
    "selects release artifacts with %s, never falling back to x64",
    async (_label, includeArm) => {
      const target = "linux-arm64-glibc";
      const { metadata, bootstrap } = await source(target);
      const home = join(userHome, ".harness");
      await mkdir(join(home, "server"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(home, "server", "current.json"),
        JSON.stringify({ formatVersion: 1, directory: `99.0.0-${target}` }),
      );
      const artifact = {
        url: "https://example.com/artifact",
        ...metadata.server,
        format: "tarGz",
        root: "payload",
        entry: "server.mjs",
      };
      const entry = {
        node: { version: NODE_PIN.version, artifact },
        server: artifact,
        cli: artifact,
        launcher: {
          ...artifact,
          url: "https://example.com/arm64-bootstrap",
          ...metadata.bootstrap,
          format: "file",
        },
      };
      const manifest = {
        formatVersion: 1,
        productVersion: "99.0.0",
        ...(includeArm ? { linuxArm64Glibc: entry } : {}),
        targets: {
          "linux-x64-glibc": {
            ...entry,
            launcher: { ...entry.launcher, url: "https://example.com/wrong-x64-bootstrap" },
          },
        },
      };
      const fetch = vi.fn(async (url: string) => {
        if (url.endsWith("release.json")) return new Response(JSON.stringify(manifest));
        if (url.endsWith("release.json.minisig")) return new Response("signature-edge-substitute");
        if (url === "https://example.com/arm64-bootstrap")
          return new Response(new Uint8Array(bootstrap));
        throw new Error(`Wrong artifact selected: ${url}`);
      });
      vi.stubGlobal("fetch", fetch);
      if (!includeArm) {
        await expect(prepareRemoteRuntime(host, payload)).rejects.toThrow(
          "Release has no bootstrap executable for linux-arm64-glibc",
        );
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(edge.scripts.join("\n")).not.toContain("/staging/");
        return;
      }
      const runtime = await prepareRemoteRuntime(host, payload);
      expect(runtime.directory).toBe(join(home, "server", `99.0.0-${target}`));
      expect(runtime.buildId).toBe(metadata.server.sha256);
      expect(runtime.transferred).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(await readdir(join(home, "staging"))).toEqual([]);
    },
  );

  it("preserves pre-aborted cancellation before starting the transport", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareRemoteRuntime(host, payload, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(edge.scripts).toEqual([]);
  });
});
