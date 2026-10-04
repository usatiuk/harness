import { useSyncExternalStore } from "react";
import {
  readAppearance,
  readComposer,
  type Appearance,
  type ComposerPreferences,
} from "./preferences.ts";

const media = window.matchMedia("(prefers-color-scheme: dark)");
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
export function setAppearance(value: Appearance): void {
  appearance = value;
  localStorage.setItem("harness:appearance", JSON.stringify(value));
  applyAppearance();
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
  if (appearance.theme === "system") applyAppearance();
});
