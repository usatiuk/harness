import { imageContentSchema, MAX_IMAGE_BYTES, type ImageContent } from "@harness/protocol";

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
