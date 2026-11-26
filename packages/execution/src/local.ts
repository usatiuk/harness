import { createWriteStream, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { finished } from "node:stream/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, open, readdir, readFile, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { matchGlob, mayDescend } from "./glob.ts";
import type { ByteRange, ToolCall } from "@harness/protocol";
import type {
  ExecutionContext,
  OutputStore,
  OutputWriter,
  Relationship,
  SpawnedProcess,
  ShellKind,
} from "./context.ts";
import { streamProcess } from "./spawn.ts";
import {
  powerShellCommandArgs,
  selectUserShell,
  shellCommandArgs,
  type UserShellEnvironment,
} from "./shell.ts";
import { killWindowsProcessTree } from "./windows-process.ts";

/** The call's target path: the `path` arg if present and a string, else undefined. */
function callPath(call: ToolCall): string | undefined {
  const args = call.args;
  if (args && typeof args === "object" && "path" in args) {
    const p: unknown = args.path;
    if (typeof p === "string") return p;
  }
  return undefined;
}

/** Filesystem operations use the calling process's permissions. */
export class LocalFileOperations {
  constructor(readonly workspaceRoot: string | null) {}

  async prepare(): Promise<void> {
    if (this.workspaceRoot && !(await fsStat(this.workspaceRoot)).isDirectory())
      throw new Error(`Workspace is not a directory: ${this.workspaceRoot}`);
  }

  async read(path: string, range?: ByteRange): Promise<Uint8Array> {
    if (!range) return readFile(this.#resolve(path));
    const file = await open(this.#resolve(path), "r");
    try {
      const buffer = Buffer.alloc(range.length);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          range.offset + length,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return buffer.subarray(0, length);
    } finally {
      await file.close();
    }
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
    await this.prepare();
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

  #resolve(path: string): string {
    return resolve(this.workspaceRoot ?? process.cwd(), path);
  }
}

/** Host execution with no sandbox. Classification supplies the approval boundary. */
export class LocalExecutionContext extends LocalFileOperations implements ExecutionContext {
  readonly shellKind: ShellKind;

  constructor(
    workspaceRoot: string | null,
    readonly commandShell: UserShellEnvironment | undefined = process.platform === "win32"
      ? undefined
      : selectUserShell(),
  ) {
    super(workspaceRoot);
    this.shellKind = commandShell?.kind ?? "powershell";
  }

  spawn(command: string): SpawnedProcess {
    const cwd = this.workspaceRoot ?? process.cwd();
    const windows = process.platform === "win32";
    const child = windows
      ? nodeSpawn("powershell.exe", powerShellCommandArgs(command), { cwd, windowsHide: true })
      : nodeSpawn(
          this.commandShell!.executable,
          shellCommandArgs(this.commandShell!.kind, command),
          {
            cwd,
            detached: true,
            env: this.commandShell!.env,
          },
        );
    let killed = false;
    let settled = false;
    child.once("exit", () => (settled = true));
    child.once("error", () => (settled = true));
    const kill = (): void => {
      if (killed || settled || child.pid === undefined) return;
      killed = true;
      if (windows) {
        killWindowsProcessTree(child);
        return;
      }
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
    if (!root || path === undefined) return "unknown";
    const rel = relative(root, resolve(root, path));
    const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    return inside ? "in-workspace" : "out-of-workspace";
  }
}

/**
 * Spills output to real files under `<root>/.harness/<conversationId>/outputs/<id>.log`, so the
 * model's workspace file tools reach them and the path is a durable breadcrumb in the log. The
 * `.harness` dir is auto-gitignored on first use.
 */
export class LocalOutputStore implements OutputStore {
  constructor(
    private readonly workspaceRoot: string | null,
    private readonly conversationId: string,
  ) {}

  #artifactPath(id: string): string {
    for (const part of [this.conversationId, id]) {
      if (
        !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      )
        throw new Error("Invalid output path identifier");
    }
    // Trust the selected workspace (which may itself be a junction or UNC path), not links
    // below it. Path-based checks cannot protect against concurrent replacement of directories.
    const harness = join(resolve(this.workspaceRoot ?? process.cwd()), ".harness");
    const conversation = join(harness, this.conversationId);
    const outputs = join(conversation, "outputs");
    for (const dir of [harness, conversation, outputs]) {
      try {
        mkdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!lstatSync(dir).isDirectory())
          throw new Error(`Unsafe output directory: ${dir}`, { cause: error });
      }
    }
    const marker = join(harness, ".gitignore");
    try {
      writeFileSync(marker, "*\n", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(marker).isFile())
        throw new Error(`Unsafe output marker: ${marker}`, { cause: error });
    }
    return join(outputs, `${id}.log`);
  }

  open(id: string): OutputWriter {
    const path = this.#artifactPath(id);
    const stream = createWriteStream(path, { flags: "wx" });
    // Swallow stream errors (disk full, permission): an unhandled `error` event would crash the
    // process, and the in-memory view already carries the outcome.
    stream.on("error", () => {});
    return {
      path,
      write: (chunk, flushed) => void stream.write(chunk, flushed),
      close: async (footer) => {
        if (footer) stream.write(footer);
        stream.end();
        await finished(stream);
      },
    };
  }

  async put(id: string, text: string): Promise<string> {
    const path = this.#artifactPath(id);
    await writeFile(path, text, { flag: "wx" });
    return path;
  }
}
