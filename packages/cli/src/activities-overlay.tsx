import { useEffect, useState, type ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { textOf, type ContentBlock } from "@harness/protocol";
import type { ActivityLine } from "./transcript-reducer.ts";
import { indent } from "./cells.tsx";

/** The live handles the overlay needs that the event stream can't carry: output and kill. */
export interface ActivitiesView {
  peek(id: string): ContentBlock[] | Promise<ContentBlock[]>;
  kill(id: string): void | Promise<void>;
}

const PREVIEW_LINES = 12;
const POLL_MS = 250;

/** Last `n` non-empty-trailing lines of the selected activity's output. */
const tail = (text: string, n: number): string => {
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
};

function statusLabel(a: ActivityLine): string {
  if (a.status === undefined) return "running";
  return a.status === "ok" ? "✓" : "✗";
}

/** Unfolds the selected activity's output inline, polled since output is not evented. */
export function ActivitiesOverlay({
  activities,
  view,
  onClose,
}: {
  activities: ActivityLine[];
  view: ActivitiesView;
  onClose: () => void;
}): ReactElement {
  const [selected, setSelected] = useState(0);
  const [preview, setPreview] = useState("");
  const index = Math.max(0, Math.min(selected, activities.length - 1));
  const current = activities[index];

  // `index` is already clamped, so step from it and let the next render re-clamp.
  useInput((input, key) => {
    if (key.escape || input === "q") return onClose();
    if (key.upArrow) setSelected(Math.max(0, index - 1));
    else if (key.downArrow) setSelected(Math.min(activities.length - 1, index + 1));
    else if (input === "x" && current) void view.kill(current.id);
  });

  // Peek is a bounded request. Poll only while the selected activity is running.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const content = current ? await view.peek(current.id) : [];
        if (active) setPreview(textOf(content));
      } catch (error) {
        if (active) setPreview(`error: ${String(error)}`);
      } finally {
        if (active && current?.status === undefined) {
          timer = setTimeout(() => void refresh(), POLL_MS);
        }
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [current, view]);

  if (activities.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Activities</Text>
        <Text dimColor>no activities</Text>
        <Text dimColor>esc close</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>{`Activities (${activities.length})`}</Text>
      {activities.map((a, i) => {
        const on = i === index;
        return (
          <Box key={a.id} flexDirection="column">
            <Text {...(on ? { color: "cyan" } : { dimColor: true })}>
              {`${on ? "›" : " "} ${a.id}  ${statusLabel(a)}  ${a.summary ?? a.title}`}
            </Text>
            {on && preview ? <Text dimColor>{indent(tail(preview, PREVIEW_LINES))}</Text> : null}
          </Box>
        );
      })}
      <Text dimColor>↑↓ select · x kill · esc close</Text>
    </Box>
  );
}
