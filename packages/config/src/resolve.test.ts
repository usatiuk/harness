import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { findProjectRoot, resolveSettings } from "./resolve.ts";

const schemas = new Map<string, z.ZodType>([
  [
    "demo",
    z.strictObject({
      level: z.enum(["low", "high"]).default("low"),
      rules: z.record(z.string(), z.string()).default({}),
    }),
  ],
]);

const created: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hcfg-"));
  created.push(dir);
  return dir;
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

const model = { provider: "p", model: "m" };

describe("resolveSettings cascade", () => {
  it("layers global < project-shared < project-local", async () => {
    const home = await tmp();
    const root = await tmp();
    await writeJson(join(home, "settings.json"), { model, instructions: "global" });
    await writeJson(join(root, ".harness", "settings.json"), {
      instructions: "project",
      plugins: { demo: { level: "high" } },
    });
    await writeJson(join(root, ".harness", "settings.local.json"), { instructions: "local" });

    const config = await resolveSettings({ home, cwd: root, schemas });

    expect(config.instructions).toBe("local"); // local wins
    expect(config.model).toEqual(model); // only global set it
    expect(config.workspaceRoot).toBe(root);
    expect(config.plugins?.demo).toEqual({ level: "high", rules: {} });
  });

  it("applies profile above project, and overrides above profile", async () => {
    const home = await tmp();
    const root = await tmp();
    await writeJson(join(home, "settings.json"), { model, instructions: "global" });
    await writeJson(join(root, ".harness", "settings.json"), {
      profiles: { explorer: { instructions: "explorer", plugins: { demo: { level: "high" } } } },
    });

    const config = await resolveSettings({
      home,
      cwd: root,
      profile: "explorer",
      overrides: { instructions: "override" },
      schemas,
    });

    expect(config.instructions).toBe("override");
    expect(config.plugins?.demo).toEqual({ level: "high", rules: {} });
  });

  it("roots the workspace at cwd, not at an ancestor that holds a .harness/ dir", async () => {
    const home = await tmp();
    const root = await tmp(); // an ancestor with project settings (e.g. a ~/.harness-style dir)
    await writeJson(join(home, "settings.json"), { model });
    await writeJson(join(root, ".harness", "settings.json"), { instructions: "project" });
    const sub = join(root, "packages", "cli");
    await mkdir(sub, { recursive: true });

    const config = await resolveSettings({ home, cwd: sub, schemas });

    expect(config.workspaceRoot).toBe(sub); // workspace is the cwd, not the ancestor
    expect(config.instructions).toBe("project"); // settings still discovered up the tree
  });

  it("skips project layers and applies schema defaults when projectless", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), { model });

    const config = await resolveSettings({ home, schemas });

    expect(config.workspaceRoot).toBeNull();
    expect(config.plugins?.demo).toEqual({ level: "low", rules: {} });
  });

  it("deep-merges id-keyed maps (union + per-key override) but replaces arrays", async () => {
    const home = await tmp();
    const root = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      tools: { allow: ["a", "b"] },
      plugins: { demo: { rules: { x: "1", y: "2" } } },
    });
    await writeJson(join(root, ".harness", "settings.json"), {
      tools: { allow: ["c"] },
      plugins: { demo: { rules: { y: "Y", z: "3" } } },
    });

    const config = await resolveSettings({ home, cwd: root, schemas });

    expect(config.tools?.allow).toEqual(["c"]); // array replaced
    expect(config.plugins?.demo).toEqual({ level: "low", rules: { x: "1", y: "Y", z: "3" } });
  });
});

describe("resolveSettings validation", () => {
  it("rejects an unknown plugin key, citing the plugin and the bad key", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), { model, plugins: { demo: { bogus: 1 } } });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(/demo.*bogus|bogus.*demo/s);
  });

  it("rejects an unknown plugin id", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), { model, plugins: { ghost: {} } });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(/unknown plugin 'ghost'/);
  });

  it("rejects an unknown top-level key, citing the file", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), { model, modle: "typo" });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(
      /invalid settings in .*settings\.json/,
    );
  });

  it("rejects a named profile that does not exist", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), { model });
    await expect(resolveSettings({ home, profile: "nope", schemas })).rejects.toThrow(
      /unknown profile: nope/,
    );
  });

  it("fails fast when no model is configured", async () => {
    const home = await tmp();
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(/no model configured/);
  });

  it("applies defaults below global, so a configured model still wins", async () => {
    const fallback = { provider: "fallback", model: "f" };

    // No settings file ⇒ defaults supplies the model instead of throwing.
    const bare = await resolveSettings({
      home: await tmp(),
      defaults: { model: fallback },
      schemas,
    });
    expect(bare.model).toEqual(fallback);

    // Global settings outrank defaults.
    const home = await tmp();
    await writeJson(join(home, "settings.json"), { model });
    const layered = await resolveSettings({ home, defaults: { model: fallback }, schemas });
    expect(layered.model).toEqual(model);
  });
});

describe("findProjectRoot", () => {
  // `home` plays the role of `~/.harness`: its basename is `.harness`, so the home-skip
  // (join(dir, ".harness") === home) matches it exactly as it does for the real home.
  it("never returns the harness home as a project root", async () => {
    const parent = await tmp();
    const home = join(parent, ".harness");
    await mkdir(home, { recursive: true }); // the home looks like a project marker
    const proj = join(parent, "myproject");
    await mkdir(proj, { recursive: true }); // no `.harness`, no `.git` of its own

    expect(await findProjectRoot(proj, home)).toBe(proj); // not `parent`, not `home`
  });

  it("prefers a nearer project .harness over the home", async () => {
    const parent = await tmp();
    const home = join(parent, ".harness");
    await mkdir(home, { recursive: true });
    const proj = join(parent, "myproject");
    await mkdir(join(proj, ".harness"), { recursive: true });
    const sub = join(proj, "packages", "cli");
    await mkdir(sub, { recursive: true });

    expect(await findProjectRoot(sub, home)).toBe(proj);
  });

  it("falls back to the enclosing git repo when no .harness exists", async () => {
    const parent = await tmp();
    const home = join(parent, ".harness");
    await mkdir(home, { recursive: true });
    const proj = join(parent, "myproject");
    await mkdir(join(proj, ".git"), { recursive: true }); // a git repo, no `.harness`
    const sub = join(proj, "packages", "cli");
    await mkdir(sub, { recursive: true });

    expect(await findProjectRoot(sub, home)).toBe(proj);
  });
});

describe("resolveSettings home/project separation", () => {
  it("does not read the harness home's .harness as project settings (the leak)", async () => {
    const parent = await tmp();
    const home = join(parent, ".harness"); // `~/.harness`
    await mkdir(home, { recursive: true });
    await writeJson(join(home, "settings.json"), { model, instructions: "global" });
    // The stray file the old bug wrote/read as project-local when the walk landed on `~`.
    await writeJson(join(home, "settings.local.json"), { instructions: "LEAKED" });
    const proj = join(parent, "myproject");
    await mkdir(proj, { recursive: true }); // project under the home, no `.harness`/`.git`

    const config = await resolveSettings({ home, cwd: proj, schemas });

    expect(config.workspaceRoot).toBe(proj);
    expect(config.instructions).toBe("global"); // not "LEAKED"
  });

  it("does not leak when the root falls back to the home itself (cwd === ~)", async () => {
    const parent = await tmp();
    const home = join(parent, ".harness");
    await mkdir(home, { recursive: true });
    await writeJson(join(home, "settings.json"), { model, instructions: "global" });
    // Old bug: findProjectRoot(parent) skips the marked home but the start/git fallback returns
    // `parent`, whose `.harness` IS the home — so `~/.harness/settings.local.json` was read as
    // project-local. The read-site `isHomeRoot` guard must skip it.
    await writeJson(join(home, "settings.local.json"), { instructions: "LEAKED" });

    const config = await resolveSettings({ home, cwd: parent, schemas });

    expect(config.instructions).toBe("global"); // not "LEAKED"
  });
});
