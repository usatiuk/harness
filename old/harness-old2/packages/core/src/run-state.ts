import type { JSONType } from "zod";

export function wasRunInterrupted(value: JSONType | undefined): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        value.interrupted === true
    );
}
