import { z } from "zod";
import { connectionCommandSchema } from "./contracts.ts";
export { connectionCommandSchema, preparedRuntimeSchema } from "./contracts.ts";
export type { ConnectionCommand } from "./contracts.ts";
import { HarnessClient } from "@harness/client";
import {
  hostSchema,
  serverIdentitySchema,
  serverInfoRequest,
  serverStopRequest,
} from "./contracts.ts";
import { readClientConfig, removeHost, saveHost, updateClientConfig } from "./registry.ts";
import { stopServer } from "./connect.ts";
import {
  connectRemote,
  discoverWsl,
  prepareRemoteRuntime,
  type PreparedRuntime,
  type RemoteOptions,
} from "./remote.ts";

/** Native and terminal clients use this same validated registry/provisioning boundary. */
export async function runConnectionCommand(
  value: unknown,
  payload: string,
  options: RemoteOptions = {},
): Promise<unknown> {
  const command = connectionCommandSchema.parse(value);
  switch (command.type) {
    case "config.read":
      return readClientConfig();
    case "host.save":
      return saveHost(command.host);
    case "host.remove":
      return removeHost(command.id);
    case "host.select":
      return updateClientConfig((config) => ({ ...config, selectedHostId: command.id }));
    case "preferences":
      return updateClientConfig((config) => ({
        ...config,
        desktop: { keepServerRunning: command.keepServerRunning },
      }));
    case "wsl.list":
      return discoverWsl();
    case "runtime.prepare": {
      if (command.host.kind === "local") throw new Error("Local uses the bundled runtime");
      return prepareRemoteRuntime(command.host, payload, options);
    }
    case "server.stop": {
      if (command.host.kind === "local") {
        await stopServer(command.identity);
        return null;
      }
      if (!command.runtime) throw new Error("Missing prepared remote runtime");
      await stopRemoteServer(command.host, command.runtime, command.identity, options);
      return null;
    }
  }
}

export async function stopRemoteServer(
  host: Exclude<z.infer<typeof hostSchema>, { kind: "local" }>,
  runtime: PreparedRuntime,
  expected: z.infer<typeof serverIdentitySchema>,
  options: RemoteOptions = {},
): Promise<void> {
  const transport = await connectRemote(host, runtime, options, false);
  const client = new HarnessClient({
    connection: transport.connection,
    client: { name: "harness-control", version: "0.0.0" },
  });
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Remote shutdown did not finish within 20 seconds")),
      20_000,
    );
  });
  const closed = new Promise<void>((resolve) => transport.connection.onClose(() => resolve()));
  try {
    await Promise.race([
      deadline,
      (async () => {
        await client.start();
        const identity = await client.peer.request(serverInfoRequest, {});
        if (
          identity.instanceId !== expected.instanceId ||
          identity.serverId !== expected.serverId ||
          identity.home !== expected.home
        )
          throw new Error("Server instance changed; reconnect before stopping it");
        await client.peer.request(serverStopRequest, {});
        await closed;
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    client.closeConnection();
    await transport.close();
  }
}
