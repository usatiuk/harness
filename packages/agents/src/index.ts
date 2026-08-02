import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import {
  type ContentBlock,
  type ContextSource,
  type Plugin,
  type ServiceProvider,
  type ToolMiddleware,
  type ToolMiddlewareContext,
  errorResult,
} from "@harness/protocol";
import { executionOf } from "@harness/execution";
import { fileTargetsOfValidatedCall } from "@harness/workspace";

const SERVICE_KEY = "agents-instructions";
const CONTEXT_KEY_PREFIX = "agents-md:";
const INSTRUCTION_FILE = "AGENTS.md";

interface InstructionFile {
  key: string;
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
  return { key: canonicalKey(path), path, content: await readFile(path, "utf8") };
};

const discoverFrom = async (directory: string): Promise<InstructionFile[]> => {
  const found = await Promise.all(ancestorDirectories(directory).map(readInstruction));
  return found.filter((file): file is InstructionFile => file !== undefined);
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

const renderInstruction = (file: InstructionFile): string =>
  [
    `AGENTS.md instructions from ${file.path}`,
    `Scope: ${dirname(file.path)} and its descendants. Deeper AGENTS.md files take precedence.`,
    "",
    file.content,
  ].join("\n");

/** Per-conversation host-path discovery and the one runtime-local initial-prefix snapshot. */
class AgentsInstructions {
  readonly #workspaceRoot: string | null;
  #initial: Promise<InstructionFile[]> | undefined;

  constructor(workspaceRoot: string | null) {
    this.#workspaceRoot = workspaceRoot === null ? null : resolve(workspaceRoot);
  }

  initial(): Promise<InstructionFile[]> {
    if (this.#initial) return this.#initial;
    const pending =
      this.#workspaceRoot === null
        ? Promise.resolve([])
        : realpath(this.#workspaceRoot).then(discoverFrom);
    this.#initial = pending;
    void pending.catch(() => {
      if (this.#initial === pending) this.#initial = undefined;
    });
    return pending;
  }

  async forTargets(paths: readonly string[], allowOutside: boolean): Promise<InstructionFile[]> {
    const root = this.#workspaceRoot;
    if (root === null) return [];
    const canonicalRoot = await realpath(root);
    const byKey = new Map<string, InstructionFile>();
    for (const path of paths) {
      const target = resolve(root, path);
      const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const directory = info?.isDirectory() ? target : dirname(target);
      const canonicalDirectory = await nearestExistingRealPath(directory);
      if (!allowOutside && !isWithin(canonicalRoot, canonicalDirectory)) continue;
      for (const file of await discoverFrom(canonicalDirectory)) byKey.set(file.key, file);
    }
    return [...byKey.values()];
  }
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

const source: ContextSource = {
  id: "agents-initial",
  async instructions(ctx): Promise<ContentBlock[]> {
    return (await instructionsOf(ctx).initial()).map((file) => ({
      type: "text",
      text: `\n\n${renderInstruction(file)}`,
    }));
  },
};

const middleware: ToolMiddleware = {
  id: "agents-nested",
  async wrap(call, ctx: ToolMiddlewareContext, next) {
    if (!ctx.acceptsToolCall(call)) return next(call);
    const targets = fileTargetsOfValidatedCall(call);
    if (targets.length === 0) return next(call);

    const instructions = instructionsOf(ctx);
    // Confined/container tools can name a host-relative path outside cwd without permission to
    // read that host location. Only an approval-classified escape may discover it on the host.
    const relationship = executionOf(ctx).classify(call);

    const initial = await instructions.initial();
    if (ctx.signal.aborted) return errorResult("interrupted: turn aborted");
    const loadedKeys = new Set(initial.map((file) => file.key));
    for (const item of await ctx.active()) {
      if (item.type === "context" && item.key.startsWith(CONTEXT_KEY_PREFIX)) {
        loadedKeys.add(item.key);
      }
    }
    if (ctx.signal.aborted) return errorResult("interrupted: turn aborted");

    const files = await instructions.forTargets(targets, relationship !== "in-workspace");
    if (ctx.signal.aborted) return errorResult("interrupted: turn aborted");
    for (const file of files) {
      if (loadedKeys.has(file.key)) continue;
      if (ctx.signal.aborted) return errorResult("interrupted: turn aborted");
      await ctx.appendContext(file.key, [{ type: "text", text: renderInstruction(file) }]);
      loadedKeys.add(file.key);
    }
    if (ctx.signal.aborted) return errorResult("interrupted: turn aborted");
    return next(call);
  },
};

const service: ServiceProvider = {
  key: SERVICE_KEY,
  for: (conversation) => new AgentsInstructions(conversation.workspaceRoot),
};

/** Hierarchical project instructions, independent from providers and the tools they annotate. */
export const agentsPlugin: Plugin = {
  id: "agents",
  toolMiddlewareAfter: ["approval"],
  services: () => [service],
  contextSources: () => [source],
  toolMiddleware: () => [middleware],
};
