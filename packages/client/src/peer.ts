import type {
  InitializeParams,
  InitializeResult,
  JsonValue,
  RpcDirection,
  RpcNotification,
  RpcRequest,
} from "@harness/protocol";
import { REQUEST_CANCELLED_ERROR_CODE, initializeRequest } from "@harness/protocol";
import { CancellationTokenSource, ErrorCodes, ResponseError } from "vscode-jsonrpc";
import type { CancellationToken, Disposable, MessageConnection } from "vscode-jsonrpc";

export type RpcConnection = MessageConnection;

export type RpcPeerRole = "client" | "server";
type PeerState = "created" | "listening" | "initializing" | "ready" | "closed";

export interface RpcPeerOptions {
  readonly role: RpcPeerRole;
  readonly connection: MessageConnection;
  readonly onHandlerError?: (error: unknown, method: string) => void;
  readonly onProtocolError?: (error: ProtocolError) => void;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export type RequestHandler<P extends JsonValue, R extends JsonValue> = (
  params: P,
  signal: AbortSignal,
) => R | Promise<R>;

export type NotificationHandler<P extends JsonValue> = (params: P) => void;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const outboundDirection = (role: RpcPeerRole): RpcDirection =>
  role === "client" ? "client-to-server" : "server-to-client";

const inboundDirection = (role: RpcPeerRole): RpcDirection =>
  role === "client" ? "server-to-client" : "client-to-server";

const directionError = (method: string, expected: RpcDirection): Error =>
  new Error(`RPC method '${method}' is not ${expected}`);

export class RpcPeer {
  private state: PeerState = "created";
  private initializeRegistration: Disposable | undefined;

  constructor(private readonly options: RpcPeerOptions) {
    options.connection.onClose(() => {
      this.state = "closed";
      // vscode-jsonrpc reports transport closure separately from disposal; disposal
      // is what rejects requests that can no longer receive a response.
      options.connection.dispose();
    });
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  listen(): void {
    if (this.state !== "created") {
      throw new Error("RPC peer can only start listening once");
    }
    this.state = "listening";
    this.options.connection.listen();
  }

  onInitialize(handler: RequestHandler<InitializeParams, InitializeResult>): Disposable {
    if (this.options.role !== "server") {
      throw new Error("only a server peer can handle initialization");
    }
    if (this.initializeRegistration !== undefined) {
      throw new Error("initialize handler is already registered");
    }

    const registration = this.options.connection.onRequest(
      initializeRequest.method,
      async (rawParams: unknown, token: CancellationToken) => {
        if (this.state !== "listening") {
          return new ResponseError(ErrorCodes.InvalidRequest, "peer is already initialized");
        }

        const params = initializeRequest.params.safeParse(rawParams);
        if (!params.success) {
          return new ResponseError(ErrorCodes.InvalidParams, "invalid initialize parameters");
        }

        this.state = "initializing";
        const result = await this.invokeHandler(initializeRequest, params.data, token, handler);
        if (result instanceof ResponseError) {
          this.state = "listening";
          return result;
        }
        this.state = "ready";
        return result;
      },
    );
    this.initializeRegistration = registration;
    return registration;
  }

  async initialize(
    params: InitializeParams,
    options: RequestOptions = {},
  ): Promise<InitializeResult> {
    if (this.options.role !== "client") {
      throw new Error("only a client peer can initiate initialization");
    }
    if (this.state !== "listening") {
      throw new Error("RPC client must be listening and uninitialized");
    }

    this.state = "initializing";
    try {
      const result = await this.send(initializeRequest, params, options);
      this.state = "ready";
      return result;
    } catch (error) {
      if (!this.isClosed()) this.state = "listening";
      throw error;
    }
  }

  onRequest<P extends JsonValue, R extends JsonValue>(
    definition: RpcRequest<P, R>,
    handler: RequestHandler<P, R>,
  ): Disposable {
    if (definition.direction !== inboundDirection(this.options.role)) {
      throw directionError(definition.method, inboundDirection(this.options.role));
    }

    return this.options.connection.onRequest(
      definition.method,
      async (rawParams: unknown, token: CancellationToken) => {
        if (this.state !== "ready") {
          return new ResponseError(ErrorCodes.ServerNotInitialized, "peer is not initialized");
        }
        const params = definition.params.safeParse(rawParams);
        if (!params.success) {
          return new ResponseError(
            ErrorCodes.InvalidParams,
            `invalid parameters for '${definition.method}'`,
          );
        }
        return this.invokeHandler(definition, params.data, token, handler);
      },
    );
  }

  onNotification<P extends JsonValue>(
    definition: RpcNotification<P>,
    handler: NotificationHandler<P>,
  ): Disposable {
    if (definition.direction !== inboundDirection(this.options.role)) {
      throw directionError(definition.method, inboundDirection(this.options.role));
    }

    return this.options.connection.onNotification(definition.method, (rawParams: unknown) => {
      if (this.state !== "ready") {
        this.failProtocol(`notification '${definition.method}' arrived before initialization`);
        return;
      }
      const params = definition.params.safeParse(rawParams);
      if (!params.success) {
        this.failProtocol(`invalid parameters for notification '${definition.method}'`);
        return;
      }
      try {
        handler(params.data);
      } catch (error) {
        this.options.onHandlerError?.(error, definition.method);
        this.failProtocol(`notification handler '${definition.method}' failed`);
      }
    });
  }

  request<P extends JsonValue, R extends JsonValue>(
    definition: RpcRequest<P, R>,
    params: P,
    options: RequestOptions = {},
  ): Promise<R> {
    if (this.state !== "ready") {
      return Promise.reject(new Error("RPC peer is not initialized"));
    }
    if (definition.direction !== outboundDirection(this.options.role)) {
      return Promise.reject(
        directionError(definition.method, outboundDirection(this.options.role)),
      );
    }
    return this.send(definition, params, options);
  }

  async notify<P extends JsonValue>(definition: RpcNotification<P>, params: P): Promise<void> {
    if (this.state !== "ready") {
      throw new Error("RPC peer is not initialized");
    }
    if (definition.direction !== outboundDirection(this.options.role)) {
      throw directionError(definition.method, outboundDirection(this.options.role));
    }
    const parsed = definition.params.parse(params);
    await this.options.connection.sendNotification(definition.method, parsed);
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.options.connection.end();
    this.options.connection.dispose();
  }

  terminateProtocol(message: string): void {
    this.failProtocol(message);
  }

  private async send<P extends JsonValue, R extends JsonValue>(
    definition: RpcRequest<P, R>,
    params: P,
    options: RequestOptions,
  ): Promise<R> {
    const parsedParams = definition.params.parse(params);
    if (options.signal?.aborted === true) {
      throw new ResponseError(REQUEST_CANCELLED_ERROR_CODE, "request cancelled");
    }
    const source = options.signal === undefined ? undefined : new CancellationTokenSource();
    const cancel = () => source?.cancel();
    options.signal?.addEventListener("abort", cancel, { once: true });

    try {
      const rawResult =
        source === undefined
          ? await this.options.connection.sendRequest<unknown>(definition.method, parsedParams)
          : await this.options.connection.sendRequest<unknown>(
              definition.method,
              parsedParams,
              source.token,
            );
      const result = definition.result.safeParse(rawResult);
      if (!result.success) {
        this.failProtocol(`invalid result for '${definition.method}'`);
        throw new ProtocolError(`invalid result for '${definition.method}'`);
      }
      return result.data;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      source?.dispose();
    }
  }

  private async invokeHandler<P extends JsonValue, R extends JsonValue>(
    definition: RpcRequest<P, R>,
    params: P,
    token: CancellationToken,
    handler: RequestHandler<P, R>,
  ): Promise<R | ResponseError<JsonValue>> {
    const controller = new AbortController();
    if (token.isCancellationRequested) {
      return new ResponseError(REQUEST_CANCELLED_ERROR_CODE, "request cancelled");
    }
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      const rawResult = await handler(params, controller.signal);
      if (controller.signal.aborted) {
        return new ResponseError(REQUEST_CANCELLED_ERROR_CODE, "request cancelled");
      }
      const result = definition.result.safeParse(rawResult);
      if (!result.success) {
        this.options.onHandlerError?.(
          new ProtocolError(`handler returned an invalid result for '${definition.method}'`),
          definition.method,
        );
        return new ResponseError(ErrorCodes.InternalError, "internal error");
      }
      return result.data;
    } catch (error) {
      if (controller.signal.aborted) {
        return new ResponseError(REQUEST_CANCELLED_ERROR_CODE, "request cancelled");
      }
      if (error instanceof ResponseError) return error as ResponseError<JsonValue>;
      this.options.onHandlerError?.(error, definition.method);
      return new ResponseError(ErrorCodes.InternalError, "internal error");
    } finally {
      cancellation.dispose();
    }
  }

  private failProtocol(message: string): void {
    const error = new ProtocolError(message);
    this.options.onProtocolError?.(error);
    this.close();
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }
}
