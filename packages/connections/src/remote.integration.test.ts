import { cp, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { HarnessClient } from "@harness/client";
import { expect, it, vi } from "vitest";
import { discoverySchema } from "./local.ts";
import { stopRemoteServer } from "./commands.ts";
import { serverInfoRequest, serverStopRequest } from "./contracts.ts";
import {
  connectRemote,
  prepareRemoteRuntime,
  runRemote,
  shellQuote,
  type RemoteHost,
  type PreparedRuntime,
  type RemoteOptions,
} from "./remote.ts";

async function checkBlockedCancellation(
  host: RemoteHost,
  payload: string,
  runtime: PreparedRuntime,
  options: RemoteOptions,
): Promise<void> {
  const metadata = JSON.parse(await readFile(join(payload, "remote.json"), "utf8")) as {
    server: { sha256: string };
  };
  const q = shellQuote;
  const gate = `${runtime.home}/.cache-locks/install`;
  const ready = `${runtime.home}/cancel-lock-ready`;
  const scan = `const fs=require('node:fs');const home=${JSON.stringify(runtime.home)};const found=[];for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0');if(args.includes('--install-development-server')&&env.includes('HARNESS_HOME='+home))found.push({pid:Number(pid),wait:fs.readFileSync('/proc/'+pid+'/wchan','utf8')});}catch(e){if(!['ENOENT','EACCES','ESRCH'].includes(e.code))throw e;}}process.stdout.write(JSON.stringify(found));`;
  const holder = runRemote(
    host,
    `umask 077; exec flock -F -x ${q(gate)} sh -c ${q(`echo $$ > ${q(ready)}; exec sleep 600`)}`,
    options,
  );
  let holderFailure: Error | undefined;
  void holder.catch((error: unknown) => {
    holderFailure =
      error instanceof Error ? error : new Error("Fixture lock holder failed", { cause: error });
  });
  const controller = new AbortController();
  let helperPid: number | undefined;
  let attempt: Promise<PreparedRuntime> | undefined;
  try {
    await vi.waitFor(
      async () => {
        if (holderFailure) throw holderFailure;
        expect(await runRemote(host, `test -s ${q(ready)} && printf ready`, options)).toBe("ready");
      },
      { timeout: 10_000 },
    );
    // A complete cached bridge can start while an installer holds this gate.
    // It uses shared lifetime protection and never waits for an installation.
    const cachedBridge = await connectRemote(host, runtime, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });
    const cachedClient = new HarnessClient({
      connection: cachedBridge.connection,
      client: { name: "cached-under-install-gate", version: "1" },
    });
    try {
      await cachedClient.start();
      expect((await cachedClient.peer.request(serverInfoRequest, {})).buildId).toBe(
        runtime.buildId,
      );
    } finally {
      cachedClient.closeConnection();
      await cachedBridge.close();
    }
    attempt = prepareRemoteRuntime(host, payload, { ...options, signal: controller.signal });
    // Observe rejection immediately, even if the lock/readiness assertion fails.
    void attempt.catch(() => undefined);
    await vi.waitFor(
      async () => {
        const helpers = JSON.parse(
          await runRemote(host, `${q(runtime.node)} -e ${q(scan)}`, options),
        ) as { pid: number; wait: string }[];
        expect(helpers).toHaveLength(1);
        helperPid = helpers[0]!.pid;
        expect(helpers[0]!.wait).toMatch(/locks|flock/u);
      },
      { timeout: 120_000 },
    );
    controller.abort();
    await expect(attempt).rejects.toMatchObject({ name: "AbortError" });
    // Local transport exit alone does not establish target process retirement.
    expect(await runRemote(host, `${q(runtime.node)} -e ${q(scan)}`, options)).toBe("[]");
    expect(
      await runRemote(
        host,
        `test ! -e ${q(`${runtime.home}/server/dev-linux-x64-glibc-${metadata.server.sha256}`)} && test -z "$(ls -A ${q(`${runtime.home}/staging`)})" && printf clean`,
        options,
      ),
    ).toBe("clean");
  } finally {
    controller.abort();
    if (helperPid) await runRemote(host, `kill -KILL ${helperPid} 2>/dev/null || :`, options);
    await runRemote(
      host,
      `if test -f ${q(ready)}; then kill "$(cat ${q(ready)})" 2>/dev/null || :; rm ${q(ready)}; fi`,
      options,
    );
    await attempt?.catch(() => undefined);
    await holder.catch(() => undefined);
  }
}

const distribution = process.env["HARNESS_REMOTE_WSL"];
const sshConfig = process.env["HARNESS_REMOTE_SSH_CONFIG"];
for (const [destination, diagnostic] of [
  ["harness-password", /Permission denied/iu],
  ["harness-unknown", /Host key verification failed/iu],
] as const)
  it.skipIf(!sshConfig)(
    `fails non-interactively for ${destination}`,
    async () => {
      const host: RemoteHost = {
        kind: "ssh",
        id: destination,
        label: destination,
        destination,
      };
      const attempt = runRemote(host, "printf connected", {
        sshConfigFile: sshConfig!,
        signal: AbortSignal.timeout(10000),
      });
      await expect(attempt).rejects.toMatchObject({ code: 255 });
      await expect(attempt).rejects.toThrow(diagnostic);
    },
    15000,
  );
for (const kind of ["wsl", "ssh"] as const)
  it.skipIf(kind === "wsl" ? !distribution : !sshConfig)(
    `provisions complete payloads on real ${kind}, reuses the runtime and preserves a live owner`,
    async () => {
      const root = process.env["HARNESS_REMOTE_FIXTURE_HOME"];
      if (!root) throw new Error("Run npm run test:remote for an isolated remote environment");
      const common = {
        id: "fixture",
        label: `${kind} fixture`,
      };
      const host: RemoteHost =
        kind === "wsl"
          ? { ...common, kind, distribution: distribution!, user: null }
          : {
              ...common,
              kind,
              destination: "harness-fixture",
            };
      const options = { ...(kind === "ssh" ? { sshConfigFile: sshConfig! } : {}) };
      const configured = process.env["HARNESS_DEVELOPMENT_REMOTE_PAYLOAD"];
      if (!configured)
        throw new Error("Build and select a Linux payload with HARNESS_DEVELOPMENT_REMOTE_PAYLOAD");
      const payload = resolve(configured);
      const changedPayload = await mkdtemp(join(tmpdir(), "harness-payload-"));
      const clients: HarnessClient[] = [];
      let runtime: PreparedRuntime | undefined;
      try {
        await expect(
          runRemote(host, "exit 23", options, "x".repeat(2 * 1024 * 1024)),
        ).rejects.toMatchObject({ code: 23 });
        runtime = await prepareRemoteRuntime(host, payload, {
          ...options,
          progress: (message) => process.stderr.write(`${message}\n`),
        });
        expect(runtime.transferred).toBe(true);
        const cached = await prepareRemoteRuntime(host, payload, options);
        expect(cached).toEqual({ ...runtime, transferred: false });
        for (const name of ["remote.json", "server.tar.gz", "harness-bootstrap"])
          await cp(join(payload, name), join(changedPayload, name));
        // Change only the gzip timestamp: a distinct complete source archive
        // exercises immutable installation without recompiling on the target.
        const archive = await readFile(join(changedPayload, "server.tar.gz"));
        expect(archive[3]! & 2).toBe(0); // No gzip header CRC to update.
        archive.writeUInt32LE(1, 4);
        await writeFile(join(changedPayload, "server.tar.gz"), archive);
        const metadata = JSON.parse(
          await readFile(join(changedPayload, "remote.json"), "utf8"),
        ) as {
          server: { size: number; sha256: string };
        };
        metadata.server.sha256 = createHash("sha256").update(archive).digest("hex");
        await writeFile(join(changedPayload, "remote.json"), JSON.stringify(metadata));
        const changedOptions = {
          ...options,
          env: { HARNESS_DEVELOPMENT_REMOTE_PAYLOAD: changedPayload },
        };
        const changed = await prepareRemoteRuntime(host, changedPayload, changedOptions);
        expect(changed.buildId).not.toBe(runtime.buildId);
        expect(changed.node).toBe(runtime.node);
        expect(changed.transferred).toBe(true);
        const repeated = await prepareRemoteRuntime(host, changedPayload, changedOptions);
        expect(repeated).toEqual({ ...changed, transferred: false });
        const first = await connectRemote(host, runtime, options);
        const client = new HarnessClient({
          connection: first.connection,
          client: { name: "wsl-fixture", version: "1" },
        });
        clients.push(client);
        await client.start();
        const identity = await client.peer.request(serverInfoRequest, {});
        expect(identity.buildId).toBe(runtime.buildId);
        const selected = await runRemote(
          host,
          `cat ${shellQuote(`${runtime.home}/server/current.json`)}`,
          options,
        );
        archive.writeUInt32LE(2, 4);
        metadata.server.sha256 = createHash("sha256").update(archive).digest("hex");
        await writeFile(join(changedPayload, "server.tar.gz"), archive);
        await writeFile(join(changedPayload, "remote.json"), JSON.stringify(metadata));
        const bootstrap = await readFile(join(changedPayload, "harness-bootstrap"));
        await writeFile(
          join(changedPayload, "harness-bootstrap"),
          Buffer.concat([bootstrap, Buffer.from("corrupted")]),
        );
        await expect(
          prepareRemoteRuntime(host, changedPayload, changedOptions),
        ).rejects.toMatchObject({ code: 1 });
        expect(await client.peer.request(serverInfoRequest, {})).toEqual(identity);
        expect(
          await runRemote(
            host,
            `cat ${shellQuote(`${runtime.home}/server/current.json`)}`,
            options,
          ),
        ).toBe(selected);
        expect(
          await runRemote(
            host,
            `test ! -e ${shellQuote(`${runtime.home}/server/dev-linux-x64-glibc-${metadata.server.sha256}`)} && test -z "$(ls -A ${shellQuote(`${runtime.home}/staging`)})" && printf clean`,
            options,
          ),
        ).toBe("clean");
        await writeFile(join(changedPayload, "harness-bootstrap"), bootstrap);
        await checkBlockedCancellation(host, changedPayload, runtime, changedOptions);
        expect(await client.peer.request(serverInfoRequest, {})).toEqual(identity);
        expect(
          await runRemote(
            host,
            `cat ${shellQuote(`${runtime.home}/server/current.json`)}`,
            options,
          ),
        ).toBe(selected);
        const lost = new Promise<void>((resolve) => first.connection.onClose(() => resolve()));
        // Kill only the fixture bridge with this authenticated home's environment.
        const killBridge = `const fs=require('node:fs'); const home=${JSON.stringify(runtime.home)}; let found=0; for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){ try { const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0'); const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0'); if(args.at(-2)==='--bridge' && args.includes(${JSON.stringify(`${runtime.directory}/server.mjs`)}) && env.includes('HARNESS_HOME='+home)){ process.kill(Number(pid),'SIGKILL'); found++; } } catch(e){ if(!['ENOENT','EACCES','ESRCH'].includes(e.code)) throw e; } } if(found!==1) throw new Error('Expected one fixture bridge, got '+found);`;
        await runRemote(host, `${shellQuote(runtime.node)} -e ${shellQuote(killBridge)}`, options);
        await lost;
        await first.close();
        expect(first.failure).toBeInstanceOf(Error);
        const fresh = await connectRemote(host, changed, options);
        const reconnected = new HarnessClient({
          connection: fresh.connection,
          client: { name: "wsl-reconnected", version: "1" },
        });
        clients.push(reconnected);
        await reconnected.start();
        expect(await reconnected.peer.request(serverInfoRequest, {})).toEqual(identity);
        const stopped = new Promise<void>((resolve) => fresh.connection.onClose(() => resolve()));
        await reconnected.peer.request(serverStopRequest, {});
        await stopped;
        await fresh.close();
        const restarted = await connectRemote(host, changed, options);
        const updated = new HarnessClient({
          connection: restarted.connection,
          client: { name: "remote-source-restart", version: "1" },
        });
        clients.push(updated);
        await updated.start();
        const next = await updated.peer.request(serverInfoRequest, {});
        expect(next.buildId).toBe(changed.buildId);
        expect(next.instanceId).not.toBe(identity.instanceId);
        expect(next.serverId).toBe(identity.serverId);
        const ended = new Promise<void>((resolve) => restarted.connection.onClose(() => resolve()));
        await updated.peer.request(serverStopRequest, {});
        await ended;
        await restarted.close();
      } finally {
        for (const client of clients) client.closeConnection();
        if (runtime) {
          const path = `${runtime.home}/.running-server/discovery.json`;
          const discovery = discoverySchema
            .nullable()
            .parse(
              JSON.parse(
                await runRemote(
                  host,
                  `if test -f ${shellQuote(path)}; then cat ${shellQuote(path)}; else printf null; fi`,
                  options,
                ),
              ),
            );
          if (discovery) await stopRemoteServer(host, runtime, discovery, options);
        }
        await runRemote(host, `rm -rf ${shellQuote(root)}`, options);
        await rm(changedPayload, { recursive: true, force: true });
      }
    },
    600_000,
  );
