import { expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "@harness/protocol";
import { needsNativeImagePaste, readImageFiles } from "./image-files.ts";

it("rejects an oversized aggregate before reading any image files", async () => {
  const reader = vi.fn();
  vi.stubGlobal("FileReader", reader);
  try {
    await expect(
      readImageFiles([
        new File([new Uint8Array(MAX_IMAGE_BYTES)], "one.png", { type: "image/png" }),
        new File([new Uint8Array(1)], "two.png", { type: "image/png" }),
      ]),
    ).rejects.toThrow("2 MiB per message");
    expect(reader).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(
  [[], ["text/uri-list"], ["x-special/gnome-copied-files"], ["image/png"], ["Files"]].map(
    (types) => ({ types }),
  ),
)("uses the native clipboard boundary for image/file paste targets $types", ({ types }) => {
  expect(needsNativeImagePaste(types)).toBe(true);
});
it("keeps ordinary text and HTML paste on the browser editing path", () => {
  expect(needsNativeImagePaste(["text/plain", "text/html"])).toBe(false);
});

it("preserves the real WebKit URL clipboard payload while claiming local file targets", () => {
  expect(needsNativeImagePaste(["text/uri-list"], "https://example.com/image.png\r\n")).toBe(false);
  expect(needsNativeImagePaste(["text/uri-list"], "file:///tmp/screenshot.png\r\n")).toBe(true);
});
