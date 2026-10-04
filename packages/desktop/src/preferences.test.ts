import { describe, expect, it } from "vitest";
import {
  composerKey,
  defaultAppearance,
  defaultComposer,
  readAppearance,
  readComposer,
} from "./preferences.ts";

describe("desktop client preferences", () => {
  it("retains the prior theme and validates saved appearance at its boundary", () => {
    expect(readAppearance(null, "dark")).toEqual({ ...defaultAppearance, theme: "dark" });
    expect(
      readAppearance('{"theme":"light","accent":"#00FF00","depth":2,"radius":8}', "dark"),
    ).toEqual({ theme: "light", accent: "#00FF00", depth: 2, radius: 8 });
    expect(
      readAppearance('{"theme":"other","accent":"red;bad","depth":-2,"radius":999}', "dark"),
    ).toEqual({ ...defaultAppearance, theme: "dark" });
    expect(readAppearance("broken", "invalid")).toEqual(defaultAppearance);
    expect(readComposer('{"sendWith":"Shift+Enter","delivery":"steer","showStats":true}')).toEqual({
      sendWith: "Shift+Enter",
      delivery: "steer",
      showStats: true,
    });
  });
  it("maps send, newline and alternate delivery without intercepting composition", () => {
    const enter = {
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
    };
    expect(composerKey(enter, defaultComposer, false)).toBe("send");
    expect(composerKey({ ...enter, shiftKey: true }, defaultComposer, false)).toBe("newline");
    expect(composerKey(enter, defaultComposer, true)).toBe("queue");
    expect(composerKey({ ...enter, ctrlKey: true }, defaultComposer, true)).toBe("steer");
    const swapped = {
      ...defaultComposer,
      sendWith: "Shift+Enter" as const,
      delivery: "steer" as const,
    };
    expect(composerKey(enter, swapped, true)).toBe("newline");
    expect(composerKey({ ...enter, shiftKey: true }, swapped, true)).toBe("steer");
    expect(composerKey({ ...enter, metaKey: true }, swapped, true)).toBe("queue");
    for (const event of [
      { ...enter, isComposing: true },
      { ...enter, altKey: true },
      { ...enter, ctrlKey: true, shiftKey: true },
      { ...enter, key: "a" },
    ])
      expect(composerKey(event, swapped, true)).toBeUndefined();
  });
});
