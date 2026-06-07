import { randomUUID } from "node:crypto";

export const SOURCE_FIRST_MARKER = "core:src";

export const nowIso = (): string => new Date().toISOString();
export const createId = (prefix: string): string => `${prefix}_${randomUUID()}`;

export function compactObject<T extends Record<string, unknown>>(input: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}
