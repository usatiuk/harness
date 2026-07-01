import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { CommandContext } from "./commands.ts";
import type { History } from "./use-history.ts";
import { Composer } from "./composer.tsx";

// Drains scheduler ticks (setImmediate in Node) so React commits a keystroke's state before
// the next write's handler reads it; a bare setTimeout(0) can lose that race under load.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
// xterm escape sequences (ESC [ …).
const ESC = String.fromCharCode(27);
const UP = ESC + "[A";
const LEFT = ESC + "[D";
const FWD_DELETE = ESC + "[3~";

const ctx = {
  service: { availableModels: () => [{ provider: "openai", model: "gpt-5.1" }] },
  model: { provider: "openai", model: "gpt-5.1" },
  exit: vi.fn(),
} as unknown as CommandContext;

const fakeHistory = (recall: History["recall"]): History => ({
  recall,
  commit: vi.fn(),
});

const mount = (history: History, onSubmit = vi.fn(), onInterrupt = vi.fn()) => {
  const r = render(
    <Composer
      ctx={ctx}
      history={history}
      onSubmit={onSubmit}
      onMenuOpenChange={() => {}}
      onInterrupt={onInterrupt}
    />,
  );
  return { ...r, onSubmit, onInterrupt };
};

describe("Composer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the placeholder when empty", () => {
    const { lastFrame } = mount(fakeHistory(() => null));
    expect(lastFrame()).toContain("type a message");
  });

  it("opens the slash menu and filters as you type", async () => {
    const { stdin, lastFrame } = mount(fakeHistory(() => null));
    stdin.write("/mo");
    await flush();
    expect(lastFrame()).toContain("/model");
    expect(lastFrame()).toContain("switch model");
  });

  it("Tab completes the command and reveals its arguments", async () => {
    const { stdin, lastFrame } = mount(fakeHistory(() => null));
    stdin.write("/mo");
    await flush();
    stdin.write("\t");
    await flush();
    // Command completed (input shows "/model") and its argument menu is now open
    // (trailing whitespace is trimmed from the rendered frame).
    expect(lastFrame()).toContain("/model");
    expect(lastFrame()).toContain("openai/gpt-5.1");
  });

  it("recalls history with the up arrow when the menu is closed", async () => {
    const recall = vi.fn(() => "earlier prompt");
    const { stdin, lastFrame } = mount(fakeHistory(recall));
    stdin.write(UP);
    await flush();
    expect(recall).toHaveBeenCalledWith(-1, "");
    expect(lastFrame()).toContain("earlier prompt");
  });

  it("submits the typed line, records it, and clears the input", async () => {
    const onSubmit = vi.fn();
    const history = fakeHistory(() => null);
    const { stdin, lastFrame } = mount(history, onSubmit);
    stdin.write("hello");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("hello");
    expect(history.commit).toHaveBeenCalledWith("hello");
    expect(lastFrame()).toContain("type a message");
  });

  it("runs a fully-typed command+argument on a single Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin } = mount(
      fakeHistory(() => null),
      onSubmit,
    );
    stdin.write("/model openai/gpt-5.1");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("/model openai/gpt-5.1");
  });

  it("runs a bare completable command on Enter (does not just append a space)", async () => {
    const onSubmit = vi.fn();
    const { stdin } = mount(
      fakeHistory(() => null),
      onSubmit,
    );
    stdin.write("/model");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("/model");
  });

  it("forward-delete removes the character under the cursor", async () => {
    const { stdin, lastFrame } = mount(fakeHistory(() => null));
    stdin.write("abc");
    await flush();
    stdin.write(LEFT);
    await flush();
    stdin.write(LEFT);
    await flush();
    stdin.write(FWD_DELETE);
    await flush();
    expect(lastFrame()).toContain("ac");
    expect(lastFrame()).not.toContain("abc");
  });

  it("ignores a stray Tab when no menu is open", async () => {
    const { stdin, lastFrame } = mount(fakeHistory(() => null));
    stdin.write("hi");
    await flush();
    stdin.write("\t");
    await flush();
    // No tab character inserted; the line is unchanged.
    expect(lastFrame()).toContain("hi");
    expect(lastFrame()).not.toContain("\t");
  });

  it("Ctrl+C clears typed text", async () => {
    const { stdin, lastFrame } = mount(fakeHistory(() => null));
    stdin.write("hello");
    await flush();
    stdin.write("\x03"); // Ctrl+C
    await flush();
    expect(lastFrame()).toContain("type a message");
    expect(lastFrame()).not.toContain("hello");
  });

  it("Ctrl+C with an empty prompt interrupts the running turn", async () => {
    const onInterrupt = vi.fn();
    const { stdin } = mount(
      fakeHistory(() => null),
      vi.fn(),
      onInterrupt,
    );
    stdin.write("\x03"); // Ctrl+C, nothing typed
    await flush();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+D on an empty prompt exits", async () => {
    const { stdin } = mount(fakeHistory(() => null));
    stdin.write("\x04"); // Ctrl+D, nothing typed
    await flush();
    expect(ctx.exit).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+D with text forward-deletes instead of exiting", async () => {
    const { stdin, lastFrame } = mount(fakeHistory(() => null));
    stdin.write("abc");
    await flush();
    stdin.write(LEFT);
    await flush();
    stdin.write(LEFT);
    await flush();
    stdin.write("\x04"); // Ctrl+D forward-deletes under the cursor
    await flush();
    expect(lastFrame()).toContain("ac");
    expect(ctx.exit).not.toHaveBeenCalled();
  });
});
