import { describe, expect, it } from "vitest";
import {
  composerKey,
  defaultAppearance,
  defaultComposer,
  defaultDiff,
  readAppearance,
  readComposer,
  readDiff,
} from "./preferences.ts";

describe("desktop client preferences", () => {
  it("retains the prior theme and validates saved appearance at its boundary", () => {
    expect(readAppearance(null, "dark")).toEqual({ ...defaultAppearance, theme: "dark" });
    expect(
      readAppearance('{"theme":"light","accent":"#00FF00","depth":2,"radius":8}', "dark"),
    ).toEqual({ theme: "light", accent: "#00FF00", depth: 2, radius: 8, conversationFontSize: 14 });
    expect(
      readAppearance('{"theme":"other","accent":"red;bad","depth":-2,"radius":999}', "dark"),
    ).toEqual({ ...defaultAppearance, theme: "dark" });
    expect(readAppearance("broken", "invalid")).toEqual(defaultAppearance);
    expect(readComposer('{"sendWith":"Shift+Enter","delivery":"steer","showStats":true}')).toEqual({
      sendWith: "Shift+Enter",
      showStats: true,
    });
    expect(readComposer('{"delivery":"queue"}')).toEqual(defaultComposer);
  });
  it("validates saved conversation text sizes", () => {
    expect(readAppearance('{"conversationFontSize":16}', null).conversationFontSize).toBe(16);
    for (const value of [0, 19, 13.5, "16"])
      expect(
        readAppearance(JSON.stringify({ conversationFontSize: value }), null).conversationFontSize,
      ).toBe(14);
  });
  it("validates persisted diff display preferences independently", () => {
    expect(readDiff(null)).toEqual(defaultDiff);
    expect(readDiff('{"wordWrap":false,"lineNumbers":false}')).toEqual({
      wordWrap: false,
      lineNumbers: false,
    });
    expect(readDiff('{"wordWrap":true,"lineNumbers":"false"}')).toEqual(defaultDiff);
    expect(readDiff('{"wordWrap":0,"lineNumbers":false}')).toEqual({
      wordWrap: true,
      lineNumbers: false,
    });
    for (const raw of ["broken", "[]", "null"]) expect(readDiff(raw)).toEqual(defaultDiff);
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
    expect(composerKey(enter, defaultComposer, true)).toBe("steer");
    expect(composerKey({ ...enter, ctrlKey: true }, defaultComposer, true)).toBe("queue");
    const swapped = {
      ...defaultComposer,
      sendWith: "Shift+Enter" as const,
    };
    expect(composerKey(enter, swapped, true)).toBe("newline");
    expect(composerKey({ ...enter, shiftKey: true }, swapped, true)).toBe("steer");
    expect(composerKey({ ...enter, metaKey: true }, swapped, true)).toBe("queue");
    for (const modifier of ["ctrlKey", "metaKey"])
      expect(
        composerKey({ ...enter, key: ".", [modifier]: true }, defaultComposer, true),
      ).toBeUndefined();
    const escape = { ...enter, key: "Escape" };
    expect(composerKey(escape, defaultComposer, true)).toBe("interrupt");
    expect(composerKey(escape, swapped, true)).toBe("interrupt");
    expect(composerKey(escape, defaultComposer, false)).toBeUndefined();
    for (const modifier of ["isComposing", "altKey", "ctrlKey", "metaKey", "shiftKey"])
      expect(composerKey({ ...escape, [modifier]: true }, defaultComposer, true)).toBeUndefined();
    for (const event of [
      { ...enter, isComposing: true },
      { ...enter, altKey: true },
      { ...enter, ctrlKey: true, shiftKey: true },
      { ...enter, key: "a" },
    ])
      expect(composerKey(event, swapped, true)).toBeUndefined();
  });
});
