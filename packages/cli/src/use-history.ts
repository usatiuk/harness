import { useCallback, useRef } from "react";
import { addEntry, loadHistory, saveHistory } from "./history.ts";

export interface History {
  /**
   * Recall the previous (`dir = -1`) or next (`dir = 1`) entry relative to the
   * current position. `current` is the live text on screen; it is stashed at the
   * level being left so a round trip restores edits (zsh-style). Returns the text
   * to display, or `null` when there is nowhere to move.
   */
  recall: (dir: -1 | 1, current: string) => string | null;
  /** Record a submitted line and reset the navigation cursor to the live draft. */
  commit: (line: string) => void;
}

interface HistoryState {
  /** Oldest-first persisted prompts. */
  entries: string[];
  /** `entries.length` is the live draft; lower indices are recalled entries. */
  index: number;
  /** Per-level text cache so editing a recalled entry survives navigating away and back. */
  drafts: Map<number, string>;
}

export function useHistory(): History {
  const ref = useRef<HistoryState | null>(null);
  if (ref.current === null) {
    const entries = loadHistory();
    ref.current = { entries, index: entries.length, drafts: new Map() };
  }

  const recall = useCallback((dir: -1 | 1, current: string): string | null => {
    const st = ref.current!;
    const live = st.entries.length;
    const next = Math.max(0, Math.min(live, st.index + dir));
    if (next === st.index) return null;
    // Stash edits at the level we're leaving — only when actually moving, so a
    // no-op Up at the oldest entry can't overwrite it.
    st.drafts.set(st.index, current);
    st.index = next;
    if (st.drafts.has(next)) return st.drafts.get(next)!;
    return next === live ? "" : st.entries[next]!;
  }, []);

  const commit = useCallback((line: string): void => {
    const st = ref.current!;
    st.entries = addEntry(st.entries, line);
    saveHistory(st.entries);
    st.index = st.entries.length;
    st.drafts.clear();
  }, []);

  return { recall, commit };
}
