import { useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Button } from "../ui.tsx";

export function DesktopUpdates() {
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  if (!isTauri()) return null;
  async function update(install: boolean) {
    setBusy(true);
    setNotice("");
    try {
      const available = await invoke<string | null>("desktop_update", {
        version: install ? version : null,
      });
      setVersion(available);
      setNotice(
        install
          ? "Restarting after update…"
          : available
            ? `Version ${available} is available.`
            : "Harness is up to date.",
      );
    } catch (cause) {
      setVersion(null);
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="storage-location">
      <h3>Desktop updates</h3>
      <p className="muted">Installing an update restarts Harness.</p>
      <div className="button-row">
        <Button loading={busy} onClick={() => void update(false)}>
          Check for updates
        </Button>
        {version && (
          <Button disabled={busy} onClick={() => void update(true)}>
            Install {version} and restart
          </Button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
