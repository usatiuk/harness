import { describe, expect, it } from "vitest";
import {
  contentBlockSchema,
  detectImageMediaType,
  imageByteLength,
  imageContentSchema,
  imageContentsSchema,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_CONTENT_BYTES,
  textOf,
} from "./content.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const image = { type: "image", mediaType: "image/png", data: png.toString("base64") } as const;
const imageBytes = (size: number) =>
  Buffer.concat([png, Buffer.alloc(size - png.length)]).toString("base64");

describe("inline image content", () => {
  it.each([
    [png, "image/png"],
    [Buffer.from([255, 216, 255]), "image/jpeg"],
    [Buffer.from("GIF87a"), "image/gif"],
    [Buffer.from("GIF89a"), "image/gif"],
    [Buffer.from("RIFF1234WEBP"), "image/webp"],
  ] as const)("recognizes supported image signatures", (bytes, mediaType) => {
    expect(detectImageMediaType(bytes)).toBe(mediaType);
    expect(
      imageContentSchema.parse({ ...image, mediaType, data: bytes.toString("base64") }),
    ).toEqual({ ...image, mediaType, data: bytes.toString("base64") });
  });
  it("keeps bytes intact and extracts only textual content", () => {
    expect(contentBlockSchema.parse(image)).toEqual(image);
    expect(imageByteLength(image.data)).toBe(png.length);
    expect(textOf([{ type: "text", text: "before" }, image, { type: "text", text: "after" }])).toBe(
      "beforeafter",
    );
  });
  it.each([
    { ...image, data: "not base64" },
    { ...image, data: "" },
    { ...image, data: "aGVsbG8=" },
    { ...image, mediaType: "image/jpeg" },
    { ...image, mediaType: "image/svg+xml" },
    { ...image, data: `data:image/png;base64,${image.data}` },
  ])("rejects malformed or mismatched image data", (value) => {
    expect(imageContentSchema.safeParse(value).success).toBe(false);
  });
  it("bounds encoded overhead for many tiny images below the decoded limit", () => {
    const count = Math.floor((MAX_IMAGE_CONTENT_BYTES - 1) / (JSON.stringify(image).length + 1));
    const within = Array.from({ length: count }, () => image);
    expect(count * imageByteLength(image.data)).toBeLessThan(MAX_IMAGE_BYTES);
    expect(imageContentsSchema.safeParse(within).success).toBe(true);
    expect(imageContentsSchema.safeParse([...within, image]).success).toBe(false);
  });
  it("enforces decoded image and combined message limits", () => {
    const atLimit = { ...image, data: imageBytes(MAX_IMAGE_BYTES) };
    expect(imageContentSchema.safeParse(atLimit).success).toBe(true);
    expect(imageByteLength(atLimit.data)).toBe(MAX_IMAGE_BYTES);
    expect(
      imageContentSchema.safeParse({ ...image, data: imageBytes(MAX_IMAGE_BYTES + 1) }).success,
    ).toBe(false);
    expect(imageContentsSchema.safeParse([atLimit, image]).success).toBe(false);
  });
});
