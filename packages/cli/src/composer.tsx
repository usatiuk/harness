import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import type { CommandContext } from "./commands.ts";
import { complete, slashCompletion, type CompletionProvider } from "./completion.ts";
import { Suggestions } from "./suggestions.tsx";
import type { History } from "./use-history.ts";

const PLACEHOLDER = "type a message… · /help · Esc abort";

// Completion sources, tried in order; first non-null wins.
const PROVIDERS: CompletionProvider[] = [slashCompletion];

export interface ComposerProps {
  /** Slash completion reads candidates (models, presets) through this. */
  ctx: CommandContext;
  history: History;
  onSubmit: (value: string) => void;
  /** Lets the app suppress its own Esc handling while the menu owns Esc. */
  onMenuOpenChange: (open: boolean) => void;
  /** Ctrl+C with an empty prompt interrupts the running turn. */
  onInterrupt: () => void;
  initialValue?: string;
  onValueChange?: (value: string) => void;
}

/**
 * Controlled single-line input. One keypress handler with an explicit precedence:
 * an open completion menu steals navigation/accept keys, otherwise the arrows
 * browse history; editing keys are always handled.
 */
export function Composer({
  ctx,
  history,
  onSubmit,
  onMenuOpenChange,
  onInterrupt,
  initialValue = "",
  onValueChange,
}: ComposerProps): ReactElement {
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);
  useEffect(() => {
    onValueChange?.(value);
  }, [value, onValueChange]);
  const [active, setActive] = useState(0);
  // Suppresses the menu after history-nav/Esc; cleared on the next printable key.
  const [suppress, setSuppress] = useState(false);

  const menu = useMemo(
    () => (suppress ? null : complete(PROVIDERS, value, cursor, ctx)),
    [suppress, value, cursor, ctx],
  );
  const open = !!menu && menu.items.length > 0;
  const activeIdx = open ? Math.min(active, menu.items.length - 1) : 0;

  // Report menu state up so App's Esc closes the menu before interrupting. The
  // cleanup resets the flag when this composer unmounts (e.g. a pending approval
  // replaces it), so Esc still interrupts there instead of being swallowed.
  useEffect(() => {
    onMenuOpenChange(open);
    return () => onMenuOpenChange(false);
  }, [open, onMenuOpenChange]);

  const reset = (): void => {
    setValue("");
    setCursor(0);
    setActive(0);
    setSuppress(false);
  };

  const accept = (): void => {
    if (!menu) return;
    const s = menu.items[activeIdx]!;
    const tail = s.appendSpace ? " " : "";
    setValue(value.slice(0, menu.range[0]) + s.value + tail + value.slice(menu.range[1]));
    setCursor(menu.range[0] + s.value.length + tail.length);
    setActive(0);
    // Not suppressed: completing "/model " opens its argument menu next.
  };

  const submit = (): void => {
    onSubmit(value);
    history.commit(value);
    reset();
  };

  useInput((input, key) => {
    if (key.ctrl && input === "g") return;
    // Ctrl+C clears the prompt (interrupts when empty); Ctrl+D quits when empty, else
    // forward-deletes. Both bypass the menu/history/edit precedence below.
    if (key.ctrl && input === "c") {
      if (value !== "") reset();
      else onInterrupt();
      return;
    }
    if (key.ctrl && input === "d") {
      if (value === "") ctx.exit();
      else if (cursor < value.length) {
        setValue(value.slice(0, cursor) + value.slice(cursor + 1));
        setSuppress(false);
      }
      return;
    }

    // Enter arrives as '\r' (return) or '\n' (LF: pasted newline / some terminals).
    const isSubmit = key.return || input === "\n" || input === "\r";

    // 1. Menu open: it owns navigation/accept; editing keys fall through to (3).
    if (open) {
      const n = menu.items.length;
      if (key.upArrow) return setActive((activeIdx - 1 + n) % n);
      if (key.downArrow) return setActive((activeIdx + 1) % n);
      if (key.tab) return accept();
      if (isSubmit) {
        // Already-fully-typed suggestion → run it; otherwise complete first.
        const typed = value.slice(menu.range[0], menu.range[1]);
        return typed === menu.items[activeIdx]!.value ? submit() : accept();
      }
      if (key.escape) return setSuppress(true);
    }

    // 2. Menu closed: arrows browse history; Enter submits. (Esc → app interrupts.)
    if (!open) {
      if (key.upArrow || key.downArrow) {
        const next = history.recall(key.upArrow ? -1 : 1, value);
        if (next !== null) {
          setValue(next);
          setCursor(next.length);
          setSuppress(true);
        }
        return;
      }
      if (isSubmit) return submit();
    }

    // 3. Editing — reachable whether or not the menu is open.
    if (key.leftArrow) return setCursor(Math.max(0, cursor - 1));
    if (key.rightArrow) return setCursor(Math.min(value.length, cursor + 1));
    if (key.ctrl && input === "a") return setCursor(0);
    if (key.ctrl && input === "e") return setCursor(value.length);
    if (key.ctrl && input === "u") {
      setValue(value.slice(cursor));
      setCursor(0);
      return setSuppress(false);
    }
    if (key.backspace) {
      if (cursor > 0) {
        setValue(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
        setSuppress(false);
      }
      return;
    }
    if (key.delete) {
      // Forward delete removes the char under the cursor, not the one before it.
      if (cursor < value.length) {
        setValue(value.slice(0, cursor) + value.slice(cursor + 1));
        setSuppress(false);
      }
      return;
    }
    // Insert printable text; skip Tab (handled above when a menu is open) and flatten
    // a pasted multi-line block to one line.
    if (input && !key.ctrl && !key.meta && !key.tab) {
      const text = input.replace(/[\r\n\t]/g, " ");
      if (text) {
        setValue(value.slice(0, cursor) + text + value.slice(cursor));
        setCursor(cursor + text.length);
        setSuppress(false);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{"› "}</Text>
        <InputLine value={value} cursor={cursor} />
      </Box>
      {open ? <Suggestions items={menu.items} activeIndex={activeIdx} /> : null}
    </Box>
  );
}

/** Renders the line with a block cursor (inverse char, or a trailing inverse space). */
function InputLine({ value, cursor }: { value: string; cursor: number }): ReactElement {
  if (value.length === 0) return <Text dimColor>{PLACEHOLDER}</Text>;
  const at = value.slice(cursor, cursor + 1);
  return (
    <Text>
      {value.slice(0, cursor)}
      <Text inverse>{at.length > 0 ? at : " "}</Text>
      {value.slice(cursor + 1)}
    </Text>
  );
}
