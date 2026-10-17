import { z } from "zod";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Base64 plus JSON overhead stays below the existing four-MiB RPC frame. */
export const MAX_IMAGE_CONTENT_BYTES = 3 * 1024 * 1024;
export const imageMediaTypeSchema = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>;

export function detectImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const header = String.fromCharCode(...bytes.subarray(0, 12));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Decoded length of an already validated base64 string. */
export const imageByteLength = (data: string): number =>
  (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

export const imageContentSchema = z
  .strictObject({
    type: z.literal("image"),
    mediaType: imageMediaTypeSchema,
    data: z
      .base64()
      .min(4)
      .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
  })
  .superRefine(({ data, mediaType }, ctx) => {
    if (imageByteLength(data) > MAX_IMAGE_BYTES)
      ctx.addIssue({ code: "custom", message: "Image exceeds 2 MiB" });
    let detected: ImageMediaType | undefined;
    try {
      detected = detectImageMediaType(
        Uint8Array.from(atob(data.slice(0, 16)), (c) => c.charCodeAt(0)),
      );
    } catch {
      /* Invalid base64 is reported by the string schema. */
    }
    if (detected !== mediaType)
      ctx.addIssue({ code: "custom", message: "Image data does not match its media type" });
  });
export type ImageContent = z.infer<typeof imageContentSchema>;
export const imageContentsSchema = z.array(imageContentSchema).superRefine((images, ctx) => {
  if (images.reduce((bytes, image) => bytes + imageByteLength(image.data), 0) > MAX_IMAGE_BYTES)
    ctx.addIssue({ code: "custom", message: "Images exceed the 2 MiB message limit" });
  // All fields are ASCII: serialized length is also its UTF-8 byte length.
  if (JSON.stringify(images).length > MAX_IMAGE_CONTENT_BYTES)
    ctx.addIssue({ code: "custom", message: "Images exceed the 3 MiB encoded content limit" });
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  imageContentSchema,
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

/** Concatenates text only; image presentation belongs to the consuming client. */
export const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
