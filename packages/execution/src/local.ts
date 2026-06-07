import { exec } from "node:child_process";
import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ByteRange, Conversation, ToolCall } from "@harness/protocol";
import type { ExecOptions, ExecResult, ExecutionContext, Relationship } from "./context.ts";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

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

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const abs = this.#resolve(path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  }

  async list(pattern: string): Promise<string[]> {
    if (!this.workspaceRoot) throw new Error("list requires a workspace");
    const out: string[] = [];
    for await (const entry of glob(pattern, { cwd: this.workspaceRoot })) out.push(entry);
    return out.sort();
  }

  run(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = this.workspaceRoot ?? process.cwd();
    return new Promise<ExecResult>((resolvePromise, reject) => {
      exec(
        command,
        { cwd, signal: opts.signal, maxBuffer: MAX_OUTPUT_BYTES },
        (error: (Error & { code?: string | number }) | null, stdout, stderr) => {
          if (error?.code === "ABORT_ERR") {
            reject(error);
            return;
          }
          const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
          resolvePromise({ stdout, stderr, exitCode });
        },
      );
    });
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

/** One local context per conversation, rooted at its resolved workspace. */
export class LocalExecutionProvider {
  for(conversation: Conversation): ExecutionContext {
    return new LocalExecutionContext(conversation.config.workspaceRoot ?? null);
  }
}
