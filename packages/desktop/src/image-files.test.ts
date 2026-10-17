import { expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "@harness/protocol";
import { needsClipboardRead, readImageFiles } from "./image-files.ts";

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
)("uses the browser clipboard read for image/file paste targets $types", ({ types }) => {
  expect(needsClipboardRead(types)).toBe(true);
});
it("keeps ordinary text and HTML paste on the browser editing path", () => {
  expect(needsClipboardRead(["text/plain", "text/html"])).toBe(false);
});

it("preserves the real WebKit URL clipboard payload while claiming local file targets", () => {
  expect(needsClipboardRead(["text/uri-list"], "https://example.com/image.png\r\n")).toBe(false);
  expect(needsClipboardRead(["text/uri-list"], "file:///tmp/screenshot.png\r\n")).toBe(true);
});

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP578LwHwAF4AJH4fprIAAAAABJRU5ErkJggg==";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));

it("reads bitmap bytes with the standard browser clipboard API", async () => {
  const { readClipboardImages } = await import("./image-files.ts");
  const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
  const read = vi
    .fn()
    .mockResolvedValue([
      { types: ["image/png"], getType: () => Promise.resolve(new Blob([bytes])) },
    ]);
  vi.stubGlobal("navigator", { clipboard: { read } });
  vi.stubGlobal(
    "FileReader",
    class {
      result = "";
      onload = () => {};
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((buffer) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
          this.onload();
        });
      }
    },
  );
  try {
    await expect(readClipboardImages()).resolves.toEqual([
      { type: "image", mediaType: "image/png", data: png },
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reads copied file URIs through the existing bounded local reader", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const { readClipboardImages } = await import("./image-files.ts");
  vi.mocked(invoke).mockResolvedValue([png]);
  vi.stubGlobal("navigator", {
    clipboard: {
      read: vi.fn().mockResolvedValue([
        {
          types: ["text/uri-list"],
          getType: () => Promise.resolve(new Blob(["# comment\r\nfile:///tmp/a%20b.png\r\n"])),
        },
      ]),
    },
  });
  try {
    await expect(readClipboardImages()).resolves.toEqual([
      { type: "image", mediaType: "image/png", data: png },
    ]);
    expect(invoke).toHaveBeenCalledWith("read_image_paths", { paths: ["file:///tmp/a%20b.png"] });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reports browser clipboard permission failures", async () => {
  const { readClipboardImages } = await import("./image-files.ts");
  vi.stubGlobal("navigator", {
    clipboard: { read: vi.fn().mockRejectedValue(new Error("Clipboard access denied")) },
  });
  try {
    await expect(readClipboardImages()).rejects.toThrow("Clipboard access denied");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not silently discard clipboard items with no readable image representation", async () => {
  const { readClipboardImages } = await import("./image-files.ts");
  vi.stubGlobal("navigator", { clipboard: { read: vi.fn().mockResolvedValue([{ types: [] }]) } });
  try {
    await expect(readClipboardImages()).rejects.toThrow("Clipboard contains no supported image");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("rejects an oversized clipboard batch before reading later image bytes", async () => {
  const { readClipboardImages } = await import("./image-files.ts");
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
  Buffer.from(png, "base64").copy(bytes);
  vi.mocked(invoke).mockResolvedValue([bytes.toString("base64")]);
  const later = vi.fn();
  vi.stubGlobal("navigator", {
    clipboard: {
      read: vi.fn().mockResolvedValue([
        {
          types: ["text/uri-list"],
          getType: () => Promise.resolve(new Blob(["file:///tmp/full-budget.png"])),
        },
        { types: ["image/png"], getType: () => Promise.resolve(new Blob(["x"])) },
        { types: ["image/png"], getType: later },
      ]),
    },
  });
  try {
    await expect(readClipboardImages()).rejects.toThrow("2 MiB per message");
    expect(later).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
