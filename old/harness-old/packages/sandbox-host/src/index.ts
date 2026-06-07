import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExecutionContextRecord } from "@harness/protocol";
import type { ActiveProcess, ExecutionCommandInput, ExecutionCommandOutput, ExecutionOutputSinks, ExecutionProvider, ExecutionRuntime } from "@harness/core";

export const SOURCE_FIRST_MARKER = "sandbox-host:src";

export interface HostExecutionProviderOptions {
  baseEnv?: Record<string, string | undefined>;
}

export class HostExecutionProvider implements ExecutionProvider {
  public readonly kind = "host";

  public constructor(private readonly options: HostExecutionProviderOptions = {}) {}

  public async resolve(context: ExecutionContextRecord): Promise<ExecutionRuntime> {
    return new HostExecutionRuntime(context, this.options);
  }
}

export function createHostExecutionProvider(options: HostExecutionProviderOptions = {}): HostExecutionProvider {
  return new HostExecutionProvider(options);
}

class HostExecutionRuntime implements ExecutionRuntime {
  private rootPathPromise: Promise<string> | undefined;

  public constructor(public readonly context: ExecutionContextRecord, private readonly options: HostExecutionProviderOptions) {}

  public async readFile(filePath: string): Promise<{
    kind: "text" | "binary";
    text?: string;
    uri?: string;
    mimeType: string;
    byteSize: number;
    sha256?: string;
  }> {
    const resolved = await this.resolveExistingPath(filePath);
    const root = await this.rootPath();
    const handle = await fs.open(resolved, fsConstants.O_RDONLY | noFollowFlag());
    let buffer: Buffer;
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        throw new Error(`Refusing to read non-regular file ${filePath}`);
      }
      const resolvedAfterOpen = await fs.realpath(resolved);
      assertInsideRoot(root, resolvedAfterOpen, filePath);
      const pathStat = await fs.stat(resolvedAfterOpen);
      if (pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino) {
        throw new Error(`Readable path changed while opening ${filePath}`);
      }
      buffer = await handle.readFile();
    } finally {
      await handle.close();
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const mimeType = detectMimeType(resolved, buffer);
    if (isProbablyText(buffer)) {
      return {
        kind: "text",
        text: buffer.toString("utf8"),
        mimeType,
        byteSize: buffer.byteLength,
        sha256
      };
    }
    return {
      kind: "binary",
      uri: `file://${resolved}`,
      mimeType,
      byteSize: buffer.byteLength,
      sha256
    };
  }

  public async writeFile(filePath: string, content: string): Promise<void> {
    const resolved = await this.resolveWritablePath(filePath);
    const root = await this.rootPath();
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollowFlag() | nonblockFlag();
    const handle = await fs.open(resolved, flags, 0o666);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(`Refusing to write through non-regular file ${filePath}`);
      }
      const resolvedAfterOpen = await fs.realpath(resolved);
      assertInsideRoot(root, resolvedAfterOpen, filePath);
      const pathStat = await fs.stat(resolvedAfterOpen);
      if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
        throw new Error(`Writable path changed while opening ${filePath}`);
      }
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
  }

  public async listFiles(filePath: string): Promise<Array<{ path: string; kind: "file" | "directory"; byteSize?: number }>> {
    const resolved = await this.resolveExistingPath(filePath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const rows: Array<{ path: string; kind: "file" | "directory"; byteSize?: number }> = [];
    for (const entry of entries) {
      const child = path.join(resolved, entry.name);
      if (entry.isDirectory()) {
        rows.push({ path: await this.toContextRelative(child), kind: "directory" });
      } else if (entry.isFile()) {
        const stat = await fs.stat(child);
        rows.push({ path: await this.toContextRelative(child), kind: "file", byteSize: stat.size });
      }
    }
    return rows;
  }

  public async grep(input: { pattern: string; path?: string; limit?: number }): Promise<Array<{ path: string; line: number; text: string }>> {
    const root = await this.resolveExistingPath(input.path ?? ".");
    const results: Array<{ path: string; line: number; text: string }> = [];
    const limit = input.limit ?? 50;
    await this.grepPath(root, input.pattern, results, limit);
    return results;
  }

  public async runCommand(input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ExecutionCommandOutput> {
    const cwd = input.cwd ? await this.resolveExistingPath(input.cwd) : await this.rootPath();
    const env = this.commandEnv(input.env);
    return new Promise<ExecutionCommandOutput>((resolve, reject) => {
      const child = spawn(input.command, {
        cwd,
        env,
        shell: true
      });
      let writeChain = Promise.resolve();
      child.stdout.on("data", (chunk: Buffer) => {
        writeChain = writeChain.then(() => sinks.stdout(chunk.toString("utf8")));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        writeChain = writeChain.then(() => sinks.stderr(chunk.toString("utf8")));
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        writeChain
          .then(() => resolve(signal ? { exitCode: code ?? 0, signal } : { exitCode: code ?? 0 }))
          .catch(reject);
      });
    });
  }

  public async startCommand(input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ActiveProcess> {
    const cwd = input.cwd ? await this.resolveExistingPath(input.cwd) : await this.rootPath();
    const env = this.commandEnv(input.env);
    const child = spawn(input.command, {
      cwd,
      env,
      shell: true,
      detached: true
    });
    const pid = child.pid;
    let writeChain = Promise.resolve();
    child.stdout.on("data", (chunk: Buffer) => {
      writeChain = writeChain.then(() => sinks.stdout(chunk.toString("utf8")));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      writeChain = writeChain.then(() => sinks.stderr(chunk.toString("utf8")));
    });
    const waitPromise = new Promise<ExecutionCommandOutput>((resolve, reject) => {
      child.on("error", (err) => {
        reject(err);
      });
      child.on("close", (code, signal) => {
        writeChain
          .then(() => resolve(signal ? { exitCode: code ?? 0, signal } : { exitCode: code ?? 0 }))
          .catch(reject);
      });
    });

    return {
      ...(pid !== undefined ? { pid } : {}),
      wait: () => waitPromise,
      cancel: async () => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid);
          } catch {
            try {
              child.kill();
            } catch {
              // Process already exited.
            }
          }
        } else {
          try {
            child.kill();
          } catch {
            // Process already exited.
          }
        }
        try {
          await waitPromise;
        } catch {
          // ignore error since it was cancelled
        }
      }
    };
  }

  private async grepPath(root: string, pattern: string, results: Array<{ path: string; line: number; text: string }>, limit: number): Promise<void> {
    if (results.length >= limit) {
      return;
    }
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink()) {
      return;
    }
    const canonicalRoot = await this.rootPath();
    const resolved = await fs.realpath(root);
    assertInsideRoot(canonicalRoot, resolved, root);
    if (stat.isDirectory()) {
      const basename = path.basename(resolved);
      if (basename === ".git" || basename === "node_modules" || basename === "dist") {
        return;
      }
      const entries = await fs.readdir(resolved);
      for (const entry of entries) {
        await this.grepPath(path.join(resolved, entry), pattern, results, limit);
        if (results.length >= limit) {
          return;
        }
      }
      return;
    }
    if (!stat.isFile()) {
      return;
    }
    const handle = await fs.open(resolved, fsConstants.O_RDONLY | noFollowFlag());
    let buffer: Buffer;
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        return;
      }
      buffer = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (!isProbablyText(buffer)) {
      return;
    }
    const lines = buffer.toString("utf8").split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (line.includes(pattern)) {
        results.push({ path: await this.toContextRelative(resolved), line: index + 1, text: line });
        if (results.length >= limit) {
          return;
        }
      }
    }
  }

  private async rootPath(): Promise<string> {
    if (!this.context.cwd) {
      throw new Error("Host execution context requires cwd");
    }
    this.rootPathPromise ??= canonicalDirectory(this.context.cwd);
    return this.rootPathPromise;
  }

  private async resolveExistingPath(filePath: string): Promise<string> {
    const { root, candidate } = await this.resolveLexicalPath(filePath);
    const resolved = await fs.realpath(candidate);
    assertInsideRoot(root, resolved, filePath);
    return resolved;
  }

  private async resolveWritablePath(filePath: string): Promise<string> {
    const { root, candidate } = await this.resolveLexicalPath(filePath);
    const parent = await this.ensureWritableParent(root, path.dirname(candidate));
    const resolved = path.join(parent, path.basename(candidate));
    try {
      const existing = await fs.lstat(resolved);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`Refusing to write through non-file path ${filePath}`);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    assertInsideRoot(root, resolved, filePath);
    return resolved;
  }

  private async resolveLexicalPath(filePath: string): Promise<{ root: string; candidate: string }> {
    if (path.isAbsolute(filePath)) {
      throw new Error(`Absolute paths are not allowed in host execution context: ${filePath}`);
    }
    const root = await this.rootPath();
    const candidate = path.resolve(root, filePath);
    assertInsideRoot(root, candidate, filePath);
    return { root, candidate };
  }

  private async ensureWritableParent(root: string, parentPath: string): Promise<string> {
    assertInsideRoot(root, parentPath, parentPath);
    const relative = path.relative(root, parentPath);
    let current = root;
    if (relative.length === 0) {
      return current;
    }
    for (const part of relative.split(path.sep).filter((item) => item.length > 0)) {
      const next = path.join(current, part);
      try {
        const stat = await fs.lstat(next);
        if (stat.isSymbolicLink()) {
          throw new Error(`Refusing to write through symlink path ${next}`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`Writable parent component is not a directory: ${next}`);
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
        await fs.mkdir(next);
      }
      current = next;
    }
    return current;
  }

  private async toContextRelative(filePath: string): Promise<string> {
    const cwd = await this.rootPath();
    const relative = path.relative(cwd, filePath);
    return relative.length === 0 ? "." : relative;
  }

  private commandEnv(inputEnv: Record<string, string> | undefined): Record<string, string> {
    return compactEnv({
      ...process.env,
      ...this.options.baseEnv,
      ...this.context.env,
      ...inputEnv
    });
  }
}

function detectMimeType(filePath: string, buffer: Buffer): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  if (ext === ".pdf") {
    return "application/pdf";
  }
  if (isProbablyText(buffer)) {
    return "text/plain";
  }
  return "application/octet-stream";
}

function assertInsideRoot(root: string, filePath: string, originalPath: string): void {
  const relative = path.relative(root, filePath);
  if (relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`Path escapes host execution root: ${originalPath}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function canonicalDirectory(filePath: string): Promise<string> {
  const resolved = await fs.realpath(filePath);
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Host execution cwd is not a directory: ${filePath}`);
  }
  return resolved;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

function nonblockFlag(): number {
  return typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
}

function compactEnv(input: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function isProbablyText(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return false;
  }
  const text = buffer.toString("utf8");
  return Buffer.from(text, "utf8").equals(buffer);
}
