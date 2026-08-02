const lineOf = (error: Error): string => {
  const code = (error as Error & { code?: unknown }).code;
  return `${error.name}: ${error.message}${typeof code === "string" ? ` [${code}]` : ""}`;
};

/** Renders the useful SDK error cause chain without dumping stacks or request bodies. */
export function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const lines = [lineOf(error)];
  const seen = new Set<Error>([error]);
  let cause = error.cause;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    lines.push(`Caused by: ${lineOf(cause)}`);
    cause = cause.cause;
  }
  return lines.join("\n");
}
