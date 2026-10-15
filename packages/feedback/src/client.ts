import { z } from "zod";
import { defineRequest } from "@harness/protocol";

export const feedbackSettingsSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    endpoint: z.string().url().default("http://127.0.0.1:7331"),
    tokenEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/u)
      .default("MAI_TOKEN"),
  })
  .superRefine((value, ctx) => {
    const url = new URL(value.endpoint);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      ctx.addIssue({
        code: "custom",
        message: "Use HTTPS or loopback HTTP, without URL credentials, query or fragment",
      });
  });
export const feedbackStatusRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.feedback.status",
  params: z.strictObject({}),
  result: z.strictObject({
    enabled: z.boolean(),
    configured: z.boolean(),
    endpoint: z.string(),
    tokenEnv: z.string(),
    pending: z.number().int(),
    failed: z.number().int(),
  }),
});
export const feedbackConfigureRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.feedback.configure",
  params: feedbackSettingsSchema,
  result: z.null(),
});
export const feedbackVoteRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.feedback.vote",
  params: z.strictObject({
    id: z.uuid(),
    conversationId: z.string(),
    itemId: z.string(),
    vote: z.enum(["up", "down"]),
    comment: z.string().max(16000).default(""),
  }),
  result: z.strictObject({
    id: z.string(),
    status: z.enum(["queued", "delivered"]),
    url: z.string(),
  }),
});
export const feedbackRetryRequest = defineRequest({
  direction: "client-to-server",
  method: "plugin.feedback.retry",
  params: z.strictObject({}),
  result: z.null(),
});
