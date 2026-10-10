import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportSource } from "../../../release/tools/source.ts";

// Git, archives and filesystem boundaries are real. Cargo resolution/downloads
// are controlled; these cases do not qualify Cargo's actual vendor output or
// completeness of upstream preferred npm/system-library source.
const cargo = vi.hoisted(() => ({ calls: [] as string[][], escape: false, fail: false }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (args[0] !== "cargo") return actual.execFileSync(...args);
      const parameters = args[1] as string[];
      const cwd = (args[2] as { cwd: string }).cwd;
      cargo.calls.push(parameters);
      if (cargo.fail) throw new Error("Controlled vendor failure");
      const directory = join(cwd, "third-party/cargo/fixture-1.2.3");
      if (parameters[0] === "vendor") {
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "Cargo.toml"),
          '[package]\nname="fixture"\nversion="1.2.3"\n',
        );
        writeFileSync(join(directory, "LICENSE"), "Full Rust fixture copyright and license\n");
        return `[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "${directory.replaceAll("\\", "/")}"\n`;
      }
      return JSON.stringify({
        packages: [
          {
            name: "fixture",
            version: "1.2.3",
            source: "registry+https://github.com/rust-lang/crates.io-index",
            manifest_path: join(cargo.escape ? dirname(cwd) : directory, "Cargo.toml"),
            license: "MIT",
            license_file: "LICENSE",
          },
        ],
      });
    },
  };
});

const temporary: string[] = [];
afterEach(async () => {
  cargo.calls = [];
  cargo.escape = false;
  cargo.fail = false;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
}
function commit(root: string): string {
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Source Fixture",
    "-c",
    "user.email=source@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Source fixture",
  ]);
  return git(root, ["rev-parse", "HEAD"]);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-source-"));
  temporary.push(root);
  await put(root, ".gitignore", "node_modules/\noutput/\nprivate.key\n");
  await put(root, "release/product.json", JSON.stringify({ version: "0.1.0" }));
  await put(
    root,
    "release/BUILDING.md",
    "Build from the exported source with local Git initialization.\n",
  );
  await put(root, "LICENSE", "The fixture's complete project license\n");
  await put(root, "native/Cargo.toml", "[workspace]\nmembers=[]\n");
  await put(
    root,
    "packages/desktop/src-tauri/Cargo.toml",
    '[package]\nname="fixture-desktop"\nversion="0.1.0"\n',
  );
  for (const path of ["native/Cargo.lock", "packages/desktop/src-tauri/Cargo.lock"])
    await put(root, path, '[[package]]\nname="fixture"\nversion="1.2.3"\n');
  await put(
    root,
    "package-lock.json",
    JSON.stringify({
      packages: {
        "": { version: "0.1.0" },
        "node_modules/frontend": { version: "2.3.4" },
        "node_modules/frontend/node_modules/nested": { version: "3.4.5" },
        "node_modules/absent-platform": { version: "1.0.0", optional: true },
      },
    }),
  );
  await put(
    root,
    "node_modules/frontend/package.json",
    JSON.stringify({ name: "frontend", version: "2.3.4", license: "MIT" }),
  );
  await put(root, "node_modules/frontend/LICENSE", "Full frontend fixture copyright and license\n");
  await put(
    root,
    "node_modules/frontend/node_modules/nested/package.json",
    JSON.stringify({ name: "nested", version: "3.4.5", license: "MIT" }),
  );
  await put(
    root,
    "node_modules/frontend/node_modules/nested/README.md",
    "# Package\n## License\nFull nested fixture copyright and license\n",
  );
  await put(
    root,
    "node_modules/frontend/node_modules/nested/COPYING",
    "Full nested fixture license\n",
  );
  await put(root, "private.key", "Ignored fake fixture secret; never a real key\n");
  git(root, ["init", "--quiet"]);
  const sourceCommit = commit(root);
  return { root, sourceCommit, output: join(root, "output/export") };
}

describe("release source export", () => {
  it("exports the exact committed tree, full notices and both locked Cargo sources without private history", async () => {
    const options = await fixture();
    const result = await exportSource(options);
    const extracted = join(options.root, "output/extracted");
    await mkdir(extracted);
    execFileSync("tar", ["-xf", result.archive, "-C", extracted], { windowsHide: true });
    const source = join(extracted, "harness-0.1.0");
    expect(await readFile(join(source, "LICENSE"), "utf8")).toBe(
      "The fixture's complete project license\n",
    );
    await expect(readFile(join(source, ".git/HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(source, "private.key"))).rejects.toMatchObject({ code: "ENOENT" });
    const noticeText = await readFile(result.notices, "utf8");
    expect(noticeText).toContain("Full frontend fixture copyright and license");
    expect(noticeText).toContain("Full nested fixture copyright and license");
    expect(noticeText).toContain("Full Rust fixture copyright and license");
    expect(noticeText).not.toContain(options.root);
    expect(await readFile(join(source, ".cargo/config.toml"), "utf8")).toContain(
      'directory = "third-party/cargo"',
    );
    const inventory = JSON.parse(await readFile(result.inventory, "utf8")) as {
      sourceCommit: string;
      npmPreferredSourceComplete: boolean;
      dependencies: { ecosystem: string }[];
    };
    expect(inventory.sourceCommit).toBe(options.sourceCommit);
    expect(inventory.npmPreferredSourceComplete).toBe(false);
    expect(inventory.dependencies.filter((entry) => entry.ecosystem === "cargo")).toHaveLength(1);
    expect(result.missingNotices).toEqual([]);
    expect(cargo.calls[0]).toEqual([
      "vendor",
      "--locked",
      "--versioned-dirs",
      "--manifest-path",
      "native/Cargo.toml",
      "--sync",
      "packages/desktop/src-tauri/Cargo.toml",
      "third-party/cargo",
    ]);
    expect(cargo.calls.slice(1).map((args) => args.at(-1))).toEqual([
      "native/Cargo.toml",
      "packages/desktop/src-tauri/Cargo.toml",
    ]);
  });

  it("rejects dirty/captured-source and installed-version mismatches before publishing", async () => {
    const options = await fixture();
    await put(options.root, "dirty.txt", "dirty\n");
    await expect(exportSource(options)).rejects.toThrow("clean checkout");
    await rm(join(options.root, "dirty.txt"));
    await expect(exportSource({ ...options, sourceCommit: "a".repeat(40) })).rejects.toThrow(
      "captured clean commit",
    );
    await put(
      options.root,
      "node_modules/frontend/package.json",
      JSON.stringify({ name: "frontend", version: "9.9.9" }),
    );
    await expect(exportSource(options)).rejects.toThrow("Installed npm version differs");
    await expect(readFile(join(options.output, "source.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(cargo.calls).toHaveLength(0);
  });

  it("retains existing output and cleans only newly owned failed scratch", async () => {
    const options = await fixture();
    await put(options.output, "sentinel", "existing\n");
    await expect(exportSource(options)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(options.output, "sentinel"), "utf8")).toBe("existing\n");
    await rm(options.output, { recursive: true });
    cargo.fail = true;
    await expect(exportSource(options)).rejects.toThrow("Controlled vendor failure");
    await expect(readFile(join(options.output, "source.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects escaped Cargo metadata and notice links instead of reading outside dependency roots", async () => {
    const options = await fixture();
    cargo.escape = true;
    await expect(exportSource(options)).rejects.toThrow("escapes vendored source");
    cargo.escape = false;
    const directory = join(options.root, "node_modules/frontend/licenses");
    await symlink(options.root, directory, process.platform === "win32" ? "junction" : "dir");
    await expect(exportSource(options)).rejects.toThrow("symbolic links are unsupported");
  });

  it("reports missing notice text explicitly without claiming npm corresponding-source completeness", async () => {
    const options = await fixture();
    await rm(join(options.root, "node_modules/frontend/LICENSE"));
    await put(options.root, "node_modules/frontend/README.md", "## License\nMIT\n");
    const result = await exportSource(options);
    expect(result.missingNotices).toEqual(["npm:frontend@2.3.4"]);
    expect(await readFile(result.notices, "utf8")).toContain("publication review required");
  });

  it("rejects installed packages outside the frozen graph and unsafe lock paths", async () => {
    const options = await fixture();
    await put(
      options.root,
      "node_modules/extraneous/package.json",
      '{"name":"extraneous","version":"1.0.0"}',
    );
    await expect(exportSource(options)).rejects.toThrow("absent from lock");
    await rm(join(options.root, "node_modules/extraneous"), { recursive: true });
    const lock = JSON.parse(await readFile(join(options.root, "package-lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    lock.packages["node_modules/../../escape"] = { version: "1.0.0" };
    await put(options.root, "package-lock.json", JSON.stringify(lock));
    options.sourceCommit = commit(options.root);
    await expect(exportSource(options)).rejects.toThrow("Unsafe source/dependency path");
  });

  it("does not treat an incomplete installed optional package as absent", async () => {
    const options = await fixture();
    await put(options.root, "node_modules/absent-platform/incomplete.txt", "partial install\n");
    await expect(exportSource(options)).rejects.toMatchObject({ code: "ENOENT" });
    expect(cargo.calls).toHaveLength(0);
  });

  it("rejects tracked links before extracting the captured Git archive", async () => {
    const options = await fixture();
    git(options.root, ["config", "core.symlinks", "false"]);
    await put(options.root, "linked", "../outside");
    const blob = git(options.root, ["hash-object", "-w", "linked"]);
    git(options.root, ["update-index", "--add", "--cacheinfo", `120000,${blob},linked`]);
    git(options.root, [
      "-c",
      "user.name=Source Fixture",
      "-c",
      "user.email=source@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Tracked link",
    ]);
    options.sourceCommit = git(options.root, ["rev-parse", "HEAD"]);
    await expect(exportSource(options)).rejects.toThrow("without links or submodules");
    expect(cargo.calls).toHaveLength(0);
  });
});
