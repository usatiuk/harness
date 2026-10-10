import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { cleanSourceCommit, repositoryRoot } from "./version.ts";

const packageSchema = z.looseObject({
  name: z.string().regex(/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/u),
  version: z.string().min(1),
  license: z.unknown().optional(),
});
const lockSchema = z.looseObject({
  packages: z.record(
    z.string(),
    z.looseObject({
      version: z.string().optional(),
      link: z.boolean().optional(),
      optional: z.boolean().optional(),
    }),
  ),
});
const cargoSchema = z.looseObject({
  packages: z.array(
    z.looseObject({
      name: z.string().min(1),
      version: z.string().min(1),
      source: z.string().nullable(),
      manifest_path: z.string(),
      license: z.string().nullable(),
      license_file: z.string().nullable(),
    }),
  ),
});
const noticeName = /licen[cs]e|copying|copyright|notice/iu;
type Notice = {
  ecosystem: "npm" | "cargo";
  path: string;
  name: string;
  version: string;
  license: string | null;
  files: string[];
};

function publicPath(value: string): string {
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))
  )
    throw new Error("Unsafe source/dependency path");
  return value;
}

function within(root: string, path: string): boolean {
  const difference = relative(root, path);
  return (
    difference === "" ||
    (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`))
  );
}

/** No source-export consumer needs links today. Refuse them rather than let tar
 * or a notice copy traverse an unexpected dependency/staging boundary. */
async function files(
  directory: string,
  root = directory,
  skipNestedNpm = false,
): Promise<string[]> {
  if (!within(await realpath(root), await realpath(directory)))
    throw new Error("Dependency directory escapes its source root");
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Source/dependency symbolic links are unsupported");
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Nested npm packages have their own frozen lock entries and notices.
      if (!skipNestedNpm || entry.name !== "node_modules")
        result.push(...(await files(path, root, skipNestedNpm)));
    } else if (entry.isFile()) result.push(path);
    else throw new Error("Unexpected source/dependency file type");
  }
  return result;
}

async function notices(
  directory: string,
  entry: Omit<Notice, "files">,
  source: string,
  declared?: string | null,
): Promise<Notice> {
  const selected: string[] = [];
  const declaredPath = declared
    ? publicPath(
        isAbsolute(declared) ? relative(directory, declared).split(sep).join("/") : declared,
      )
    : undefined;
  for (const path of await files(directory, directory, entry.ecosystem === "npm")) {
    const local = relative(directory, path).split(sep).join("/");
    let include = local.split("/").some((part) => noticeName.test(part));
    if (declaredPath && local === declaredPath) include = true;
    if (!include && /^readme(?:\.|$)/iu.test(basename(path)))
      include = /\b(?:license|licence|copyright)\b/iu.test(await readFile(path, "utf8"));
    if (!include) continue;
    const destination = join(source, "third-party/notices", entry.ecosystem, entry.path, local);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path), { flag: "wx" });
    selected.push(relative(source, destination).split(sep).join("/"));
  }
  return { ...entry, files: selected.sort() };
}

async function checkInstalledPackages(
  root: string,
  lock: z.infer<typeof lockSchema>,
): Promise<void> {
  const canonicalRoot = await realpath(root);
  const inspect = async (directory: string, scope = false): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (!scope && entry.name.startsWith("@")) {
        if (!entry.isDirectory()) throw new Error("Unexpected npm scope directory");
        await inspect(path, true);
        continue;
      }
      const key = publicPath(relative(root, path).split(sep).join("/"));
      const locked = lock.packages[key];
      if (!locked) throw new Error(`Installed npm package is absent from lock: ${key}`);
      if (!within(canonicalRoot, await realpath(path)))
        throw new Error("npm package escapes checkout");
      if (!locked.link) await inspect(join(path, "node_modules"));
    }
  };
  await inspect(join(root, "node_modules"));
}

export interface SourceExport {
  archive: string;
  notices: string;
  inventory: string;
  missingNotices: string[];
}

/** Export a captured source tree and actual dependency notices. Cargo owns locked
 * source resolution; this utility never invents a license or treats registry URLs
 * as the preferred source of bundled npm code. */
export async function exportSource(options: {
  root: string;
  sourceCommit: string;
  output: string;
}): Promise<SourceExport> {
  const root = resolve(options.root);
  const output = resolve(options.output);
  if (cleanSourceCommit(root) !== options.sourceCommit)
    throw new Error("Source export differs from the captured clean commit");
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" });
  // Inspect before extraction: Git symlink/submodule entries must never become
  // writes through tar links or an incomplete source snapshot.
  for (const entry of git(["ls-tree", "-r", "-z", options.sourceCommit]).split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\t");
    if (separator === -1 || !/^100(?:644|755) blob [a-f0-9]{40}$/u.test(entry.slice(0, separator)))
      throw new Error("Source export requires regular tracked files, without links or submodules");
    publicPath(entry.slice(separator + 1));
  }
  const product = z
    .looseObject({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u) })
    .parse(JSON.parse(git(["show", `${options.sourceCommit}:release/product.json`])));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Refuse existing output; cleanup below owns only this directory.
  let complete = false;
  const stage = join(output, ".source");
  const source = join(stage, `harness-${product.version}`);
  try {
    await mkdir(source, { recursive: true });
    const snapshot = join(output, ".snapshot.tar");
    git(["archive", "--format=tar", "--output", snapshot, options.sourceCommit]);
    execFileSync("tar", ["-xf", snapshot, "-C", source], { windowsHide: true });
    await rm(snapshot);
    await files(source);
    for (const required of [
      "LICENSE",
      "release/BUILDING.md",
      "package-lock.json",
      "native/Cargo.lock",
      "packages/desktop/src-tauri/Cargo.lock",
    ])
      await readFile(join(source, required));
    const inventory: Notice[] = [];
    const lock = lockSchema.parse(
      JSON.parse(await readFile(join(source, "package-lock.json"), "utf8")),
    );
    await checkInstalledPackages(root, lock);
    for (const [path, locked] of Object.entries(lock.packages).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (!path.includes("node_modules/") || locked.link) continue;
      publicPath(path);
      const directory = join(root, path);
      let canonical: string;
      try {
        canonical = await realpath(directory);
      } catch (error) {
        if (locked.optional && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!within(await realpath(root), canonical)) throw new Error("npm package escapes checkout");
      const text = await readFile(join(directory, "package.json"), "utf8");
      const installed = packageSchema.parse(JSON.parse(text));
      if (!locked.version || installed.version !== locked.version)
        throw new Error(`Installed npm version differs from lock: ${path}`);
      const license = typeof installed.license === "string" ? installed.license : null;
      const declared = license?.match(/^SEE LICEN[CS]E IN (.+)$/iu)?.[1];
      inventory.push(
        await notices(
          directory,
          { ecosystem: "npm", path, name: installed.name, version: installed.version, license },
          source,
          declared,
        ),
      );
    }
    const vendor = execFileSync(
      "cargo",
      [
        "vendor",
        "--locked",
        "--versioned-dirs",
        "--manifest-path",
        "native/Cargo.toml",
        "--sync",
        "packages/desktop/src-tauri/Cargo.toml",
        "third-party/cargo",
      ],
      { cwd: source, windowsHide: true, encoding: "utf8" },
    );
    const configuration = vendor.replace(
      /^directory = "[^"\r\n]+"$/gmu,
      'directory = "third-party/cargo"',
    );
    if (
      !configuration.includes('directory = "third-party/cargo"') ||
      configuration.includes(root) ||
      configuration.includes(source)
    )
      throw new Error("Cargo vendor returned an unsupported source configuration");
    await mkdir(join(source, ".cargo"));
    await writeFile(join(source, ".cargo/config.toml"), configuration, { flag: "wx" });
    await files(join(source, "third-party/cargo"));
    const seen = new Set<string>();
    for (const manifest of ["native/Cargo.toml", "packages/desktop/src-tauri/Cargo.toml"]) {
      const metadata = cargoSchema.parse(
        JSON.parse(
          execFileSync(
            "cargo",
            [
              "metadata",
              "--locked",
              "--offline",
              "--format-version",
              "1",
              "--manifest-path",
              manifest,
            ],
            { cwd: source, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 ** 2 },
          ),
        ),
      );
      for (const dependency of metadata.packages) {
        if (dependency.source === null) continue;
        const directory = await realpath(dirname(dependency.manifest_path));
        if (!within(await realpath(join(source, "third-party/cargo")), directory))
          throw new Error("Cargo metadata escapes vendored source");
        const path = publicPath(relative(source, directory).split(sep).join("/"));
        if (seen.has(path)) continue;
        seen.add(path);
        inventory.push(
          await notices(
            directory,
            {
              ecosystem: "cargo",
              path,
              name: dependency.name,
              version: dependency.version,
              license: dependency.license,
            },
            source,
            dependency.license_file,
          ),
        );
      }
    }
    // A README mentioning "MIT" is useful evidence, not a full license file.
    // Keep its text, but leave that package's notice qualification open.
    const missingNotices = inventory
      .filter((entry) => entry.files.every((path) => /^readme(?:\.|$)/iu.test(basename(path))))
      .map((entry) => `${entry.ecosystem}:${entry.name}@${entry.version}`);
    const heading =
      "Harness dependency notices\n\nThis inventory includes all installed locked npm packages, including build tools, and vendored dependencies of both locked Cargo manifests. Original notice files are preserved in the source archive. Missing notices require publication review. npm package contents and lock URLs are not a complete corresponding-source guarantee; upstream preferred source and bundled system-library obligations require release qualification.\n\n";
    const sections: string[] = [];
    for (const entry of inventory) {
      sections.push(
        `${entry.ecosystem}: ${entry.name}@${entry.version}\nLicense metadata: ${entry.license ?? "unspecified"}\n`,
      );
      if (missingNotices.includes(`${entry.ecosystem}:${entry.name}@${entry.version}`))
        sections.push("No full notice file found; publication review required.\n");
      for (const path of entry.files)
        sections.push(`${path}\n${await readFile(join(source, path), "utf8")}\n`);
    }
    const noticeName = `harness-${product.version}-notices.txt`;
    const inventoryName = "source.json";
    await writeFile(join(source, "THIRD-PARTY-NOTICES.txt"), `${heading}${sections.join("\n")}`, {
      flag: "wx",
    });
    await writeFile(join(output, noticeName), `${heading}${sections.join("\n")}`, { flag: "wx" });
    const description = {
      productVersion: product.version,
      sourceCommit: options.sourceCommit,
      npmPreferredSourceComplete: false,
      missingNotices,
      dependencies: inventory,
    };
    await writeFile(join(source, "SOURCE.json"), `${JSON.stringify(description, null, 2)}\n`, {
      flag: "wx",
    });
    await writeFile(join(output, inventoryName), `${JSON.stringify(description, null, 2)}\n`, {
      flag: "wx",
    });
    const archive = join(output, `harness-${product.version}-source.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", stage, basename(source)], { windowsHide: true });
    await rm(stage, { recursive: true, force: true });
    complete = true;
    return {
      archive,
      notices: join(output, noticeName),
      inventory: join(output, inventoryName),
      missingNotices,
    };
  } finally {
    if (!complete) await rm(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 && process.argv.length !== 4)
    throw new Error("Usage: source.ts OUTPUT [SOURCE_COMMIT]");
  const exported = await exportSource({
    root: repositoryRoot,
    output: process.argv[2]!,
    sourceCommit: process.argv[3] ?? cleanSourceCommit(repositoryRoot),
  });
  process.stdout.write(
    `${JSON.stringify({ archive: basename(exported.archive), missingNotices: exported.missingNotices })}\n`,
  );
}
