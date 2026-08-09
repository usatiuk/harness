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

  it("a model override replaces the selection and does not inherit its preset", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model: { provider: "p", model: "m1", preset: "high" },
    });

    const config = await resolveSettings({
      home,
      schemas,
      overrides: { model: { provider: "p", model: "m2" } },
    });

    expect(config.model).toEqual({ provider: "p", model: "m2" });
  });

  it("roots the workspace at cwd, not at an ancestor that holds a .harness/ dir", async () => {
    const home = await tmp();
    const root = await tmp(); // an ancestor with project settings (e.g. a ~/.harness-style dir)
    await writeJson(join(home, "settings.json"), { model });
    await writeJson(join(root, ".harness", "settings.json"), { instructions: "project" });
    const sub = join(root, "packages", "cli");
    await mkdir(sub, { recursive: true });

    const config = await resolveSettings({ home, cwd: sub, schemas });

    expect(config.instructions).toBe("project"); // settings still discovered up the tree
  });

  it("skips project layers and applies schema defaults when projectless", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), { model });

    const config = await resolveSettings({ home, schemas });

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

  it("accepts customProviders only in global settings (fail-fast elsewhere)", async () => {
    const provider = {
      type: "openai-responses-compatible",
      endpoint: "http://localhost:8000/v1",
      apiKey: "k",
      models: { m: {} },
    };

    // Global settings: accepted (read by the CLI composition root).
    const home = await tmp();
    await writeJson(join(home, "settings.json"), { model, customProviders: { mine: provider } });
    await expect(resolveSettings({ home, schemas })).resolves.toBeTruthy();

    // Project layer: rejected loudly rather than silently ignored.
    const root = await tmp();
    const projHome = await tmp();
    await writeJson(join(projHome, "settings.json"), { model });
    await writeJson(join(root, ".harness", "settings.json"), {
      customProviders: { mine: provider },
    });
    await expect(resolveSettings({ home: projHome, cwd: root, schemas })).rejects.toThrow(
      /invalid settings in .*settings\.json.*customProviders/s,
    );

    // Profile layer: rejected loudly rather than silently ignored.
    const profHome = await tmp();
    await writeJson(join(profHome, "settings.json"), {
      model,
      profiles: { x: { customProviders: { mine: provider } } },
    });
    await expect(resolveSettings({ home: profHome, profile: "x", schemas })).rejects.toThrow(
      /invalid settings in .*settings\.json.*customProviders/s,
    );
  });

  it("rejects auth and customProviders in project-local settings (not just project-shared)", async () => {
    const home = await tmp();
    const root = await tmp();
    await writeJson(join(home, "settings.json"), { model });
    for (const key of ["auth", "customProviders"]) {
      const file = join(root, ".harness", "settings.local.json");
      await writeJson(file, { [key]: { store: "keyring" } });
      await expect(resolveSettings({ home, cwd: root, schemas })).rejects.toThrow(
        new RegExp(`${key}`),
      );
      await rm(file, { force: true });
    }
  });

  it("rejects a custom provider type outside the discriminated union", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      customProviders: {
        mine: { type: "openai-compatible", endpoint: "http://a", apiKey: "k", model: "m" },
      },
    });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(
      /invalid settings in .*settings\.json/,
    );
  });

  it("parses a valid openai-completions-compatible provider", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      customProviders: {
        ovms: {
          type: "openai-completions-compatible",
          endpoint: "http://localhost:8000/v1",
          apiKey: "k",
          models: {
            "qwen3.6": {
              contextWindow: 200_000,
              maxOutputTokens: 4096,
              presets: { fast: { temperature: 0.2 } },
            },
          },
        },
      },
    });
    await expect(resolveSettings({ home, schemas })).resolves.toBeTruthy();
  });

  it("rejects unknown custom model fields instead of silently stripping typos", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      customProviders: {
        local: {
          type: "openai-responses-compatible",
          endpoint: "http://localhost:8000/v1",
          apiKey: "k",
          models: { m: { maxOutputToken: 4096 } },
        },
      },
    });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(/maxOutputToken/);
  });

  it.each([
    [{ contextWindow: 1024, maxOutputTokens: 2048 }, /maxOutputTokens cannot exceed contextWindow/],
    [
      { maxOutputTokens: 1024, presets: { unsafe: { maxTokens: 2048 } } },
      /preset maxTokens cannot exceed the model's output capacity/,
    ],
    [
      { contextWindow: 1024, presets: { unsafe: { maxTokens: 2048 } } },
      /preset maxTokens cannot exceed the model's output capacity/,
    ],
  ])("rejects incoherent custom-model capacity %#", async (entry, expected) => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      customProviders: {
        local: {
          type: "openai-responses-compatible",
          endpoint: "http://localhost:8000/v1",
          apiKey: "k",
          models: { m: entry },
        },
      },
    });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(expected);
  });

  it.each([
    "model",
    "tools",
    "stream",
    "store",
    "max_tokens",
    "previous_response_id",
    "truncation",
    "background",
  ])("rejects OpenAI extraBody overriding Harness-owned field %s", async (field) => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      customProviders: {
        local: {
          type: "openai-responses-compatible",
          endpoint: "http://localhost:8000/v1",
          apiKey: "k",
          models: { m: { presets: { unsafe: { extraBody: { [field]: "override" } } } } },
        },
      },
    });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(
      new RegExp(`cannot override Harness-owned field '${field}'`),
    );
  });

  it("rejects fileTools apply_patch on a completions-typed model", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      customProviders: {
        ovms: {
          type: "openai-completions-compatible",
          endpoint: "http://localhost:8000/v1",
          apiKey: "k",
          models: { "qwen3.6": { fileTools: "apply_patch" } },
        },
      },
    });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(
      /only function tools \(not 'apply_patch'\)/,
    );
  });

  it("rejects fileTools apply_patch on an anthropic-typed model (function-only transport)", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      customProviders: {
        local: {
          type: "anthropic-compatible",
          endpoint: "http://localhost:1234",
          apiKey: "k",
          models: { claude: { fileTools: "apply_patch" } },
        },
      },
    });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(
      /only function tools \(not 'apply_patch'\)/,
    );
  });

  it("rejects a custom provider with no models (empty catalog)", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      customProviders: {
        dead: {
          type: "openai-responses-compatible",
          endpoint: "http://a",
          apiKey: "k",
          models: {},
        },
      },
    });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(/at least one model/);
  });

  it("rejects the pre-refactor provider-level model shape", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      customProviders: {
        old: {
          type: "openai-responses-compatible",
          endpoint: "http://a",
          apiKey: "k",
          model: "m",
          presets: { fast: { temperature: 0.2 } },
        },
      },
    });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(
      /invalid settings in .*settings\.json/s,
    );
  });

  it("rejects sendInstructionsAsSystem on the completions type (not a field there)", async () => {
    const home = await tmp();
    await writeJson(join(home, "settings.json"), {
      model,
      customProviders: {
        ovms: {
          type: "openai-completions-compatible",
          endpoint: "http://localhost:8000/v1",
          apiKey: "k",
          models: { "qwen3.6": {} },
          sendInstructionsAsSystem: true,
        },
      },
    });
    await expect(resolveSettings({ home, schemas })).rejects.toThrow(/sendInstructionsAsSystem/);
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

  it("does not treat a git-tracked Harness-home parent as the project", async () => {
    const parent = await tmp();
    const home = join(parent, ".harness");
    await mkdir(home, { recursive: true });
    await mkdir(join(parent, ".git"), { recursive: true });
    const proj = join(parent, "myproject");
    await mkdir(proj, { recursive: true });

    expect(await findProjectRoot(proj, home)).toBe(proj);
  });

  it("finds a repository outside the configured home tree", async () => {
    const homeParent = await tmp();
    const home = join(homeParent, ".harness");
    await mkdir(home, { recursive: true });
    const outside = await tmp();
    const repo = join(outside, "repo");
    const sub = join(repo, "packages", "cli");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(sub, { recursive: true });

    expect(await findProjectRoot(sub, home)).toBe(repo);
  });

  it("finds a repository whose root also contains a custom-named Harness home", async () => {
    const repo = await tmp();
    const home = join(repo, ".harness-global");
    const sub = join(repo, "packages", "cli");
    await mkdir(home, { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(sub, { recursive: true });

    expect(await findProjectRoot(sub, home)).toBe(repo);
  });

  it.runIf(process.platform === "win32")(
    "compares the home boundary case-insensitively",
    async () => {
      const parent = await tmp();
      const home = join(parent, ".harness");
      await mkdir(home, { recursive: true });
      const proj = join(parent, "myproject");
      await mkdir(proj, { recursive: true });

      expect(await findProjectRoot(proj, home.toUpperCase())).toBe(proj);
    },
  );
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
