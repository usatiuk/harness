import { z } from "zod";
import { toolPermissionSchema } from "@harness/approval/client";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);
function dictionary<K extends z.ZodString, V extends z.ZodType>(key: K, value: V) {
  return z.preprocess(
    (input, ctx) => {
      // Zod records silently discard this own key; reject it before parsing.
      if (input && typeof input === "object" && Object.hasOwn(input, "__proto__"))
        ctx.addIssue({ code: "custom", message: "__proto__ is not a supported dictionary key" });
      return input;
    },
    z.record(key, value),
  );
}
export const credentialSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("env"), name: z.string().min(1) }),
  z.strictObject({ type: z.literal("secret"), slot: z.string().min(1).max(128) }),
]);
export const valueSourceSchema = z.union([
  z.strictObject({ type: z.literal("literal"), value: z.string() }),
  credentialSourceSchema,
]);
const sources = dictionary(z.string().min(1), valueSourceSchema).default({});
const oauth = z
  .strictObject({
    type: z.literal("oauth"),
    clientId: z.string().min(1).optional(),
    clientSecret: credentialSourceSchema.optional(),
    clientMetadataUrl: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.pathname !== "/" &&
          !url.username &&
          !url.password &&
          !url.hash
        );
      }, "client metadata URL must use HTTPS with a non-root path, without userinfo or fragment")
      .optional(),
    scopes: z.array(z.string().min(1)).default([]),
  })
  .refine((auth) => !auth.clientSecret || !!auth.clientId, "client secret requires client ID");
export const transportConfigSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("stdio"),
      executable: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().min(1).optional(),
      env: sources,
    }),
    z.strictObject({
      type: z.literal("http"),
      url: z.url(),
      headers: sources,
      auth: z
        .union([
          z.strictObject({ type: z.literal("none") }),
          z.strictObject({ type: z.literal("bearer"), token: credentialSourceSchema }),
          oauth,
        ])
        .default({ type: "none" }),
    }),
  ])
  .superRefine((transport, ctx) => {
    if (transport.type === "stdio") {
      for (const name of Object.keys(transport.env)) {
        if (!/^[^=\0]+$/u.test(name))
          ctx.addIssue({ code: "custom", message: "invalid environment name" });
      }
      return;
    }
    const url = new URL(transport.url);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "HTTP endpoint must use HTTPS (loopback HTTP allowed), without userinfo or fragment",
      });
    }
    for (const [name, source] of Object.entries(transport.headers)) {
      const lower = name.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
        ["host", "content-length", "content-type", "accept"].includes(lower) ||
        lower.startsWith("mcp-") ||
        (lower === "authorization" && transport.auth.type !== "none") ||
        (source.type === "literal" && /[\r\n\0]/u.test(source.value))
      ) {
        ctx.addIssue({ code: "custom", message: "invalid or transport-managed header" });
      }
    }
  });
const defaults = z.strictObject({
  readOnly: toolPermissionSchema.default("allow"),
  other: toolPermissionSchema.default("ask"),
});
export const mcpConfigSchema = z.strictObject({
  defaults: defaults.default({ readOnly: "allow", other: "ask" }),
  servers: dictionary(
    identifier,
    z.strictObject({
      enabled: z.boolean().default(true),
      transport: transportConfigSchema,
      defaults: z
        .strictObject({
          readOnly: toolPermissionSchema.optional(),
          other: toolPermissionSchema.optional(),
        })
        .default({}),
      tools: dictionary(z.string().min(1), toolPermissionSchema).default({}),
    }),
  ).default({}),
});
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpServerConfig = McpConfig["servers"][string];
export type McpTransportConfig = z.infer<typeof transportConfigSchema>;
export type McpValueSource = z.infer<typeof valueSourceSchema>;
export type McpOAuthConfig = z.infer<typeof oauth>;
