import type { ContentBlock, JsonValue } from "@harness/protocol";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordFromJson(value: JsonValue | undefined): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function renderContentBlocks(blocks: ContentBlock[]): string {
  return blocks.map((block) => block.type === "text" ? block.text : JSON.stringify(block.data)).filter((text) => text.length > 0).join("\n");
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function compactStringRecord(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Record<string, string>;
}
