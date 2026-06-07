import { z } from "zod";

/** A unit of model-facing content. Discriminated on `type`; only text exists today. */
export type ContentBlock = { type: "text"; text: string };

export const contentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/** Concatenates the text of a content array, ignoring non-text blocks. */
export const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
