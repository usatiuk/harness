import { type ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import type { SandboxPhase } from "@harness/sandbox";

/** Imperative handles + state snapshot the overlay renders; actions report their result via notes. */
export interface SandboxView {
  /** Whether the sandbox is enabled in this conversation's config snapshot. */
  enabled: boolean;
  /** Whether this conversation is actually running on the Docker substrate right now. */
  active: boolean;
  /** Latest build/start phase, if any has been reported. */
  phase: SandboxPhase | undefined;
  /** Persist enable/disable and apply it live to this conversation. */
  setEnabled: (enabled: boolean) => void;
  /** Rebuild the live container (only when this conversation is sandboxed). */
  rebuild: () => void;
  /** Stop the live container (only when this conversation is sandboxed). */
  stop: () => void;
}

const yn = (b: boolean): string => (b ? "yes" : "no");

export function SandboxOverlay({
  view,
  onClose,
}: {
  view: SandboxView;
  onClose: () => void;
}): ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "q") return onClose();
    if (input === "e") view.setEnabled(!view.enabled);
    else if (input === "r") view.rebuild();
    else if (input === "s") view.stop();
  });

  return (
    <Box flexDirection="column">
      <Text bold>Sandbox</Text>
      <Text dimColor>{`enabled: ${yn(view.enabled)}`}</Text>
      <Text dimColor>{`this conversation sandboxed: ${yn(view.active)}`}</Text>
      <Text dimColor>{`phase: ${view.phase ?? "—"}`}</Text>
      <Text dimColor>enter the container: run `harness sandbox shell` in a terminal</Text>
      <Text dimColor>e toggle (live) · r rebuild · s stop · esc close</Text>
    </Box>
  );
}
