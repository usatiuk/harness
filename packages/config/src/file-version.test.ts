import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { readGlobalSettings, updateGlobalModel } from "./write.ts";
import { resolveSettings } from "./resolve.ts";

it.each([undefined, 0, 2, "1"])(
  "rejects persisted settings version %s without changing bytes",
  async (version) => {
    const home = await mkdtemp(join(tmpdir(), "harness-settings-version-"));
    const path = join(home, "settings.json");
    const original = `${JSON.stringify({ version, instructions: "keep me", profiles: { fast: { instructions: "fragment" } } })}\n`;
    try {
      await writeFile(path, original);
      await expect(readGlobalSettings(home)).rejects.toThrow("Unsupported Harness settings format");
      await expect(resolveSettings({ home, schemas: new Map() })).rejects.toThrow(
        "Unsupported Harness settings format",
      );
      await expect(updateGlobalModel(home, { provider: "demo", model: "demo-1" })).rejects.toThrow(
        "Unsupported Harness settings format",
      );
      expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("persists the baseline version while profiles and resolved settings remain fragments", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-settings-baseline-"));
  const path = join(home, "settings.json");
  try {
    await writeFile(
      path,
      JSON.stringify({ version: 1, profiles: { fast: { instructions: "fast" } } }),
    );
    await updateGlobalModel(home, { provider: "demo", model: "demo-1" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      model: { provider: "demo", model: "demo-1" },
      profiles: { fast: { instructions: "fast" } },
    });
    expect(await readGlobalSettings(home)).not.toHaveProperty("version");
    expect(
      (await resolveSettings({ home, schemas: new Map(), profile: "fast" })).instructions,
    ).toBe("fast");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
