/** Exhaustiveness guard: an unhandled union member becomes a compile error here. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
