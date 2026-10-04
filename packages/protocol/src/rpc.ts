import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type RpcDirection = "client-to-server" | "server-to-client";

export interface RpcRequest<P extends JsonValue, R extends JsonValue> {
  readonly kind: "request";
  readonly direction: RpcDirection;
  readonly method: string;
  readonly params: z.ZodType<P>;
  readonly result: z.ZodType<R>;
}

export interface RpcNotification<P extends JsonValue> {
  readonly kind: "notification";
  readonly direction: RpcDirection;
  readonly method: string;
  readonly params: z.ZodType<P>;
}

export type RpcMessage = RpcRequest<JsonValue, JsonValue> | RpcNotification<JsonValue>;

export const defineRequest = <P extends JsonValue, R extends JsonValue>(
  definition: Omit<RpcRequest<P, R>, "kind">,
): RpcRequest<P, R> => ({ kind: "request", ...definition });

export const defineNotification = <P extends JsonValue>(
  definition: Omit<RpcNotification<P>, "kind">,
): RpcNotification<P> => ({ kind: "notification", ...definition });

export const HARNESS_PROTOCOL_VERSION = 3 as const;
export const REQUEST_CANCELLED_ERROR_CODE = -32800 as const;

export const peerInfoSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
});
export type PeerInfo = z.infer<typeof peerInfoSchema>;

export const pluginContractSchema = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().positive(),
});
export type PluginContract = z.infer<typeof pluginContractSchema>;

export const initializeParamsSchema = z.strictObject({
  protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION),
  client: peerInfoSchema,
  plugins: z.array(pluginContractSchema),
});

export type InitializeParams = z.infer<typeof initializeParamsSchema>;

export const initializeResultSchema = z.strictObject({
  protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION),
  server: peerInfoSchema,
  plugins: z.array(pluginContractSchema),
});

export type InitializeResult = z.infer<typeof initializeResultSchema>;

export const initializeRequest = defineRequest({
  direction: "client-to-server",
  method: "initialize",
  params: initializeParamsSchema,
  result: initializeResultSchema,
});
