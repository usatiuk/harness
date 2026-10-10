import type { RpcConnection } from "@harness/client";
import {
  managementInspectRequest,
  managementReleaseRequest,
  managementStopRequest,
  type ServerIdentity,
} from "./contracts.ts";

/** The caller owns this independent, not-yet-listening management connection. */
export async function stopConnection(
  connection: RpcConnection,
  expected: ServerIdentity,
  ifAlone = false,
): Promise<void> {
  connection.listen();
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const observer = connection.onClose(markClosed);
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Server shutdown did not finish within 20 seconds")),
      20_000,
    );
  });
  try {
    await Promise.race([
      deadline,
      (async () => {
        const identity = managementInspectRequest.result.parse(
          await connection.sendRequest(managementInspectRequest.method, {}),
        );
        if (
          identity.instanceId !== expected.instanceId ||
          identity.serverId !== expected.serverId ||
          identity.home !== expected.home
        )
          throw new Error("Server instance changed; reconnect before stopping it");
        const params = { instanceId: identity.instanceId };
        if (ifAlone) {
          const result = managementReleaseRequest.result.parse(
            await connection.sendRequest(managementReleaseRequest.method, params),
          );
          if (!result.stopping) return;
        } else
          managementStopRequest.result.parse(
            await connection.sendRequest(managementStopRequest.method, params),
          );
        await closed;
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    observer.dispose();
  }
}
