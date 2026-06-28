import { type ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import type { SandboxPhase } from "@harness/sandbox";

/** Imperative handles + state snapshot the overlay renders; actions report their result via notes. */
export interface SandboxView {
  /** Whether this conversation runs in the dev-container sandbox (resolved config; fixed this session). */
  enabled: boolean;
  /** Whether a container is provisioned right now (vs. not yet started, or stopped). */
  active: boolean;
  /** Latest build/start phase, if any has been reported. */
  phase: SandboxPhase | undefined;
  /** Persist enable/disable to project-local settings; applies to new conversations and on resume. */
  setEnabled: (enabled: boolean) => void;
  /** Tear down the container so the next message rebuilds it (only meaningful when sandboxed). */
  rebuild: () => void;
  /** Tear down this workspace's container now. */
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
      <Text dimColor>{`this conversation sandboxed: ${yn(view.enabled)}`}</Text>
      <Text dimColor>{`container running: ${yn(view.active)}`}</Text>
      <Text dimColor>{`phase: ${view.phase ?? "—"}`}</Text>
      <Text dimColor>enter the container: run `harness sandbox shell` in a terminal</Text>
      <Text dimColor>e toggle (new conversations) · r rebuild · s stop · esc close</Text>
    </Box>
  );
}
