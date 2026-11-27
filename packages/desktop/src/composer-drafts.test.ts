import { expect, it, vi } from "vitest";
import { createInProcessMessageConnectionPair } from "@harness/client";
import type { ImageContent } from "@harness/protocol";
import { createComposerDrafts } from "./composer-drafts.ts";
import { DesktopSession } from "./session.ts";

it("keeps edits and delivery usable at storage quota until the text is durable again", async () => {
  const storage = new Map([["chat", "saved"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem(key: string, value: string) {
      if (value.length > 5) throw new DOMException("Full", "QuotaExceededError");
      storage.set(key, value);
    },
    removeItem: (key: string) => storage.delete(key),
  });
  try {
    const drafts = createComposerDrafts();
    const edit = (text: string) => drafts.updateDraft("chat", (draft) => ({ ...draft, text }));
    edit("too large to save");
    expect(drafts.getDraft("chat")).toMatchObject({ text: "too large to save", storageFull: true });
    expect(storage.get("chat")).toBe("saved");
    await drafts.submitDraft(
      "chat",
      async () => {
        throw new Error("Delivery rejected");
      },
      String,
    );
    expect(drafts.getDraft("chat")).toMatchObject({
      text: "too large to save",
      pending: null,
      storageFull: true,
    });
    edit("fits");
    expect(drafts.getDraft("chat").storageFull).toBe(false);
    expect(storage.get("chat")).toBe("fits");
    edit("another long input");
    const deliver = vi.fn().mockResolvedValue(undefined);
    await drafts.submitDraft("chat", deliver, String);
    expect(deliver).toHaveBeenCalledWith({ text: "another long input", images: [] });
    expect(drafts.getDraft("chat")).toMatchObject({ pending: null, storageFull: false });
    expect(storage.has("chat")).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("recovers a late delivery failure into the replacement session without touching another host's draft", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  try {
    const drafts = createComposerDrafts();
    const connect = (host: string) => {
      const session = new DesktopSession(createInProcessMessageConnectionPair().left, host);
      session.setServerScope("server");
      return session;
    };
    const original = connect("work");
    const key = original.storageKey("draft:chat");
    const image: ImageContent = { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" };
    drafts.updateDraft(key, (draft) => ({ ...draft, text: "first", images: [image] }));
    let lost!: (error: Error) => void;
    const pending = drafts.submitDraft(
      key,
      () =>
        new Promise<void>((_, reject) => {
          lost = reject;
        }),
      String,
    );
    original.disconnect("Disconnected");

    const otherKey = connect("personal").storageKey("draft:chat");
    drafts.updateDraft(otherKey, (draft) => ({ ...draft, text: "unrelated" }));
    const replacementKey = connect("work").storageKey("draft:chat");
    expect(drafts.getDraft(replacementKey).text).toBe("");
    drafts.updateDraft(replacementKey, (draft) => ({ ...draft, text: "second" }));
    lost(new Error("Unknown outcome"));
    await pending;

    expect(drafts.getDraft(replacementKey)).toMatchObject({
      text: "second",
      images: [],
      recoverable: [{ text: "first", images: [image] }],
    });
    drafts.restoreDraft(replacementKey);
    expect(drafts.getDraft(replacementKey)).toMatchObject({
      text: "first\n\nsecond",
      images: [image],
    });
    expect(drafts.getDraft(otherKey)).toMatchObject({
      text: "unrelated",
      images: [],
      recoverable: [],
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
