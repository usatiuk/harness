import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub the docker substrate so tests need no daemon: record calls + report a provisioned flag.
const calls = vi.hoisted(() => ({
  reads: [] as string[],
  stops: 0,
  rebuilds: 0,
  provisioned: false,
}));
vi.mock("./docker.ts", () => ({
  DockerExecutionContext: class {
    isProvisioned() {
      return calls.provisioned;
    }
    async read(path: string) {
      calls.reads.push(path);
      return new Uint8Array();
    }
    async stop() {
      calls.stops++;
      calls.provisioned = false;
    }
    async rebuild() {
      calls.rebuilds++;
      calls.provisioned = true;
    }
  },
}));

const { SwitchableSandboxContext } = await import("./switchable.ts");
const { sandboxConfigSchema } = await import("./plugin.ts");

const te = new TextDecoder();
const created: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hsw-"));
  created.push(dir);
  return dir;
}
beforeEach(() => {
  calls.reads = [];
  calls.stops = 0;
  calls.rebuilds = 0;
  calls.provisioned = false;
});
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

describe("SwitchableSandboxContext", () => {
  it("routes IO to the local substrate when disabled (no docker provision)", async () => {
    const root = await tmp();
    await writeFile(join(root, "a.txt"), "local-content");
    const ctx = new SwitchableSandboxContext(root, sandboxConfigSchema.parse({ enabled: false }));

    expect(te.decode(await ctx.read("a.txt"))).toBe("local-content");
    expect(calls.reads).toEqual([]); // docker never touched
  });

  it("routes IO to the docker substrate when enabled", async () => {
    const root = await tmp();
    const ctx = new SwitchableSandboxContext(root, sandboxConfigSchema.parse({ enabled: true }));

    await ctx.read("a.txt");
    expect(calls.reads).toEqual(["a.txt"]);
  });

  it("flips enabled and tears down the container on setEnabled(false)", async () => {
    const root = await tmp();
    const ctx = new SwitchableSandboxContext(root, sandboxConfigSchema.parse({ enabled: true }));
    await ctx.read("x"); // creates the docker substrate
    expect(ctx.enabled).toBe(true);

    ctx.setEnabled(false);

    expect(ctx.enabled).toBe(false);
    expect(calls.stops).toBe(1);
  });

  it("reports running from the docker substrate's provisioning state", async () => {
    const root = await tmp();
    const ctx = new SwitchableSandboxContext(root, sandboxConfigSchema.parse({ enabled: true }));
    expect(ctx.running).toBe(false); // no docker ctx yet

    await ctx.read("x"); // creates the docker substrate
    expect(ctx.running).toBe(false); // substrate exists, not provisioned

    calls.provisioned = true;
    expect(ctx.running).toBe(true);
  });

  it("rebuild only acts when enabled; stop tears down but keeps the preference", async () => {
    const root = await tmp();
    const disabled = new SwitchableSandboxContext(
      root,
      sandboxConfigSchema.parse({ enabled: false }),
    );
    await disabled.rebuild(); // no-op
    expect(calls.rebuilds).toBe(0);

    const enabled = new SwitchableSandboxContext(
      root,
      sandboxConfigSchema.parse({ enabled: true }),
    );
    await enabled.rebuild();
    expect(calls.rebuilds).toBe(1);

    await enabled.stop();
    expect(calls.stops).toBe(1);
    expect(enabled.enabled).toBe(true); // stop keeps the enabled preference
  });
});
