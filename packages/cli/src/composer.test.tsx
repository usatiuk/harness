import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { CommandContext } from "./commands.ts";
import type { History } from "./use-history.ts";
import { Composer } from "./composer.tsx";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// xterm escape sequences (ESC [ …).
const ESC = String.fromCharCode(27);
const UP = ESC + "[A";
const LEFT = ESC + "[D";
const FWD_DELETE = ESC + "[3~";

const ctx = {
  service: { availableModels: () => [{ provider: "openai", model: "gpt-5.1" }] },
  model: { provider: "openai", model: "gpt-5.1" },
} as unknown as CommandContext;

const fakeHistory = (recall: History["recall"]): History => ({
  recall,
  commit: vi.fn(),
});

const mount = (history: History, onSubmit = vi.fn()) => {
  const r = render(
    <Composer ctx={ctx} history={history} onSubmit={onSubmit} onMenuOpenChange={() => {}} />,
  );
  return { ...r, onSubmit };
};

describe("Composer", () => {
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
});
