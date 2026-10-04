export type ThemePreference = "system" | "light" | "dark";
export const accents = [
  ["Lilac", "#c8b8e8"],
  ["Sage", "#b6cdb4"],
  ["Powder blue", "#aecae7"],
  ["Peach", "#eac1aa"],
  ["Butter", "#e2d598"],
  ["Rose", "#dfb9c7"],
] as const;
export interface Appearance {
  theme: ThemePreference;
  accent: string;
  depth: number;
  radius: number;
}
export interface ComposerPreferences {
  sendWith: "Enter" | "Shift+Enter";
  delivery: "queue" | "steer";
  showStats: boolean;
}
export const defaultAppearance: Appearance = {
  theme: "system",
  accent: accents[0][1],
  depth: 3,
  radius: 9,
};
export const defaultComposer: ComposerPreferences = {
  sendWith: "Enter",
  delivery: "queue",
  showStats: false,
};

function storedObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
const isTheme = (value: unknown): value is ThemePreference =>
  value === "system" || value === "light" || value === "dark";
export function readAppearance(raw: string | null, legacyTheme: string | null): Appearance {
  const value = storedObject(raw);
  return {
    theme: isTheme(value.theme)
      ? value.theme
      : isTheme(legacyTheme)
        ? legacyTheme
        : defaultAppearance.theme,
    accent:
      typeof value.accent === "string" && /^#[0-9a-f]{6}$/iu.test(value.accent)
        ? value.accent
        : defaultAppearance.accent,
    depth:
      typeof value.depth === "number" &&
      Number.isInteger(value.depth) &&
      value.depth >= 1 &&
      value.depth <= 5
        ? value.depth
        : defaultAppearance.depth,
    radius:
      typeof value.radius === "number" &&
      Number.isInteger(value.radius) &&
      value.radius >= 5 &&
      value.radius <= 14
        ? value.radius
        : defaultAppearance.radius,
  };
}
export function readComposer(raw: string | null): ComposerPreferences {
  const value = storedObject(raw);
  return {
    sendWith: value.sendWith === "Shift+Enter" ? "Shift+Enter" : "Enter",
    delivery: value.delivery === "steer" ? "steer" : "queue",
    showStats: typeof value.showStats === "boolean" ? value.showStats : defaultComposer.showStats,
  };
}
/** Only textarea Enter is handled; composition and unrelated modifiers stay native. */
export function composerKey(
  event: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    isComposing: boolean;
  },
  preferences: ComposerPreferences,
  running: boolean,
): "newline" | "send" | "queue" | "steer" | undefined {
  if (event.key !== "Enter" || event.isComposing || event.altKey) return undefined;
  if (event.ctrlKey || event.metaKey) {
    if (event.shiftKey) return undefined;
    return running ? (preferences.delivery === "queue" ? "steer" : "queue") : "send";
  }
  const send = preferences.sendWith === "Shift+Enter" ? event.shiftKey : !event.shiftKey;
  return send ? (running ? preferences.delivery : "send") : "newline";
}
