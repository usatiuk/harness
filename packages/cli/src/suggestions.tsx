import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { Suggestion } from "./completion.ts";

/** Most rows shown at once; longer lists scroll a window around the active item. */
const WINDOW = 8;

/**
 * The completion menu: in-flow rows below the input (Ink has no absolute
 * positioning). Dumb view — selection/scroll state lives in the composer.
 */
export function Suggestions({
  items,
  activeIndex,
}: {
  items: Suggestion[];
  activeIndex: number;
}): ReactElement {
  // Window the list so the active row stays visible.
  const begin =
    items.length <= WINDOW
      ? 0
      : Math.max(0, Math.min(activeIndex - Math.floor(WINDOW / 2), items.length - WINDOW));
  const shown = items.slice(begin, begin + WINDOW);
  const width = Math.max(...shown.map((s) => s.label.length));
  return (
    <Box flexDirection="column">
      {begin > 0 ? <Text dimColor>{"  ▲"}</Text> : null}
      {shown.map((s, i) => {
        const active = begin + i === activeIndex;
        return (
          <Box key={s.value}>
            <Text inverse={active} {...(active ? {} : { color: "cyan" })}>
              {" " + s.label.padEnd(width) + " "}
            </Text>
            {s.summary ? <Text dimColor>{"  " + s.summary}</Text> : null}
          </Box>
        );
      })}
      {begin + WINDOW < items.length ? <Text dimColor>{"  ▼"}</Text> : null}
    </Box>
  );
}
