import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRODUCT_VERSION } from "@harness/release";
import { prepareServerLaunch } from "./server-launch.ts";

interface HelperRun {
  child: ChildProcess;
  request: { executable: string; args: readonly string[]; options: SpawnOptions };
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  ready: Promise<void>;
  eof: Promise<void>;
  alive: Promise<void>;
}

const helpers = vi.hoisted(() => ({
  fixture: "",
  failureExecutable: undefined as string | undefined,
  mode: "release",
  runs: [] as HelperRun[],
}));

vi.mock("@harness/release", async (importActual) => {
  const actual = await importActual<typeof import("@harness/release")>();
  return {
    ...actual,
    BUILD_IDENTITY: {
      ...actual.BUILD_IDENTITY,
      get mode() {
        return helpers.mode;
      },
    },
  };
});

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(executable: string, args: readonly string[] = [], options: SpawnOptions = {}) {
      if (!["--prepare-server", "--prepare-development-server"].includes(args[0] ?? ""))
        return actual.spawn(executable, args, options);
      const child = helpers.failureExecutable
        ? actual.spawn(helpers.failureExecutable, [], options)
        : actual.spawn(process.execPath, [helpers.fixture], {
            ...options,
            stdio: ["pipe", "pipe", "pipe", "ipc"],
          });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
      );
      const event = (name: string) =>
        Promise.race([
          new Promise<void>((resolve) => {
            child.on("message", (message) => {
              if (message === name) resolve();
            });
          }),
          closed.then(() => {
            throw new Error(`Helper exited before ${name}`);
          }),
        ]);
      // Some scenarios intentionally never reach these states. Attach rejection
      // handlers now, while keeping the original promises available to callers.
      const ready = event("ready");
      const eof = event("eof");
      const alive = event("alive");
      for (const observed of [ready, eof, alive]) void observed.catch(() => undefined);
      helpers.runs.push({
        child,
        request: { executable, args, options },
        closed,
        ready,
        eof,
        alive,
      });
      return child;
    },
  };
});

let home: string;
const target =
  process.platform === "win32"
    ? "windows-x64"
    : process.platform === "darwin"
      ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}`
      : "linux-x64-glibc";

beforeEach(() => {
  home = join(tmpdir(), `harness-prepared-server-${randomUUID()}`);
  helpers.fixture = fileURLToPath(new URL("./prepared-server.fixture.mjs", import.meta.url));
  helpers.failureExecutable = undefined;
  helpers.mode = "release";
  helpers.runs = [];
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("HARNESS_NATIVE_LAUNCHER", join(home, "native-launcher"));
});

afterEach(async () => {
  for (const run of helpers.runs) {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
    await run.closed;
  }
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

function helper(): HelperRun {
  const run = helpers.runs.at(-1);
  if (!run) throw new Error("No native helper was launched");
  return run;
}

function command(run: HelperRun, message: Record<string, unknown>): void {
  run.child.send(message);
}

function capturedDescriptor() {
  const directory = `0.2.0-${target}`;
  const payload = join(home, "server", directory);
  return {
    node: join(home, "runtime", "node", `22.23.3-${target}`, "selected-node"),
    entry: join(payload, "server.mjs"),
    payload,
    keys: [`node-22.23.3-${target}`, `server-${directory}`],
  };
}

it("uses the same retained native boundary for complete development snapshots", async () => {
  helpers.mode = "development";
  const source = join(home, "build-scratch");
  vi.stubEnv("HARNESS_DEVELOPMENT_SERVER_PAYLOAD", source);
  const pending = prepareServerLaunch("background");
  const run = helper();
  await run.ready;
  const descriptor = capturedDescriptor();
  const selection = `dev-${target}-${"a".repeat(64)}`;
  descriptor.payload = join(home, "server", selection);
  descriptor.entry = join(descriptor.payload, "server.mjs");
  descriptor.keys[1] = `server-${selection}`;
  command(run, { kind: "write", wire: `${JSON.stringify(descriptor)}\n` });
  const prepared = await pending;
  expect(run.request.args).toEqual(["--prepare-development-server", source]);
  expect(prepared.launch.selection).toBe(selection);
  expect(prepared.launch.env?.["HARNESS_NATIVE_BINDING"]).toBeUndefined();
  const closing = prepared.close();
  await run.eof;
  command(run, { kind: "exit" });
  await closing;
});

it("retains the helper through fragmented readiness and explicit retirement", async () => {
  const controller = new AbortController();
  const pending = prepareServerLaunch("stdio", controller.signal);
  const run = helper();
  await run.ready;
  const descriptor = capturedDescriptor();
  descriptor.entry = join(descriptor.payload, "server-🦦.mjs");
  const wire = `${JSON.stringify(descriptor)}\n`;
  if (!run.child.stdout) throw new Error("Helper stdout was not piped");
  const fragment = once(run.child.stdout, "data");
  let admitted = false;
  void pending.then(() => {
    admitted = true;
  });
  command(run, { kind: "fragment", wire, split: Buffer.from(wire).indexOf("🦦") + 1 });
  await fragment;
  expect(admitted).toBe(false);
  command(run, { kind: "complete" });
  const prepared = await pending;
  expect(run.request).toMatchObject({
    executable: join(home, "native-launcher"),
    args: ["--prepare-server", PRODUCT_VERSION],
    options: { windowsHide: true, env: { HARNESS_HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  });
  expect(prepared.launch).toMatchObject({
    executable: descriptor.node,
    args: [descriptor.entry, "--stdio"],
    selection: `0.2.0-${target}`,
    env: {
      HARNESS_SERVER_SELECTION: `0.2.0-${target}`,
      HARNESS_SERVER_CACHE_KEYS: JSON.stringify(descriptor.keys),
    },
  });
  expect(prepared.launch.executable).not.toBe(process.execPath);
  const retained = prepared.launch.retainUse?.();
  expect(retained).toBeDefined();
  try {
    expect(await readdir(join(home, ".cache-locks"))).toEqual(
      expect.arrayContaining(descriptor.keys),
    );
  } finally {
    retained?.close();
  }
  controller.abort();
  command(run, { kind: "alive" });
  await run.alive;
  expect(run.child.exitCode).toBeNull();
  let retired = false;
  const closing = prepared.close();
  expect(prepared.close()).toBe(closing);
  void closing.then(() => {
    retired = true;
  });
  await run.eof;
  expect(retired).toBe(false);
  expect(run.child.exitCode).toBeNull();
  command(run, { kind: "exit" });
  expect(await run.closed).toEqual({ code: 0, signal: null });
  await closing;
  expect(retired).toBe(true);
  expect(prepared.close()).toBe(closing);
}, 30_000);

it("accepts a descriptor at the exact 16 KiB transport limit", async () => {
  const pending = prepareServerLaunch("background");
  const run = helper();
  await run.ready;
  const descriptor = capturedDescriptor();
  descriptor.node += "n".repeat(16_384 - Buffer.byteLength(`${JSON.stringify(descriptor)}\n`));
  const wire = `${JSON.stringify(descriptor)}\n`;
  expect(Buffer.byteLength(wire)).toBe(16_384);
  command(run, { kind: "write", wire });
  const prepared = await pending;
  expect(prepared.launch.executable).toBe(descriptor.node);
  expect(prepared.launch.args).toEqual([descriptor.entry, "--background"]);
  const closing = prepared.close();
  await run.eof;
  command(run, { kind: "exit" });
  await closing;
  expect(await run.closed).toEqual({ code: 0, signal: null });
});

it("does not start preparation for an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(prepareServerLaunch("background", controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(helpers.runs).toHaveLength(0);
});

it("cancels before readiness and waits for the helper's physical exit", async () => {
  const controller = new AbortController();
  const pending = prepareServerLaunch("background", controller.signal);
  const run = helper();
  await run.ready;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(await run.closed).not.toEqual({ code: 0, signal: null });
  expect(run.child.exitCode !== null || run.child.signalCode !== null).toBe(true);
});

it.each([
  { name: "malformed JSON", wire: "{broken\n", message: /JSON|Unexpected/u },
  { name: "invalid descriptor", wire: '{"node":"node"}\n', message: /keys|entry|payload/u },
  { name: "oversized descriptor", wire: "x".repeat(16_385), message: /exceeds its limit/u },
])("rejects $name and physically retires the helper", async ({ wire, message }) => {
  const pending = prepareServerLaunch("background");
  const rejected = expect(pending).rejects.toThrow(message);
  const run = helper();
  await run.ready;
  command(run, { kind: "write", wire });
  await rejected;
  await run.closed;
  expect(run.child.exitCode !== null || run.child.signalCode !== null).toBe(true);
});

it.each([
  { name: "partial descriptor", wire: '{"node":"node"', code: 0 },
  { name: "no descriptor", wire: "", code: 0 },
  { name: "nonzero exit", wire: "", code: 7 },
])("rejects $name before readiness", async ({ wire, code }) => {
  const pending = prepareServerLaunch("background");
  const rejected = expect(pending).rejects.toThrow("ended before readiness");
  const run = helper();
  await run.ready;
  command(run, { kind: "write-and-exit", wire, code });
  await rejected;
  expect(await run.closed).toEqual({ code, signal: null });
});

it("rejects an unexpected successful helper exit after readiness", async () => {
  const pending = prepareServerLaunch("background");
  const run = helper();
  await run.ready;
  command(run, { kind: "write", wire: `${JSON.stringify(capturedDescriptor())}\n` });
  const prepared = await pending;
  command(run, { kind: "exit" });
  expect(await run.closed).toEqual({ code: 0, signal: null });
  const closing = prepared.close();
  await expect(closing).rejects.toThrow("Server preparation failed");
  expect(prepared.close()).toBe(closing);
});

it("reports a failed OS launch after the child's close event", async () => {
  helpers.failureExecutable = join(home, `missing-${randomUUID()}`);
  const pending = prepareServerLaunch("background");
  const run = helper();
  await expect(pending).rejects.toMatchObject({
    cause: { code: "ENOENT" },
  });
  await expect(pending).rejects.toThrow("ended before readiness");
  expect((await run.closed).code).not.toBe(0);
});
