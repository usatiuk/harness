import type { JsonValue } from "@harness/protocol";

export function wasRunInterrupted(value: JsonValue | undefined): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.interrupted === true;
}
