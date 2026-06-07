import { z } from "zod";

/** A unit of model-facing content. Discriminated on `type`; only text exists today. */
export type ContentBlock = { type: "text"; text: string };

export const contentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
