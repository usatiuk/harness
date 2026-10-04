import { type ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import type { SandboxBackend, SandboxPhase } from "@harness/sandbox/client";

/** Imperative handles + state snapshot the overlay renders; actions report their result via notes. */
export interface SandboxView {
  /** Execution backend active for this loaded conversation. */
  backend: SandboxBackend;
  workspaceWrite: boolean;
  network: boolean;
  /** Whether a container is provisioned right now (vs. not yet started, or stopped). */
  containerActive: boolean;
  /** Latest build/start phase, if any has been reported. */
  phase: SandboxPhase | undefined;
  setBackend: (backend: SandboxBackend) => void;
  setWorkspaceWrite: (enabled: boolean) => void;
  setNetwork: (enabled: boolean) => void;
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
    if (input === "b") {
      const backends: SandboxBackend[] = ["local", "native", "docker"];
      const current = backends.indexOf(view.backend);
      view.setBackend(backends[(current + 1) % backends.length]!);
    } else if (input === "w") view.setWorkspaceWrite(!view.workspaceWrite);
    else if (input === "n") view.setNetwork(!view.network);
    else if (input === "r") view.rebuild();
    else if (input === "s") view.stop();
  });

  return (
    <Box flexDirection="column">
      <Text bold>Sandbox</Text>
      <Text dimColor>{`this conversation: ${view.backend}`}</Text>
      <Text dimColor>{`native workspace write: ${yn(view.workspaceWrite)}`}</Text>
      <Text dimColor>{`native network: ${yn(view.network)}`}</Text>
      <Text dimColor>{`Docker container running: ${yn(view.containerActive)}`}</Text>
      <Text dimColor>{`Docker phase: ${view.phase ?? "—"}`}</Text>
      <Text dimColor>Docker shell: run `harness sandbox shell` in a terminal</Text>
      <Text dimColor>
        b backend · w workspace write · n network · r rebuild · s stop · esc close
      </Text>
    </Box>
  );
}
