import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { SandboxOverlay, type SandboxView } from "./sandbox-overlay.tsx";

const view = (): SandboxView => ({
  activeBackend: "local",
  configuredBackend: "native",
  workspaceWrite: true,
  network: false,
  containerActive: false,
  phase: undefined,
  setBackend: vi.fn(),
  setWorkspaceWrite: vi.fn(),
  setNetwork: vi.fn(),
  rebuild: vi.fn(),
  stop: vi.fn(),
});

describe("SandboxOverlay", () => {
  it("distinguishes the running backend from restart-pending configuration", () => {
    const state = view();
    const { lastFrame } = render(<SandboxOverlay view={state} onClose={() => {}} />);
    expect(lastFrame()).toContain("this conversation: local");
    expect(lastFrame()).toContain("configured after restart: native");
    expect(lastFrame()).toContain("configuration changes require restarting Harness");
  });

  it("cycles the configured backend without claiming to switch the running backend", () => {
    const state = view();
    const { stdin } = render(<SandboxOverlay view={state} onClose={() => {}} />);
    stdin.write("b");
    expect(state.setBackend).toHaveBeenCalledWith("docker");
  });
});
