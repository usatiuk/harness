import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { HarnessClient } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { serverInfoRequest } from "./contracts.ts";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { updateGlobalSettings } from "@harness/config";
import { ensureLocalServer, stopServer } from "./connect.ts";
import { canonicalHome, readDiscovery } from "./local.ts";
import { runConnectionCommand } from "./commands.ts";
import { shellQuote } from "./remote.ts";

// Substitute SSH execution only: run the actual generated remote command, source
// bridge, authentication and management RPC against an isolated execution account.
it.skipIf(process.platform === "win32")(
  "remote desktop exit attaches only, shares host policy and never stops a successor",
  async () => {
    const root = join(tmpdir(), `harness-remote-exit-${randomUUID()}`);
    const home = await canonicalHome(join(root, "home"));
    const bin = join(root, "bin");
    const directory = join(root, "cached-server");
    const marker = join(root, "bridge-modes");
    await mkdir(bin, { recursive: true });
    await mkdir(directory);
    const q = shellQuote;
    await writeFile(join(bin, "ssh"), '#!/bin/sh\nfor last do :; done\nexec sh -c "$last"\n');
    await chmod(join(bin, "ssh"), 0o700);
    await writeFile(
      join(directory, "harness-bootstrap"),
      `#!/bin/sh
set -eu
test "$1" = --run-cached-server
test "$2" = cached-server
printf '%s\\n' "$3" >> ${q(marker)}
exec ${q(process.execPath)} --conditions=development --import=tsx ${q(resolve("packages/server/src/bin.ts"))} "$3"
`,
    );
    await chmod(join(directory, "harness-bootstrap"), 0o700);
    const env = {
      ...process.env,
      HOME: root,
      SHELL: "/bin/bash",
      HARNESS_SERVER_SELECTION: undefined,
      HARNESS_HOME: home,
      PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    };
    const host = {
      kind: "ssh",
      id: "alias",
      label: "Alias",
      destination: "isolated-fixture",
    } as const;
    const runtime = {
      node: process.execPath,
      home,
      directory,
      buildId: "a".repeat(64),
      transferred: false,
    };
    const launch = {
      executable: process.execPath,
      args: [
        "--conditions=development",
        "--import=tsx",
        resolve("packages/server/src/bin.ts"),
        "--background",
      ],
      env,
    };
    let owner: Awaited<ReturnType<typeof ensureLocalServer>> | undefined;
    try {
      owner = await ensureLocalServer(home, launch);
      const identity = owner.identity;
      // Release only the fixture's transport. No application observer remains.
      const detached = once(owner.socket, "close");
      owner.socket.end();
      await detached;
      const bridge = spawn(
        process.execPath,
        [
          "--conditions=development",
          "--import=tsx",
          resolve("packages/server/src/bin.ts"),
          "--host-bridge",
          JSON.stringify({ host, runtime }),
        ],
        { env, stdio: "pipe" },
      );
      const bridgeClosed = once(bridge, "close");
      let diagnostics = "";
      bridge.stderr.on("data", (chunk: Buffer) => (diagnostics += chunk.toString()));
      const client = new HarnessClient({
        connection: createNdjsonMessageConnection(bridge.stdout, bridge.stdin),
        client: { name: "desktop-forwarding", version: "1" },
      });
      try {
        await client.start();
        expect(await client.peer.request(serverInfoRequest, {})).toEqual(identity);
        expect(JSON.parse(diagnostics)).toEqual({ type: "serverOwner", identity });
      } finally {
        bridge.stdin.end();
        await bridgeClosed;
        client.closeConnection();
      }
      await updateGlobalSettings(home, (doc) => ({ ...doc, desktop: { keepServerRunning: true } }));
      const exit = () =>
        runConnectionCommand({ type: "desktop.exit", target: { host, runtime }, identity }, "", {
          env,
        });
      await exit();
      expect((await readDiscovery(home))?.instanceId).toBe(identity.instanceId);
      await updateGlobalSettings(home, (doc) => ({
        ...doc,
        desktop: { keepServerRunning: false },
      }));
      await exit();
      expect(await readDiscovery(home)).toBeNull();
      // A missing owner must not be silently restarted by the control path.
      await expect(exit()).rejects.toThrow();
      expect(await readDiscovery(home)).toBeNull();
      owner = await ensureLocalServer(home, launch);
      const successor = owner.identity;
      await expect(exit()).rejects.toThrow("Server instance changed");
      expect((await readDiscovery(home))?.instanceId).toBe(successor.instanceId);
      const absent = join(root, "never-started");
      await expect(
        runConnectionCommand(
          {
            type: "desktop.exit",
            target: { host, runtime: { ...runtime, home: absent } },
            identity: { ...identity, home: absent },
          },
          "",
          { env },
        ),
      ).rejects.toThrow();
      expect(await readDiscovery(absent)).toBeNull();
      await expect(stat(join(absent, "store.db"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readFile(marker, "utf8")).trim().split("\n")).toEqual([
        "--desktop-bridge",
        ...Array<string>(5).fill("--attach-only"),
      ]);
      expect((await stat(join(home, "store.db"))).isFile()).toBe(true);
    } finally {
      owner?.close();
      const discovery = await readDiscovery(home);
      if (discovery) await stopServer(discovery);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
