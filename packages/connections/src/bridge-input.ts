import type { Writable } from "node:stream";
import { MAX_RPC_WRITER_QUEUE_BYTES } from "@harness/protocol";

/** Keep reading EOF even when the receiver stops reading protocol bytes. */
export function forwardBridgeInput(
  target: Writable,
  ended: () => void,
  failed: (error: Error) => void,
): () => void {
  const data = (chunk: Buffer) => {
    if (target.writableLength + chunk.byteLength > MAX_RPC_WRITER_QUEUE_BYTES) {
      failed(new Error("Bridge writer queue is full"));
      return;
    }
    target.write(chunk);
  };
  process.stdin.on("data", data);
  process.stdin.once("end", ended);
  process.stdin.once("error", failed);
  return () => {
    process.stdin.off("data", data);
    process.stdin.off("end", ended);
    process.stdin.off("error", failed);
    process.stdin.destroy();
  };
}
