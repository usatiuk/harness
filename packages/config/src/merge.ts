function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelSelection(value: Record<string, unknown>): boolean {
  return (
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    Object.keys(value).every((key) => key === "provider" || key === "model" || key === "preset")
  );
}

/**
 * Deep-merges config layers: plain objects merge recursively (id-keyed maps union,
 * later keys win); arrays and scalars replace wholesale.
 */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  // A preset is scoped to one provider/model identity. Any complete selection is an atomic
  // replacement wherever it appears (top-level, named profiles, or plugin-owned reviewer config).
  if (isModelSelection(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}
