import { RpcPeer } from "@harness/client";
import type {
  NotificationHandler,
  RequestHandler,
  RpcConnection,
  RpcPeerOptions,
} from "@harness/client";
import { HARNESS_PROTOCOL_VERSION } from "@harness/protocol";
import type {
  InitializeParams,
  JsonValue,
  PeerInfo,
  PluginContract,
  RpcNotification,
  RpcRequest,
} from "@harness/protocol";

export interface RpcServerOptions {
  readonly connection: RpcConnection;
  readonly server: PeerInfo;
  readonly plugins?: PluginContract[];
  readonly onHandlerError?: RpcPeerOptions["onHandlerError"];
  readonly onProtocolError?: RpcPeerOptions["onProtocolError"];
  readonly onInitialize?: (params: InitializeParams) => void;
}

/** Server-owned dispatch over the shared, transport-independent RPC peer. */
export class RpcServer {
  readonly peer: RpcPeer;

  constructor(options: RpcServerOptions) {
    this.peer = new RpcPeer({
      role: "server",
      connection: options.connection,
      ...(options.onHandlerError === undefined ? {} : { onHandlerError: options.onHandlerError }),
      ...(options.onProtocolError === undefined
        ? {}
        : { onProtocolError: options.onProtocolError }),
    });
    this.peer.onInitialize((params) => {
      options.onInitialize?.(params);
      return {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        server: options.server,
        plugins: options.plugins ?? [],
      };
    });
  }

  onRequest<P extends JsonValue, R extends JsonValue>(
    definition: RpcRequest<P, R>,
    handler: RequestHandler<P, R>,
  ): void {
    this.peer.onRequest(definition, handler);
  }

  onNotification<P extends JsonValue>(
    definition: RpcNotification<P>,
    handler: NotificationHandler<P>,
  ): void {
    this.peer.onNotification(definition, handler);
  }

  start(): void {
    this.peer.listen();
  }

  close(): void {
    this.peer.close();
  }
}
