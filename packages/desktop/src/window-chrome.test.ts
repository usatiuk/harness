import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function windowDocument() {
  const state = { open: false };
  vi.stubGlobal("document", {
    documentElement: { dataset: { windowDecoration: "macos" } },
    querySelector: () => (state.open ? {} : null),
  });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "0.5" }));
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.resetModules();
});

test("a new document restores controls dimmed by the previous document", async () => {
  windowDocument();
  let nativeOpacity = 0.5;
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    nativeOpacity = (args as { opacity: number }).opacity;
  });
  const { syncWindowModal } = await import("./window-chrome.ts");
  await syncWindowModal();
  expect(nativeOpacity).toBe(1);
});

test("closing a modal during a native write converges to the current window", async () => {
  const document = windowDocument();
  document.open = true;
  let nativeOpacity = 1;
  let startWrite!: () => void;
  let finishWrite!: () => void;
  const entered = new Promise<void>((resolve) => {
    startWrite = resolve;
  });
  const release = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { opacity } = args as { opacity: number };
    if (opacity === 0.5) {
      startWrite();
      await release;
    }
    nativeOpacity = opacity;
  });
  const { syncWindowModal } = await import("./window-chrome.ts");
  const pending = syncWindowModal();
  await entered;
  document.open = false;
  await syncWindowModal();
  finishWrite();
  await pending;
  expect(nativeOpacity).toBe(1);
});
