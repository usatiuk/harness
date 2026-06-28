import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerRoot } from "./devcontainer.ts";

const created: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hsbx-"));
  created.push(dir);
  return dir;
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

describe("containerRoot", () => {
  it("finds the .devcontainer dir from a subdirectory", async () => {
    const root = await tmp();
    await mkdir(join(root, ".devcontainer"), { recursive: true });
    const sub = join(root, "packages", "cli");
    await mkdir(sub, { recursive: true });

    expect(await containerRoot(sub)).toBe(root);
  });

  it("returns the start dir when no .devcontainer exists up the tree", async () => {
    const root = await tmp();
    const sub = join(root, "packages", "cli");
    await mkdir(sub, { recursive: true });

    expect(await containerRoot(sub)).toBe(sub);
  });

  it("stops at the nearest .devcontainer, not one further up", async () => {
    const outer = await tmp();
    await mkdir(join(outer, ".devcontainer"), { recursive: true });
    const inner = join(outer, "workspace");
    await mkdir(join(inner, ".devcontainer"), { recursive: true });
    const sub = join(inner, "src");
    await mkdir(sub, { recursive: true });

    expect(await containerRoot(sub)).toBe(inner);
  });
});
