import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  attachLocalServer,
  ensureLocalServer,
  stopServer,
  type HostConnection,
} from "./connect.ts";
import { canonicalHome, privateRuntimeDirectory, readDiscovery } from "./local.ts";

// Control the failing local socket edge; successful ownership/authentication stays real.
const edge = vi.hoisted(() => ({ failure: undefined as Error | undefined, resets: 0 }));
vi.mock("./local.ts", async (original) => {
  const actual = await original<typeof import("./local.ts")>();
  return {
    ...actual,
    connectDiscovered: async (...args: Parameters<typeof actual.connectDiscovered>) => {
      const failure = edge.failure;
      edge.failure = undefined;
      if (failure) {
        edge.resets++;
        throw failure;
      }
      return actual.connectDiscovered(...args);
    },
  };
});
const peers: HostConnection[] = [];
let root: string;
let home: string;
let log: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-startup-error-"));
  // Let the production home creator establish ownership, including elevated Windows.
  home = await canonicalHome(join(root, "home"));
  const directory = await privateRuntimeDirectory(home);
  log = join(directory, "startup.log");
  await writeFile(log, "stale failure\n");
});
afterEach(async () => {
  edge.failure = undefined;
  edge.resets = 0;
  for (const peer of peers.splice(0)) peer.close();
  const identity = await readDiscovery(home);
  if (identity) await stopServer(identity);
  await rm(root, { recursive: true, force: true });
});

it("reports only diagnostics from the current failed startup, including retries", async () => {
  for (const diagnostic of ["Unsupported Harness settings format: version 1 required", ""]) {
    await expect(
      ensureLocalServer(home, {
        executable: process.execPath,
        args: ["-e", `process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1`],
      }),
    ).rejects.toMatchObject({
      message: `Server startup failed (exit 1); see ${log}${diagnostic ? `\n${diagnostic}` : ""}`,
    });
  }
  expect(await readFile(log, "utf8")).toContain("stale failure");
});

it("bounds startup diagnostics to the final 8 KiB", async () => {
  await expect(
    ensureLocalServer(home, {
      executable: process.execPath,
      args: [
        "-e",
        'process.stderr.write("x".repeat(16384) + "failure tail"); process.exitCode = 1',
      ],
    }),
  ).rejects.toThrow(`Server startup failed (exit 1); see ${log}\n${"x".repeat(8180)}failure tail`);
});

function ownerLaunch() {
  return {
    executable: process.execPath,
    args: [
      "--conditions=development",
      "--import=tsx",
      resolve("packages/server/src/bin.ts"),
      "--background",
    ],
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      HARNESS_HOME: home,
      HARNESS_SERVER_SELECTION: undefined,
      HARNESS_PREPARED_SERVER: undefined,
      ...(process.platform === "win32" ? {} : { SHELL: "/bin/bash" }),
    },
  };
}

for (const phase of ["existing discovery", "startup readiness"] as const)
  it(`recovers a connection reset during ${phase} using the existing startup path`, async () => {
    const first =
      phase === "existing discovery" ? await ensureLocalServer(home, ownerLaunch()) : undefined;
    if (first) peers.push(first);
    edge.failure = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const connected = await ensureLocalServer(home, ownerLaunch());
    peers.push(connected);
    expect(edge.resets).toBe(1);
    expect(connected.identity).toMatchObject({ home });
    expect((await readDiscovery(home))?.instanceId).toBe(connected.identity.instanceId);
    if (first) expect(connected.identity).toEqual(first.identity);
  }, 30000);

it("attach-only surfaces a reset without launching or replacing the owner", async () => {
  const first = await ensureLocalServer(home, ownerLaunch());
  peers.push(first);
  edge.failure = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  await expect(attachLocalServer(home)).rejects.toMatchObject({ code: "ECONNRESET" });
  expect((await readDiscovery(home))?.instanceId).toBe(first.identity.instanceId);
}, 30000);
