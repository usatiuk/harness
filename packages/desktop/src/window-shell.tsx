import { useEffect, type ReactNode } from "react";
import { Terminal } from "lucide-react";
import { initializeWindowAppearance } from "./appearance.ts";

export function WindowShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    let mounted = true;
    let dispose: (() => void) | undefined;
    void initializeWindowAppearance().then((cleanup) => {
      if (mounted) dispose = cleanup;
      else cleanup();
    });
    return () => {
      mounted = false;
      dispose?.();
    };
  }, []);
  return (
    <div className="window-shell">
      <header className="window-titlebar" data-window-chrome>
        <div className="window-drag-region" data-tauri-drag-region>
          <Terminal size={18} aria-hidden="true" pointerEvents="none" />
          <span data-tauri-drag-region>Harness</span>
        </div>
      </header>
      <div className="window-content">{children}</div>
    </div>
  );
}
