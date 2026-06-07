import { z } from "zod";

export const textContentBlockSchema = z.object({
    type: z.literal("text"),
    text: z.string(),
});

export const binaryContentSourceSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("url"),
        url: z.string(),
    }),
    z.object({
        type: z.literal("file"),
        path: z.string(),
    }),
    z.object({
        type: z.literal("data"),
        data: z.string(),
    }),
]);
export type BinaryContentSource = z.infer<typeof binaryContentSourceSchema>;

export const imageContentBlockSchema = z.object({
    type: z.literal("image"),
    source: binaryContentSourceSchema,
    mediaType: z.string().optional(),
});

export const fileContentBlockSchema = z.object({
    type: z.literal("file"),
    source: binaryContentSourceSchema,
    mediaType: z.string(),
    name: z.string().optional(),
});

export const contentBlockTypeSchema = z.enum(["text", "image", "file"]);
export type ContentBlockType = z.infer<typeof contentBlockTypeSchema>;

export const contentBlockSchema = z.discriminatedUnion("type", [
    textContentBlockSchema,
    imageContentBlockSchema,
    fileContentBlockSchema,
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ModelContentBlock = ContentBlock;
