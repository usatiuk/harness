import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  detectImageMediaType,
  imageContentsSchema,
  imageContentSchema,
  imageMediaTypeSchema,
  imageByteLength,
  MAX_IMAGE_BYTES,
  type ImageContent,
} from "@harness/protocol";

export async function readImageFiles(files: readonly File[]): Promise<ImageContent[]> {
  if (files.reduce((bytes, file) => bytes + file.size, 0) > MAX_IMAGE_BYTES)
    throw new Error("Images must fit within 2 MiB per message.");
  return Promise.all(
    files.map(
      (file) =>
        new Promise<ImageContent>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error ?? new Error(`Cannot read ${file.name}`));
          reader.onload = () => {
            if (typeof reader.result !== "string") {
              reject(new Error("Image reader did not return a data URL"));
              return;
            }
            const result = imageContentSchema.safeParse({
              type: "image",
              mediaType: file.type,
              data: reader.result.split(",")[1],
            });
            if (result.success) resolve(result.data);
            else reject(new Error(`Unsupported image: ${file.name}. Use PNG, JPEG, WebP, or GIF.`));
          };
          reader.readAsDataURL(file);
        }),
    ),
  );
}

function nativeImageData(data: string[]): ImageContent[] {
  return imageContentsSchema.parse(
    data.map((data) => {
      const mediaType = detectImageMediaType(
        Uint8Array.from(atob(data.slice(0, 16)), (character) => character.charCodeAt(0)),
      );
      if (!mediaType) throw new Error("Unsupported image. Use PNG, JPEG, WebP, or GIF.");
      return { type: "image", mediaType, data };
    }),
  );
}

export async function readImagePaths(paths: string[]): Promise<ImageContent[]> {
  return nativeImageData(await invoke<string[]>("read_image_paths", { paths }));
}

export async function readClipboardImages(): Promise<ImageContent[]> {
  // Start the browser read inside the paste gesture, before any other asynchronous work.
  const items = await navigator.clipboard.read();
  const images: ImageContent[] = [];
  let bytes = 0;
  for (const item of items) {
    let added: ImageContent[] = [];
    const type = item.types.find((type) => imageMediaTypeSchema.safeParse(type).success);
    if (type) {
      const blob = await item.getType(type);
      if (bytes + blob.size > MAX_IMAGE_BYTES)
        throw new Error("Images must fit within 2 MiB per message.");
      added = await readImageFiles([new File([blob], "Clipboard image", { type })]);
    } else if (isTauri() && item.types.includes("text/uri-list")) {
      const uris = (await (await item.getType("text/uri-list")).text())
        .split(/\r?\n/)
        .map((uri) => uri.trim())
        .filter((uri) => uri.startsWith("file:"));
      if (uris.length) added = await readImagePaths(uris);
    } else if (item.types.some((type) => type.startsWith("image/"))) {
      throw new Error("Unsupported image. Use PNG, JPEG, WebP, or GIF.");
    }
    bytes += added.reduce((size, image) => size + imageByteLength(image.data), 0);
    if (bytes > MAX_IMAGE_BYTES) throw new Error("Images must fit within 2 MiB per message.");
    images.push(...added);
  }
  if (images.length === 0) throw new Error("Clipboard contains no supported image or image file.");
  return imageContentsSchema.parse(images);
}

/** WebKit can expose URI/image targets while withholding file bytes from paste events. */
export function needsClipboardRead(types: readonly string[], uriList = ""): boolean {
  // WebKit exposes URL text but withholds local file URIs. Preserve ordinary URL paste.
  const uris = uriList
    .split(/\r?\n/)
    .map((uri) => uri.trim())
    .filter((uri) => uri && !uri.startsWith("#"));
  if (uris.some((uri) => !/^file:/i.test(uri))) return false;
  return (
    types.length === 0 ||
    types.some(
      (type) =>
        type === "text/uri-list" ||
        type === "x-special/gnome-copied-files" ||
        type === "application/x-gnome-copied-files" ||
        type === "Files" ||
        type.startsWith("image/"),
    )
  );
}
