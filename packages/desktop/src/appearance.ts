import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";
import { initializeWindowChrome, syncWindowModal } from "./window-chrome.ts";
import {
  readAppearance,
  readComposer,
  type Appearance,
  type ComposerPreferences,
} from "./preferences.ts";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const nativeWindow = isTauri() ? getCurrentWindow() : undefined;
let appearance = readAppearance(
  localStorage.getItem("harness:appearance"),
  localStorage.getItem("theme"),
);
let composer = readComposer(localStorage.getItem("harness:composer"));
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => {
  for (const listener of listeners) listener();
};
function applyAppearance() {
  document.documentElement.dataset.theme =
    appearance.theme === "system" ? (media.matches ? "dark" : "light") : appearance.theme;
  document.documentElement.style.setProperty("--accent", appearance.accent);
  document.documentElement.style.setProperty("--edge", `${appearance.depth}px`);
  document.documentElement.style.setProperty("--control-radius", `${appearance.radius}px`);
}
function applyNativeTheme() {
  return nativeWindow?.setTheme(appearance.theme === "system" ? null : appearance.theme);
}
async function failWindowAppearance(cause: unknown): Promise<void> {
  if (!nativeWindow) throw cause;
  try {
    await message(cause instanceof Error ? cause.message : String(cause), {
      title: "Could not initialize window appearance",
      kind: "error",
    });
  } finally {
    // Closing uses the desktop's existing bridge/server shutdown path.
    await nativeWindow.close();
  }
}
export async function initializeWindowAppearance(): Promise<() => void> {
  if (!nativeWindow) return () => {};
  try {
    await applyNativeTheme();
    document.documentElement.dataset.nativeMaterial = String(
      await invoke<boolean>("window_material"),
    );
    const dispose = await initializeWindowChrome(failWindowAppearance);
    await nativeWindow.show();
    return dispose;
  } catch (cause) {
    await failWindowAppearance(cause);
    return () => {};
  }
}
export function setAppearance(value: Appearance): void {
  appearance = value;
  localStorage.setItem("harness:appearance", JSON.stringify(value));
  applyAppearance();
  void syncWindowModal().catch(failWindowAppearance);
  void applyNativeTheme()?.catch(failWindowAppearance);
  notify();
}
export function setComposerPreferences(value: ComposerPreferences): void {
  composer = value;
  localStorage.setItem("harness:composer", JSON.stringify(value));
  notify();
}
export const useAppearance = () => useSyncExternalStore(subscribe, () => appearance);
export const useComposerPreferences = () => useSyncExternalStore(subscribe, () => composer);
applyAppearance();
media.addEventListener("change", () => {
  if (appearance.theme === "system") {
    applyAppearance();
    void syncWindowModal().catch(failWindowAppearance);
  }
});
