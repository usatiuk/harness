import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { updateGlobalModel, updateGlobalPluginConfig } from "./write.ts";

const newHome = () => mkdtemp(join(tmpdir(), "harness-cfg-"));
const readDoc = async (home: string) =>
  JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as Record<string, unknown>;

describe("updateGlobalModel", () => {
  it("creates the settings file with the model when none exists", async () => {
    const home = await newHome();
    await updateGlobalModel(home, { provider: "openai", model: "gpt-5.1" });
    expect((await readDoc(home)).model).toEqual({ provider: "openai", model: "gpt-5.1" });
  });

  it("persists the preset when present and validates against the schema", async () => {
    const home = await newHome();
    await updateGlobalModel(home, { provider: "openai", model: "gpt-5.1", preset: "high" });
    expect((await readDoc(home)).model).toEqual({
      provider: "openai",
      model: "gpt-5.1",
      preset: "high",
    });
  });

  it("overwrites model while preserving other keys and profiles", async () => {
    const home = await newHome();
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({
        instructions: "be nice",
        model: { provider: "demo", model: "demo-1" },
        profiles: { fast: { model: { provider: "openai", model: "gpt-5.1-codex" } } },
      }),
    );
    await updateGlobalModel(home, { provider: "openai", model: "gpt-5.1" });
    const doc = await readDoc(home);
    expect(doc.model).toEqual({ provider: "openai", model: "gpt-5.1" });
    expect(doc.instructions).toBe("be nice");
    expect(doc.profiles).toEqual({
      fast: { model: { provider: "openai", model: "gpt-5.1-codex" } },
    });
  });
});

describe("updateGlobalPluginConfig", () => {
  it("deep-patches one plugin while preserving its model and sibling plugins", async () => {
    const home = await newHome();
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({
        model: { provider: "demo", model: "demo-1" },
        plugins: {
          "auto-approval": {
            enabled: false,
            model: { provider: "openai", model: "reviewer" },
          },
          sandbox: { enabled: true },
        },
      }),
    );
    await updateGlobalPluginConfig(home, "auto-approval", { enabled: true });
    expect((await readDoc(home)).plugins).toEqual({
      "auto-approval": {
        enabled: true,
        model: { provider: "openai", model: "reviewer" },
      },
      sandbox: { enabled: true },
    });
  });
});
