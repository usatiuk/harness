import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Plugin, PluginContextItem, ServiceProvider } from "@harness/protocol";
import { executionServiceOf } from "@harness/execution";
import { fileTargetsOfValidatedCall } from "@harness/workspace";

const SERVICE_KEY = "agents-instructions";
const CONTEXT_KEY_PREFIX = "agents-md:";
const INSTRUCTION_FILE = "AGENTS.md";

interface InstructionFile {
  path: string;
  content: string;
}

const canonicalKey = (path: string): string =>
  `${CONTEXT_KEY_PREFIX}${process.platform === "win32" ? path.toLowerCase() : path}`;

const ancestorDirectories = (start: string): string[] => {
  const directories: string[] = [];
  let current = resolve(start);
  for (;;) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) return directories.reverse();
    current = parent;
  }
};

const readInstruction = async (directory: string): Promise<InstructionFile | undefined> => {
  const path = resolve(directory, INSTRUCTION_FILE);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink()) return undefined;
  const canonicalPath = await realpath(path);
  return {
    path: canonicalPath,
    content: await readFile(canonicalPath, "utf8"),
  };
};

const isWithin = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const nearestExistingRealPath = async (start: string): Promise<string> => {
  let current = resolve(start);
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
};

const renderInstruction = (file: InstructionFile, global: boolean): string =>
  [
    `AGENTS.md instructions from ${file.path}`,
    global
      ? "Scope: all conversations on this Harness server. Applicable project instructions follow."
      : `Scope: ${dirname(file.path)} and its descendants. Deeper AGENTS.md files take precedence.`,
    "",
    file.content,
  ].join("\n");

/** Host-path discovery scoped to the active workspace. */
class AgentsInstructions {
  readonly #workspaceRoot: string | null;
  readonly #home: string;

  constructor(home: string, workspaceRoot: string | null) {
    this.#home = resolve(home);
    this.#workspaceRoot = workspaceRoot === null ? null : resolve(workspaceRoot);
  }

  async roots() {
    const home = await realpath(this.#home).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return this.#home;
      throw error;
    });
    return { home, workspace: this.#workspaceRoot && (await realpath(this.#workspaceRoot)) };
  }
}

async function forTargets(
  root: string,
  paths: readonly string[],
  allowOutside: boolean,
): Promise<string[]> {
  const directories = new Set<string>();
  for (const path of paths) {
    const target = resolve(root, path);
    const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    const directory = info?.isDirectory() ? target : dirname(target);
    const canonicalDirectory = await nearestExistingRealPath(directory);
    if (!allowOutside && !isWithin(root, canonicalDirectory)) continue;
    for (const directory of ancestorDirectories(canonicalDirectory)) directories.add(directory);
  }
  return [...directories];
}

interface ServiceContext {
  service(key: string): unknown;
}

const instructionsOf = (ctx: ServiceContext): AgentsInstructions => {
  const service = ctx.service(SERVICE_KEY);
  if (!(service instanceof AgentsInstructions)) {
    throw new Error("agents instruction service is unavailable");
  }
  return service;
};

/** Host-global and hierarchical project guidance, independently of agent role prompts. */
export function createAgentsPlugin(home: string): Plugin {
  const service: ServiceProvider = {
    key: SERVICE_KEY,
    scope: "workspace",
    for: (conversation) => new AgentsInstructions(home, conversation.workspaceRoot),
  };
  return {
    id: "agents",
    services: () => [service],
    async contextItems(ctx, boundary) {
      const targets =
        boundary.type === "tools"
          ? boundary.calls
              .map((call) => ({ call, paths: fileTargetsOfValidatedCall(call) }))
              .filter(({ paths }) => paths.length)
          : [];
      if (boundary.type === "tools" && !targets.length) return [];
      const { home, workspace } = await instructionsOf(ctx).roots();
      const directories = new Set<string>();
      if (boundary.type === "tools") {
        if (!workspace) return [];
        for (const { call, paths } of targets) {
          const outside = executionServiceOf(ctx).classify(call) !== "in-workspace";
          for (const directory of await forTargets(workspace, paths, outside))
            directories.add(directory);
        }
      } else {
        directories.add(home);
        if (workspace) for (const dir of ancestorDirectories(workspace)) directories.add(dir);
      }
      const known = new Map<string, { path: string; digest: string }>();
      for (const item of await ctx.active()) {
        if (item.type !== "plugin_data" || item.plugin !== "agents") continue;
        const { path, digest } = item.data as { path: string; digest: string | null };
        if (digest === null) known.delete(canonicalKey(path));
        else known.set(canonicalKey(path), { path, digest });
      }
      const output: PluginContextItem[] = [];
      const notice = (path: string, digest: string | null, text: string) => {
        output.push(
          { type: "context", key: canonicalKey(path), content: [{ type: "text", text }] },
          { type: "plugin_data", data: { path, digest } },
        );
      };
      const checked = new Set<string>();
      for (const directory of directories) {
        const file = await readInstruction(directory);
        const path = file?.path ?? resolve(directory, INSTRUCTION_FILE);
        const key = canonicalKey(path);
        if (checked.has(key)) continue;
        checked.add(key);
        const digest = file ? createHash("sha256").update(file.content).digest("hex") : null;
        if ((known.get(key)?.digest ?? null) === digest) continue;
        notice(
          path,
          digest,
          file
            ? renderInstruction(file, canonicalKey(directory) === canonicalKey(home))
            : `AGENTS.md removed: ${path}. Its earlier instructions no longer apply.`,
        );
      }
      if (boundary.type === "workspace") {
        for (const [key, { path }] of known)
          if (!checked.has(key) && !(workspace && isWithin(workspace, path)))
            notice(
              path,
              null,
              `AGENTS.md left workspace scope: ${path}. Its earlier instructions no longer apply.`,
            );
      }
      return output;
    },
  };
}
