import { imageContentsSchema, type ImageContent } from "@harness/protocol";

interface Content {
  text: string;
  images: ImageContent[];
}

interface Draft extends Content {
  storageFull: boolean;
  reading: number;
  error: string;
  pending: Content | null;
  deliveryError: string;
  recoverable: Content[];
}

export type ComposerDrafts = ReturnType<typeof createComposerDrafts>;

// A submission belongs to a host/conversation even if disconnect replaces its session router.
// Only text is persisted, as before; image data never enters localStorage.
export function createComposerDrafts() {
  const drafts = new Map<string, Draft>();
  const listeners = new Set<() => void>();
  const empty: Draft = {
    text: "",
    images: [],
    storageFull: false,
    reading: 0,
    error: "",
    pending: null,
    deliveryError: "",
    recoverable: [],
  };
  function subscribeDrafts(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  function getDraft(key: string): Draft {
    let draft = drafts.get(key);
    if (!draft) {
      const text = localStorage.getItem(key);
      if (!text) return empty;
      draft = { ...empty, text };
      drafts.set(key, draft);
    }
    return draft;
  }
  function updateDraft(key: string, update: (current: Draft) => Draft) {
    const previous = getDraft(key);
    let next = update(previous);
    // While the editor is clear, retain the submitted text on disk until acknowledgement.
    const persisted = next.text || next.pending?.text || "";
    if (persisted !== (previous.text || previous.pending?.text || "")) {
      try {
        if (persisted) localStorage.setItem(key, persisted);
        else localStorage.removeItem(key);
        if (next.storageFull) next = { ...next, storageFull: false };
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === "QuotaExceededError")) throw cause;
        next = { ...next, storageFull: true };
      }
    }
    if (
      !persisted &&
      !next.storageFull &&
      !next.pending &&
      !next.images.length &&
      !next.reading &&
      !next.error &&
      !next.deliveryError &&
      !next.recoverable.length
    )
      drafts.delete(key);
    else drafts.set(key, next);
    for (const listener of listeners) listener();
  }

  async function submitDraft(
    key: string,
    deliver: (input: Content) => Promise<void>,
    describeFailure: (error: unknown) => string,
  ) {
    const draft = getDraft(key);
    if (draft.pending || draft.reading || (!draft.text.trim() && !draft.images.length)) return;
    const sent = { text: draft.text, images: draft.images };
    updateDraft(key, (current) => ({
      ...current,
      text: "",
      images: [],
      error: "",
      deliveryError: "",
      pending: sent,
    }));
    try {
      await deliver(sent);
    } catch (error) {
      updateDraft(key, (current) => ({
        ...current,
        ...(current.text || current.images.length || current.reading
          ? { recoverable: [sent, ...current.recoverable] }
          : sent),
        deliveryError: describeFailure(error),
        pending: null,
      }));
      return;
    }
    updateDraft(key, (current) => ({ ...current, pending: null }));
  }

  function restoreDraft(key: string) {
    updateDraft(key, (current) => {
      const [previous, ...rest] = current.recoverable;
      if (!previous) throw new Error("No previous draft to restore");
      const images = [...previous.images, ...current.images];
      if (!imageContentsSchema.safeParse(images).success)
        return {
          ...current,
          error:
            "Send or remove attachments from the current draft before restoring the previous draft.",
        };
      return {
        ...current,
        text: [previous.text, current.text].filter(Boolean).join("\n\n"),
        images,
        recoverable: rest,
        error: "",
      };
    });
  }

  return { getDraft, updateDraft, subscribeDrafts, submitDraft, restoreDraft };
}
