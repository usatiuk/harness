import type { ContentBlock } from "@harness/protocol";
import type { JSONType } from "zod";

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordFromJson(
    value: JSONType | undefined,
): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

export function renderContentBlocks(blocks: ContentBlock[]): string {
    return blocks
        .map((block) =>
            block.type === "text" ? block.text : JSON.stringify(block.data),
        )
        .filter((text) => text.length > 0)
        .join("\n");
}

export function compactRecord(
    input: Record<string, unknown>,
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
    );
}

export function compactStringRecord(
    input: Record<string, string | undefined>,
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
}
