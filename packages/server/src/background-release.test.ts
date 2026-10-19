import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HarnessClient } from "@harness/client";
import { updateGlobalSettings } from "@harness/config";
import { attachLocalServer } from "@harness/connections/node";
import { canonicalHome, readDiscovery } from "@harness/connections/local";
import {
  managementInspectRequest,
  managementReleaseRequest,
  managementStopRequest,
  serverReleaseRequest,
} from "@harness/connections";
import { runBackgroundServer } from "./background.ts";

const reads = vi.hoisted(() => ({ beforeRead: undefined as (() => Promise<void>) | undefined }));
vi.mock("@harness/config", async (load) => {
  const actual = await load<typeof import("@harness/config")>();
  return {
    ...actual,
    readGlobalSettings: async (home: string) => {
      const before = reads.beforeRead;
      reads.beforeRead = undefined;
      await before?.();
      return actual.readGlobalSettings(home);
    },
  };
});
afterEach(() => {
  reads.beforeRead = undefined;
  vi.unstubAllEnvs();
});

async function fixture() {
  const home = await canonicalHome(join(tmpdir(), `harness-release-${randomUUID()}`));
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("HARNESS_SERVER_SELECTION", undefined);
  if (process.platform !== "win32") {
    vi.stubEnv("HOME", home);
    vi.stubEnv("SHELL", "/bin/bash");
  }
  const running = runBackgroundServer();
  // Surface startup rejection immediately, including in waitFor diagnostics.
  let failure: Error | undefined;
  void running.catch((error: unknown) => {
    failure =
      error instanceof Error ? error : new Error("Background startup failed", { cause: error });
  });
  const peers: Awaited<ReturnType<typeof attachLocalServer>>[] = [];
  const connect = async () => {
    const peer = await attachLocalServer(home);
    peers.push(peer);
    peer.connection.listen();
    await peer.connection.sendRequest(managementInspectRequest.method, {});
    return peer;
  };
  const release = (peer: Awaited<ReturnType<typeof connect>>) =>
    peer.connection.sendRequest(managementReleaseRequest.method, {
      instanceId: peer.identity.instanceId,
    });
  try {
    await vi.waitFor(async () => {
      if (failure) throw failure;
      expect(await readDiscovery(home)).not.toBeNull();
    });
  } catch (error) {
    await running;
    throw error;
  }
  return {
    home,
    connect,
    release,
    running,
    async close() {
      reads.beforeRead = undefined;
      try {
        if (await readDiscovery(home)) {
          const control = await connect();
          await control.connection.sendRequest(managementStopRequest.method, {
            instanceId: control.identity.instanceId,
          });
        }
        await running;
      } finally {
        for (const peer of peers) peer.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  };
}

it("stops the last default-false owner when overlapping controls explicitly relinquish", async () => {
  const server = await fixture();
  try {
    const first = await server.connect();
    const second = await server.connect();
    expect(await server.release(first)).toEqual({ stopping: false });
    // Keep the first control physically open: it has surrendered observation.
    expect(await server.release(second)).toEqual({ stopping: true });
    await server.running;
    expect(await readDiscovery(server.home)).toBeNull();
  } finally {
    await server.close();
  }
});

it("reads the persisted preference at release without restart", async () => {
  const server = await fixture();
  try {
    await updateGlobalSettings(server.home, (doc) => ({
      ...doc,
      desktop: { keepServerRunning: true },
    }));
    const control = await server.connect();
    expect(await server.release(control)).toEqual({ stopping: false });
    await updateGlobalSettings(server.home, (doc) => ({
      ...doc,
      desktop: { keepServerRunning: false },
    }));
    expect(await server.release(control)).toEqual({ stopping: true });
    await server.running;
  } finally {
    await server.close();
  }
});

it("preserves a surviving observer and never arms shutdown on its ordinary detach", async () => {
  const server = await fixture();
  try {
    const first = await server.connect();
    const second = await server.connect();
    const observer = await server.connect();
    expect(await server.release(first)).toEqual({ stopping: false });
    expect(await server.release(second)).toEqual({ stopping: false });
    observer.close();
    // An ordinary close must not trigger a delayed stop from previous releases.
    const fresh = await server.connect();
    expect(await fresh.connection.sendRequest(managementInspectRequest.method, {})).toEqual(
      fresh.identity,
    );
    expect(await server.release(fresh)).toEqual({ stopping: true });
    await server.running;
  } finally {
    await server.close();
  }
});

it("protects a newly admitted client while the release setting read is pending", async () => {
  const server = await fixture();
  let unblock!: () => void;
  try {
    const control = await server.connect();
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => (entered = resolve));
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    reads.beforeRead = () => {
      entered();
      return blocked;
    };
    const release = server.release(control);
    await reading;
    const newcomer = await server.connect();
    unblock();
    expect(await release).toEqual({ stopping: false });
    expect(await server.release(newcomer)).toEqual({ stopping: true });
    await server.running;
  } finally {
    unblock?.();
    await server.close();
  }
});

it("does not relinquish invalid, stale or failed-read release controls", async () => {
  const server = await fixture();
  try {
    const first = await server.connect();
    const second = await server.connect();
    await expect(
      first.connection.sendRequest(managementReleaseRequest.method, { instanceId: randomUUID() }),
    ).rejects.toThrow("instance changed");
    await expect(
      first.connection.sendRequest(managementReleaseRequest.method, {}),
    ).rejects.toThrow();
    reads.beforeRead = () => Promise.reject(new Error("fixture settings read failed"));
    await expect(server.release(first)).rejects.toThrow("fixture settings read failed");
    expect(await server.release(second)).toEqual({ stopping: false });
    expect(await server.release(first)).toEqual({ stopping: true });
    await server.running;
  } finally {
    await server.close();
  }
});

it("shares relinquishment between public and management release", async () => {
  const server = await fixture();
  let application: HarnessClient | undefined;
  try {
    const transport = await attachLocalServer(server.home);
    application = new HarnessClient({
      connection: transport.connection,
      client: { name: "release", version: "1" },
    });
    await application.start();
    const control = await server.connect();
    expect(await application.peer.request(serverReleaseRequest, {})).toEqual({ stopping: false });
    expect(await server.release(control)).toEqual({ stopping: true });
    await server.running;
    transport.close();
  } finally {
    application?.closeConnection();
    await server.close();
  }
});

it("explicit management Stop ignores keep-running", async () => {
  const server = await fixture();
  try {
    await updateGlobalSettings(server.home, (doc) => ({
      ...doc,
      desktop: { keepServerRunning: true },
    }));
    const control = await server.connect();
    expect(
      await control.connection.sendRequest(managementStopRequest.method, {
        instanceId: control.identity.instanceId,
      }),
    ).toEqual({ accepted: true });
    await server.running;
  } finally {
    await server.close();
  }
});
