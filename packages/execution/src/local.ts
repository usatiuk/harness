import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { matchGlob, mayDescend } from "./glob.ts";
import type { ByteRange, ToolCall } from "@harness/protocol";
import type {
  ExecutionContext,
  OutputStore,
  OutputWriter,
  Relationship,
  SpawnedProcess,
} from "./context.ts";
import { streamProcess } from "./spawn.ts";

/** The call's target path: the `path` arg if present and a string, else undefined. */
function callPath(call: ToolCall): string | undefined {
  const args = call.args;
  if (args && typeof args === "object" && "path" in args) {
    const p: unknown = args.path;
    if (typeof p === "string") return p;
  }
  return undefined;
}

/**
 * Local IO with NO path enforcement — it can read and write anywhere. In v0 it is
 * the substrate seam and supplies `classify` for approval to gate; a real OS sandbox
 * adds enforcement behind the same interface. Commands run with `cwd = workspaceRoot`.
 */
export class LocalExecutionContext implements ExecutionContext {
  constructor(readonly workspaceRoot: string | null) {}

  async read(path: string, range?: ByteRange): Promise<Uint8Array> {
    const buf = await readFile(this.#resolve(path));
    return range ? buf.subarray(range.offset, range.offset + range.length) : buf;
  }

  async stat(path: string): Promise<{ isDirectory: boolean } | undefined> {
    try {
      return { isDirectory: (await fsStat(this.#resolve(path))).isDirectory() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const abs = this.#resolve(path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  }

  async remove(path: string): Promise<void> {
    await rm(this.#resolve(path));
  }

  async list(pattern: string): Promise<string[]> {
    const root = this.workspaceRoot;
    if (!root) throw new Error("list requires a workspace");
    // Enumerate workspace-relative paths, pruning subtrees that can't match, then filter through the
    // shared matcher — the same one the docker backend uses, so glob semantics have one source.
    const paths: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(rel ? resolve(root, rel) : root, { withFileTypes: true });
      } catch (error) {
        // The workspace root must be listable; an unreadable nested dir is skipped, not fatal —
        // matching node-glob, which yields what it can rather than throwing on one bad subtree.
        if (rel === "") throw error;
        return;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        paths.push(childRel);
        if (entry.isDirectory() && mayDescend(childRel, pattern)) await walk(childRel);
      }
    };
    await walk("");
    return matchGlob(paths, pattern);
  }

  spawn(command: string): SpawnedProcess {
    const cwd = this.workspaceRoot ?? process.cwd();
    // Own process group so `kill(-pid)` reaps the whole tree, not just the shell.
    const child = nodeSpawn(command, { cwd, shell: true, detached: true });
    let killed = false;
    const kill = (): void => {
      if (killed || child.pid === undefined) return;
      killed = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, 5000).unref();
    };
    return streamProcess(child, kill);
  }

  outputStore(conversationId: string): OutputStore {
    return new LocalOutputStore(this.workspaceRoot, conversationId);
  }

  classify(call: ToolCall): Relationship {
    const root = this.workspaceRoot;
    const path = callPath(call);
    if (!root || path === undefined) return "out-of-workspace";
    const rel = relative(root, resolve(root, path));
    const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    return inside ? "in-workspace" : "out-of-workspace";
  }

  #resolve(path: string): string {
    return resolve(this.workspaceRoot ?? process.cwd(), path);
  }
}

/**
 * Spills output to real files under `<root>/.harness/<conversationId>/outputs/<id>.log`, so the
 * model's `Read`/`Grep` reach them and the path is a durable breadcrumb in the log. The
 * `.harness` dir is auto-gitignored on first use.
 */
export class LocalOutputStore implements OutputStore {
  constructor(
    private readonly workspaceRoot: string | null,
    private readonly conversationId: string,
  ) {}

  #root(): string {
    return this.workspaceRoot ?? process.cwd();
  }

  #rel(id: string): string {
    return join(".harness", this.conversationId, "outputs", `${id}.log`);
  }

  #ensureDir(): void {
    const root = this.#root();
    mkdirSync(join(root, ".harness", this.conversationId, "outputs"), { recursive: true });
    try {
      writeFileSync(join(root, ".harness", ".gitignore"), "*\n");
    } catch {
      // best-effort; a missing .gitignore doesn't break output capture
    }
  }

  open(id: string): OutputWriter {
    this.#ensureDir();
    const rel = this.#rel(id);
    const stream = createWriteStream(resolve(this.#root(), rel), { flags: "w" });
    // Swallow stream errors (disk full, permission): an unhandled `error` event would crash the
    // process, and the in-memory view already carries the outcome.
    stream.on("error", () => {});
    return {
      path: rel,
      write: (chunk) => void stream.write(chunk),
      close: async (footer) => {
        if (footer) stream.write(footer);
        await new Promise<void>((res) => stream.end(res));
      },
    };
  }

  async put(id: string, text: string): Promise<string> {
    this.#ensureDir();
    const rel = this.#rel(id);
    await writeFile(resolve(this.#root(), rel), text);
    return rel;
  }
}
