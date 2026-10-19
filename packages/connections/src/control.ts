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
  ifIdle = false,
): Promise<void> {
  connection.listen();
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const observer = connection.onClose(() => {
    markClosed();
    // Transport closure is queued after accepted responses. Reject an unfinished
    // handshake instead of leaving its raw JSON-RPC request pending until timeout.
    connection.dispose();
  });
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
        } else {
          const result = managementStopRequest.result.parse(
            await connection.sendRequest(
              managementStopRequest.method,
              ifIdle ? { ...params, ifIdle: true } : params,
            ),
          );
          if (!result.accepted)
            throw new Error(
              "Server upgrade is pending: finish or stop the active work, then reconnect",
            );
        }
        await closed;
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    observer.dispose();
  }
}
