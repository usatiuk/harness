import { PRODUCT_VERSION } from "@harness/release";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HARNESS_PROTOCOL_VERSION } from "@harness/protocol";
import { expect, it } from "vitest";
import {
  authenticateSocket,
  canonicalHome,
  createServerToken,
  privateRuntimeDirectory,
  serverSecretStore,
  listenLocal,
} from "./local.ts";
import { replaceJson } from "./json-file.ts";

it.each(["--attach-only", "--bridge", "--desktop-bridge"])(
  "%s detaches with bounded queued input and reports owners only for desktop",
  async (mode) => {
    const home = await canonicalHome(join(tmpdir(), `harness-bridge-${randomUUID()}`));
    const directory = await privateRuntimeDirectory(home);
    const token = createServerToken();
    await serverSecretStore(directory).set("token", token);
    const identity = {
      serverId: randomUUID(),
      instanceId: randomUUID(),
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      home,
      pid: process.pid,
      platform: process.platform,
      managementVersion: 1 as const,
      productVersion: PRODUCT_VERSION,
      buildId: "fixture",
    };
    const sockets = new Set<Socket>();
    let authenticated!: () => void;
    const ready = new Promise<void>((resolve) => (authenticated = resolve));
    const owner = await listenLocal(
      home,
      identity.instanceId,
      (socket) => {
        sockets.add(socket);
        socket.on("error", () => undefined);
        void authenticateSocket(socket).then((supplied) => {
          if (supplied !== token) throw new Error("Incorrect fixture authentication");
          socket.write(`${JSON.stringify(identity)}\n`);
          // Model a suspended process after authentication, without consuming RPC bytes.
          socket.pause();
          authenticated();
        });
      },
      (error) => {
        throw error;
      },
    );
    await replaceJson(join(directory, "discovery.json"), { ...identity, endpoint: owner.endpoint });
    const bridge = spawn(
      process.execPath,
      ["--conditions=development", "--import=tsx", resolve("packages/server/src/bin.ts"), mode],
      {
        env: { ...process.env, HARNESS_HOME: home, HARNESS_SERVER_SELECTION: undefined },
        windowsHide: true,
        stdio: "pipe",
      },
    );
    const closed = once(bridge, "close");
    let diagnostics = "";
    bridge.stderr.on("data", (chunk: Buffer) => (diagnostics += chunk.toString()));
    bridge.stdout.resume();
    try {
      await ready;
      const frame = `${JSON.stringify({ jsonrpc: "2.0", method: "fixture", params: "x".repeat(3 * 1024 * 1024) })}\n`;
      await new Promise<void>((resolve, reject) => {
        bridge.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
      });
      bridge.stdin.destroy();
      expect((await closed)[0]).toBe(0);
      if (mode === "--desktop-bridge")
        expect(JSON.parse(diagnostics)).toEqual({ type: "serverOwner", identity });
      else expect(diagnostics).toBe("");
      expect(sockets.size).toBe(1);
    } finally {
      if (bridge.exitCode === null) bridge.kill();
      await closed;
      for (const socket of sockets) socket.destroy();
      await owner.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  20_000,
);
