import {
  detectImageMediaType,
  errorResult,
  MAX_IMAGE_BYTES,
  type ToolResult,
} from "@harness/protocol";
import type { ExecutionContext } from "@harness/execution";

/** Both file-tool dialects read images through the same bounded execution boundary. */
export async function readImage(
  exec: ExecutionContext,
  path: string,
  hasLineRange: boolean,
): Promise<ToolResult | undefined> {
  const header = await exec.read(path, { offset: 0, length: 12 });
  const mediaType = detectImageMediaType(header);
  if (!mediaType) return undefined;
  if (hasLineRange) return errorResult("Images do not support line ranges; read the whole image.");
  const bytes = await exec.read(path, { offset: 0, length: MAX_IMAGE_BYTES + 1 });
  if (bytes.length > MAX_IMAGE_BYTES)
    return errorResult(`Image exceeds the ${MAX_IMAGE_BYTES}-byte limit.`);
  if (detectImageMediaType(bytes) !== mediaType)
    return errorResult("Image file is invalid or changed while reading.");
  return {
    status: "ok",
    forModel: [{ type: "image", mediaType, data: Buffer.from(bytes).toString("base64") }],
  };
}
