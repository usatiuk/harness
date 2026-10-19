import { z } from "zod";
import { type ConnectionCommand, type ConnectionCommandResult } from "./contracts.ts";
export { connectionCommandSchema, preparedRuntimeSchema } from "./contracts.ts";
export type { ConnectionCommand } from "./contracts.ts";
import { hostSchema, serverIdentitySchema } from "./contracts.ts";
import { stopConnection } from "./control.ts";
import { readClientConfig, removeHost, saveHost, updateClientConfig } from "./registry.ts";
import { stopServer } from "./connect.ts";
import { readDiscovery } from "./local.ts";
import {
  connectRemote,
  discoverWsl,
  prepareRemoteRuntime,
  type PreparedRuntime,
  type RemoteOptions,
} from "./remote.ts";

/** Native and terminal clients use this same validated registry/provisioning boundary. */
export function runConnectionCommand<C extends ConnectionCommand>(
  value: C,
  payload: string,
  options?: RemoteOptions,
): Promise<ConnectionCommandResult<C>>;
export async function runConnectionCommand(
  command: ConnectionCommand,
  payload: string,
  options: RemoteOptions = {},
): Promise<ConnectionCommandResult<ConnectionCommand>> {
  switch (command.type) {
    case "config.read":
      return readClientConfig();
    case "host.save":
      return saveHost(command.host);
    case "host.remove":
      return removeHost(command.id);
    case "host.select":
      return updateClientConfig((config) => ({ ...config, selectedHostId: command.id }));
    case "wsl.list":
      return discoverWsl(options.signal);
    case "desktop.exit": {
      if (command.target.runtime !== null) {
        await stopRemoteServer(
          command.target.host,
          command.target.runtime,
          command.identity,
          options,
          true,
        );
        return null;
      }
      const current = await readDiscovery(command.identity.home);
      if (
        !current ||
        current.instanceId !== command.identity.instanceId ||
        current.serverId !== command.identity.serverId
      )
        return null;
      try {
        await stopServer(command.identity, true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
      }
      return null;
    }
    case "runtime.prepare": {
      return prepareRemoteRuntime(command.host, payload, options);
    }
    case "server.stop": {
      if (command.runtime === null) {
        await stopServer(command.identity);
        return null;
      }
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
  ifAlone = false,
): Promise<void> {
  const transport = await connectRemote(host, runtime, options, false);
  try {
    await stopConnection(transport.connection, expected, ifAlone);
  } finally {
    await transport.close();
  }
}
