import { expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "@harness/protocol";
import { readImageFiles } from "./image-files.ts";

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
