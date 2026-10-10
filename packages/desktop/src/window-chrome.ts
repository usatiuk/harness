import { invoke } from "@tauri-apps/api/core";

let modalOpacity: number | undefined;
let modalSyncing = false;

export async function syncWindowModal(): Promise<void> {
  if (document.documentElement.dataset.windowDecoration !== "macos") return;
  if (modalSyncing) return;
  modalSyncing = true;
  try {
    for (;;) {
      const opacity = document.querySelector('.overlay[data-state="open"]')
        ? Number(getComputedStyle(document.documentElement).getPropertyValue("--modal-opacity"))
        : 1;
      // Re-read after each native write: rapid open/close converges to current UI.
      if (opacity === modalOpacity) return;
      await invoke("window_modal", { opacity });
      modalOpacity = opacity;
    }
  } finally {
    modalSyncing = false;
  }
}

export async function initializeWindowChrome(onError: (cause: unknown) => Promise<void>) {
  document.documentElement.dataset.windowDecoration = await invoke<string>("window_decorate");
  if (document.documentElement.dataset.windowDecoration !== "macos") return () => {};
  await syncWindowModal();
  // Portals include nested confirmations. Native traffic lights sit outside HTML.
  const observer = new MutationObserver(() => {
    void syncWindowModal().catch(onError);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state"],
  });
  return () => observer.disconnect();
}
