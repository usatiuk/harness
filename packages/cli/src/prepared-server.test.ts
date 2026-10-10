import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRODUCT_VERSION } from "@harness/release";
import { canonicalHome } from "@harness/connections/local";
import { prepareServerLaunch } from "./server-launch.ts";

const helper = vi.hoisted(() => ({
  mode: "release",
  wire: "",
  code: 0,
  hold: false,
  fragment: false,
  child: undefined as ChildProcess | undefined,
  ready: undefined as Promise<void> | undefined,
  exited: undefined as Promise<void> | undefined,
  request: undefined as { args: readonly string[]; options: SpawnOptions } | undefined,
}));
vi.mock("@harness/release", async (original) => ({
  ...(await original<typeof import("@harness/release")>()),
  BUILD_IDENTITY: {
    get mode() {
      return helper.mode;
    },
  },
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(executable: string, args: readonly string[], options: SpawnOptions) {
      if (!args[0]?.startsWith("--prepare-")) return actual.spawn(executable, args, options);
      helper.request = { args, options };
      const child = actual.spawn(
        process.execPath,
        [fileURLToPath(new URL("./prepared-server.fixture.mjs", import.meta.url))],
        {
          ...options,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: {
            ...options.env,
            HARNESS_TEST_HELPER: JSON.stringify({
              wire: helper.wire,
              code: helper.code,
              hold: helper.hold,
              fragment: helper.fragment,
            }),
          },
        },
      );
      helper.child = child;
      helper.ready = new Promise<void>((resolve) => child.once("message", () => resolve()));
      helper.exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      // A split UTF-8 character must survive the stdout boundary.
      if (helper.fragment) {
        const fragment = new Promise<void>((resolve) =>
          child.stdout!.once("data", () => resolve()),
        );
        child.once("message", () => {
          void fragment.then(() => child.send("finish"));
        });
      }
      return child;
    },
  };
});

let home: string;
let temporary: string;
let descriptor: { node: string; entry: string; payload: string };
const target =
  process.platform === "win32"
    ? "windows-x64"
    : process.platform === "darwin"
      ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}`
      : "linux-x64-glibc";
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "harness-prepare-"));
  home = await canonicalHome(join(temporary, "home"));
  const payload = join(home, "server", `0.2.0-${target}`);
  descriptor = {
    node: join(home, "selected-node"),
    entry: join(payload, "server-🦦.mjs"),
    payload,
  };
  Object.assign(helper, {
    mode: "release",
    wire: `${JSON.stringify(descriptor)}\n`,
    code: 0,
    hold: false,
    fragment: false,
    child: undefined,
  });
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("HARNESS_NATIVE_LAUNCHER", join(home, "bootstrap"));
});
afterEach(async () => {
  if (helper.child?.exitCode === null && helper.child.signalCode === null) helper.child.kill();
  await helper.exited;
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

it("uses the completed helper's captured runtime and survives fragmented UTF-8", async () => {
  helper.fragment = true;
  const prepared = await prepareServerLaunch("stdio");
  try {
    expect(helper.child!.exitCode).toBe(0);
    expect(helper.request).toMatchObject({
      args: ["--prepare-server", PRODUCT_VERSION],
      options: { windowsHide: true },
    });
    expect(prepared.launch).toMatchObject({
      executable: descriptor.node,
      args: [descriptor.entry, "--stdio"],
      selection: `0.2.0-${target}`,
    });
    expect(prepared.launch.executable).not.toBe(process.execPath);
  } finally {
    await prepared.close();
  }
});

it("cancels blocked preparation and physically retires the helper", async () => {
  helper.hold = true;
  const controller = new AbortController();
  const pending = prepareServerLaunch("background", controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await helper.ready;
  controller.abort();
  await rejected;
  expect(helper.child!.exitCode !== null || helper.child!.signalCode !== null).toBe(true);
});

it.each([
  { name: "malformed JSON", wire: "{broken", code: 0, error: /JSON|Unexpected/u },
  { name: "incomplete descriptor", wire: '{"node":"node"}', code: 0, error: /entry|payload/u },
  { name: "oversized descriptor", wire: "x".repeat(16_385), code: 0, error: /exceeds its limit/u },
  { name: "failed process", wire: "", code: 7, error: /Server preparation failed/u },
])("rejects $name", async ({ wire, code, error }) => {
  Object.assign(helper, { wire, code });
  await expect(prepareServerLaunch("background")).rejects.toThrow(error);
  expect(helper.child!.exitCode !== null || helper.child!.signalCode !== null).toBe(true);
});
