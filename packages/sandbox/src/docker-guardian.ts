import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { captureText } from "./docker-cli.ts";

const IMAGE = "node:24.21.0-alpine";

/** Runs inside the guardian, independently of the server and its Docker CLI process. */
export const GUARDIAN_SOURCE = String.raw`
const http = require('node:http');
const scope = process.env.HARNESS_SCOPE;
const socketPath = '/var/run/docker.sock';
let stopping = false;
let retiring = false;
let sweeping = Promise.resolve();
const pending = new Set();
const owned = labels => labels?.['harness.server'] === scope ||
  labels?.['com.docker.compose.project']?.startsWith('harness_' + scope + '_');
function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({socketPath, method, path}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300 || res.statusCode === 304 || res.statusCode === 404) resolve(body);
        else reject(new Error('Docker API ' + method + ' ' + path.split('?')[0] + ': HTTP ' + res.statusCode));
      });
    });
    req.on('error', reject); req.end();
  });
}
function stop(id) {
  if (retiring) return;
  const operation = request('POST', '/containers/' + encodeURIComponent(id) + '/stop?t=10');
  pending.add(operation);
  operation.then(() => pending.delete(operation), fail);
}
function fail(error) { console.error(error.message); process.exit(1); }
async function sweep() {
  const rows = JSON.parse(await request('GET', '/containers/json'));
  for (const row of rows) if (owned(row.Labels)) stop(row.Id);
  await Promise.all([...pending]);
}
let stream;
async function retire() {
  retiring = true;
  stream?.destroy();
  try { await sweeping; await Promise.all([...pending]); process.exit(0); } catch (error) { fail(error); }
}
process.on('SIGTERM', retire);
process.on('SIGINT', retire);
process.stdin.resume();
process.stdin.on('end', () => { stopping = true; sweeping = sweep(); sweeping.then(() => console.log('STOPPED'), fail); });
(async () => {
  const info = JSON.parse(await request('GET', '/info'));
  stream = http.get({socketPath, path: '/events?filters=' + encodeURIComponent(JSON.stringify({type:['container'],event:['start']}))}, res => {
    if (res.statusCode !== 200) return fail(new Error('Docker events HTTP ' + res.statusCode));
    let buffered = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (stopping && owned(event.Actor?.Attributes)) stop(event.Actor.ID);
      }
    });
    res.on('end', () => { if (!retiring) fail(new Error('Docker events stream closed')); });
    res.on('error', error => { if (!retiring) fail(error); });
    console.log('READY ' + info.ID);
  });
  stream.on('error', error => { if (!retiring) fail(error); });
})().catch(fail);
`;

export class DockerGuardian {
  readonly scope: string;
  readonly #name: string;
  #child: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<void> | undefined;
  #failure: Error | undefined;
  #closing = false;
  #closed: Promise<void> | undefined;

  constructor(
    home: string,
    private readonly onFailure?: (error: Error) => void,
  ) {
    this.scope = createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16);
    this.#name = `harness_guardian_${this.scope}_${randomUUID().slice(0, 8)}`;
  }

  ensure(): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    this.#starting ??= this.#start().catch(async (error: unknown) => {
      this.#closing = true;
      const ids = (await checked(["ps", "-aq", "--filter", `name=^/${this.#name}$`])).trim();
      if (ids) await checked(["rm", "-f", ids]);
      this.#child?.kill();
      throw error;
    });
    return this.#starting;
  }

  get started(): boolean {
    return this.#starting !== undefined;
  }

  async #start(): Promise<void> {
    const info = await checked(["info", "--format", "{{json .}}"]);
    const daemon = JSON.parse(info) as { ID: string; OperatingSystem: string };
    const context = process.env["DOCKER_CONTEXT"];
    const endpoint =
      !context && process.env["DOCKER_HOST"]
        ? process.env["DOCKER_HOST"]
        : (
            await checked([
              "context",
              "inspect",
              ...(context ? [context] : []),
              "--format",
              "{{.Endpoints.docker.Host}}",
            ])
          ).trim();
    let socket: string;
    if (daemon.OperatingSystem === "Docker Desktop")
      socket = process.platform === "win32" ? "//var/run/docker.sock" : "/var/run/docker.sock";
    else if (endpoint.startsWith("unix://")) socket = endpoint.slice(7);
    else
      throw new Error("Docker crash cleanup requires a local Unix socket or Docker Desktop daemon");
    const old = (await checked(["ps", "-aq", "--filter", `label=harness.guardian=${this.scope}`]))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--name",
        this.#name,
        "--label",
        `harness.guardian=${this.scope}`,
        "--env",
        `HARNESS_SCOPE=${this.scope}`,
        "--mount",
        `type=bind,source=${socket},target=/var/run/docker.sock`,
        IMAGE,
        "node",
        "-e",
        GUARDIAN_SOURCE,
      ],
      { windowsHide: true },
    );
    this.#child = child;
    await new Promise<void>((resolveReady, reject) => {
      let output = "";
      let errors = "";
      let ready = false;
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-4096);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        const line = output
          .split("\n")
          .slice(0, -1)
          .find((line) => line.startsWith("READY "));
        if (!line || ready) return;
        if (line.slice(6) !== daemon.ID) {
          reject(new Error("Docker guardian connected to a different daemon"));
          return;
        }
        ready = true;
        resolveReady();
      });
      child.on("error", (error) => {
        this.#failure = error;
        if (!ready) reject(error);
        else if (!this.#closing) this.onFailure?.(error);
      });
      child.on("close", (code) => {
        if (this.#closing) return;
        this.#failure = new Error(`Docker guardian exited (${code}): ${errors.trim()}`);
        if (!ready) reject(this.#failure);
        else this.onFailure?.(this.#failure);
      });
    });
    // The new subscriber covers this server home before the old stop guardian retires.
    if (old.length) {
      await checked(["stop", "--timeout", "30", ...old]);
    }
  }

  /** Stop owned containers and wait; keep the guardian until all stop requests settle. */
  close(): Promise<void> {
    this.#closed ??= this.#close();
    return this.#closed;
  }

  async #close(): Promise<void> {
    if (!this.#starting) return;
    await this.#starting;
    if (this.#failure) throw this.#failure;
    this.#closing = true;
    const child = this.#child;
    if (!child) throw new Error("Docker guardian is missing");
    await new Promise<void>((resolveStopped, reject) => {
      let output = "";
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("STOPPED\n")) {
          child.stdout.off("data", onData);
          resolveStopped();
        }
      };
      child.stdout.on("data", onData);
      child.once("close", () =>
        reject(new Error("Docker guardian closed before stopping workspaces")),
      );
      child.stdin.end();
    });
    await checked(["stop", "--timeout", "30", this.#name]);
    this.#child = undefined;
  }
}

async function checked(args: string[]): Promise<string> {
  const result = await captureText("docker", args);
  if (result.exitCode) throw new Error(`Docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}
