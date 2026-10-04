import { cp, appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { HarnessClient } from "@harness/client";
import { expect, it } from "vitest";
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
} from "./remote.ts";

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
        runtime: { source: "managed" },
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
    `provisions a real ${kind} host, caches dependencies and reconnects after all bridges exit`,
    async () => {
      const root = process.env["HARNESS_REMOTE_FIXTURE_HOME"];
      if (!root) throw new Error("Run npm run test:remote for an isolated remote environment");
      const common = {
        id: "fixture",
        label: `${kind} fixture`,
        runtime: { source: "managed" as const },
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
      const payload = resolve("packages/connections/resources");
      const changedPayload = await mkdtemp(join(tmpdir(), "harness-payload-"));
      const clients: HarnessClient[] = [];
      let runtime: PreparedRuntime | undefined;
      try {
        runtime = await prepareRemoteRuntime(host, payload, {
          ...options,
          progress: (message) => process.stderr.write(`${message}\n`),
        });
        expect(runtime.transferred).toBe(true);
        const cached = await prepareRemoteRuntime(host, payload, options);
        expect(cached).toEqual({ ...runtime, transferred: false });
        await cp(payload, changedPayload, { recursive: true });
        await appendFile(
          join(changedPayload, "server.mjs"),
          "\n// qualification source-only edit\n",
        );
        const development: RemoteHost = {
          ...host,
          runtime: { source: "development" },
        };
        await runRemote(
          host,
          `mkdir -p ${shellQuote(`${root}/bin`)}; ln -s ${shellQuote(runtime.node)} ${shellQuote(`${root}/bin/node`)}`,
          options,
        );
        const changed = await prepareRemoteRuntime(development, changedPayload, options);
        expect(changed.buildId).not.toBe(runtime.buildId);
        expect(changed.dependencyKey).toBe(runtime.dependencyKey);
        expect(changed.transferred).toBe(true);
        const repeated = await prepareRemoteRuntime(development, changedPayload, options);
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
        const lost = new Promise<void>((resolve) => first.connection.onClose(() => resolve()));
        // Kill only the fixture bridge with this authenticated home's environment.
        const killBridge = `const fs=require('node:fs'); const home=${JSON.stringify(runtime.home)}; let found=0; for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){ try { const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0'); const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0'); if(args.at(-2)==='--bridge' && args.includes(${JSON.stringify(`${runtime.directory}/server.mjs`)}) && env.includes('HARNESS_HOME='+home)){ process.kill(Number(pid),'SIGKILL'); found++; } } catch(e){ if(!['ENOENT','EACCES','ESRCH'].includes(e.code)) throw e; } } if(found!==1) throw new Error('Expected one fixture bridge, got '+found);`;
        await runRemote(host, `${shellQuote(runtime.node)} -e ${shellQuote(killBridge)}`, options);
        await lost;
        await first.close();
        expect(first.failure).toBeInstanceOf(Error);
        const fresh = await connectRemote(host, runtime, options);
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
      } finally {
        for (const client of clients) client.closeConnection();
        if (runtime) {
          const path = `${runtime.home}/.server/discovery.json`;
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
