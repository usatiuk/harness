import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { SandboxOverlay, type SandboxView } from "./sandbox-overlay.tsx";

const view = (): SandboxView => ({
  backend: "native",
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
  it("shows the active conversation backend without restart-pending state", () => {
    const state = view();
    const { lastFrame } = render(<SandboxOverlay view={state} onClose={() => {}} />);
    expect(lastFrame()).toContain("this conversation: native");
    expect(lastFrame()).not.toContain("restart");
  });

  it("cycles the active backend choice", () => {
    const state = view();
    const { stdin } = render(<SandboxOverlay view={state} onClose={() => {}} />);
    stdin.write("b");
    expect(state.setBackend).toHaveBeenCalledWith("docker");
  });
});
