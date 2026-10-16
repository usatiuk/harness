import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("restores a missing addon and publishes rebuilds without overwriting the old file", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-native-build-"));
  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const target = { rust: "fixture-target", library: "fixture-library" };
  const output = join(root, "packages/native");
  const compiled = join(root, "native/target", target.rust, "debug", target.library);
  try {
    for (const directory of [
      output,
      join(root, "scripts"),
      join(root, "packages/desktop/tools"),
      join(root, "native/target", target.rust, "debug"),
    ])
      await mkdir(directory, { recursive: true });
    await copyFile(
      join(sourceRoot, "scripts/build-native.mjs"),
      join(root, "scripts/build-native.mjs"),
    );
    await writeFile(
      join(root, "scripts/native-target.mjs"),
      `export const nativeTarget = () => (${JSON.stringify(target)});\n`,
    );
    // Replace only the Cargo process edge; the fixture supplies its compiled output.
    await writeFile(join(root, "packages/desktop/tools/native.mjs"), "process.exit(0);\n");
    const build = () =>
      promisify(execFile)(process.execPath, [join(root, "scripts/build-native.mjs")]);
    await writeFile(compiled, "first build");
    await build();
    const addon = join(output, "harness-native.node");
    expect(await readFile(addon, "utf8")).toBe("first build");
    const retained = join(root, "retained.node");
    await link(addon, retained);
    await writeFile(compiled, "second build");
    await build();
    expect(await readFile(addon, "utf8")).toBe("second build");
    expect(await readFile(retained, "utf8")).toBe("first build");
    await rm(compiled);
    await expect(build()).rejects.toThrow();
    expect(await readFile(addon, "utf8")).toBe("second build");
    expect(await readdir(output)).toEqual(["harness-native.node"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
