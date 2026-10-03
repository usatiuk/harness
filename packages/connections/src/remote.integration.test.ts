import { randomUUID } from "node:crypto";
import { cp, appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, posix } from "node:path";
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
for (const kind of ["wsl", "ssh"] as const)
  it.skipIf(kind === "wsl" ? !distribution : !sshConfig)(
    `provisions a real ${kind} host, caches dependencies and reconnects after all bridges exit`,
    async () => {
      const root = `/tmp/harness-remote-${randomUUID()}`;
      const common = {
        id: "fixture",
        label: `${kind} fixture`,
        home: `${root}/home`,
        runtime: { source: "managed" as const, directory: `${root}/runtime`, node: null },
      };
      const host: RemoteHost =
        kind === "wsl"
          ? { ...common, kind, distribution: distribution!, user: null }
          : {
              ...common,
              kind,
              destination: "harness-fixture",
              port: null,
              identityFile: null,
              configFile: sshConfig!,
            };
      const payload = resolve("packages/connections/resources");
      const changedPayload = await mkdtemp(join(tmpdir(), "harness-payload-"));
      const clients: HarnessClient[] = [];
      let runtime: PreparedRuntime | undefined;
      try {
        runtime = await prepareRemoteRuntime(host, payload, {
          progress: (message) => process.stderr.write(`${message}\n`),
        });
        expect(runtime.transferred).toBe(true);
        const cached = await prepareRemoteRuntime(host, payload);
        expect(cached).toEqual({ ...runtime, transferred: false });
        await cp(payload, changedPayload, { recursive: true });
        await appendFile(
          join(changedPayload, "server.mjs"),
          "\n// qualification source-only edit\n",
        );
        const development: RemoteHost = {
          ...host,
          runtime: { ...host.runtime, source: "development", node: runtime.node },
        };
        const changed = await prepareRemoteRuntime(development, changedPayload);
        expect(changed.buildId).not.toBe(runtime.buildId);
        expect(changed.dependencyKey).toBe(runtime.dependencyKey);
        expect(changed.transferred).toBe(true);
        // A relative explicit Node path resolves once into absolute launch metadata.
        const relative: RemoteHost = {
          ...development,
          runtime: {
            ...development.runtime,
            node: `./${posix.relative(await runRemote(host, "pwd"), runtime.node)}`,
          },
        };
        const repeated = await prepareRemoteRuntime(relative, changedPayload);
        expect(repeated).toEqual({ ...changed, transferred: false });
        const first = await connectRemote(host, runtime);
        const client = new HarnessClient({
          connection: first.connection,
          client: { name: "wsl-fixture", version: "1" },
        });
        clients.push(client);
        await client.start();
        const identity = await client.peer.request(serverInfoRequest, {});
        expect(identity.buildId).toBe(runtime.buildId);
        client.closeConnection();
        await first.close();
        const fresh = await connectRemote(host, runtime);
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
                ),
              ),
            );
          if (discovery) await stopRemoteServer(host, runtime, discovery);
        }
        await runRemote(host, `rm -rf ${shellQuote(root)}`);
        await rm(changedPayload, { recursive: true, force: true });
      }
    },
    600_000,
  );
