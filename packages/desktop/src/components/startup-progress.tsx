import { useEffect, useState, type ReactNode } from "react";
import type { StartupProgress as ProgressEvent } from "@harness/connections";
import { invoke } from "@tauri-apps/api/core";
import { Button, Input } from "../ui.tsx";
import { sessionLimitKey, sessionTimeoutSeconds, type StartupAttempt } from "../startup.ts";

export function DesktopTimeoutField() {
  return (
    <label>
      Desktop session startup (seconds)
      <Input
        type="number"
        min="0.001"
        step="any"
        max="2147478"
        defaultValue={sessionTimeoutSeconds()}
        required
        onBlur={({ currentTarget: input }) => {
          if (input.reportValidity()) localStorage.setItem(sessionLimitKey, input.value);
        }}
      />
      <small>Starts when the host is ready. Applies to connections from this desktop.</small>
    </label>
  );
}

export function StartupDetails({
  attempt,
  children,
}: {
  attempt: StartupAttempt | undefined;
  children?: ReactNode;
}) {
  if (!attempt?.steps.length) return null;
  return (
    <details>
      <summary>Startup details</summary>
      <ol>
        {attempt.steps.map((s, i) => (
          <li key={i}>
            {s.message} ·{" "}
            {s.end === undefined ? "In progress" : `${((s.end - s.start) / 1000).toFixed(1)} s`}
          </li>
        ))}
      </ol>
      {children}
    </details>
  );
}
function progressLabel({ completed, total, bytesPerSecond }: ProgressEvent) {
  if (completed === undefined || total === undefined) return;
  if (bytesPerSecond === undefined) return `${completed}/${total} finished`;
  const mib = (bytes: number) => (bytes / 1048576).toFixed(1);
  return `${Math.floor((100 * completed) / total)}% · ${mib(completed)} / ${mib(total)} MiB · ${mib(bytesPerSecond)} MiB/s`;
}

export function StartupProgress({
  attempt,
  host,
  settingsLocation,
  busy,
  error,
  cancel,
  retry,
}: {
  attempt: StartupAttempt;
  host: string;
  settingsLocation: string | undefined;
  busy: boolean;
  error: string | undefined;
  cancel: () => void;
  retry: () => void;
}) {
  const [revealError, setRevealError] = useState<string>();
  const [now, tick] = useState(() => performance.now());
  useEffect(() => {
    if (busy) {
      const timer = setInterval(() => tick(performance.now()), 500);
      return () => clearInterval(timer);
    }
  }, [busy]);
  const current = attempt.steps.at(-1);
  const progress = current?.progress;
  const completed = busy ? progress?.completed : 0;
  const total = progress?.total ?? 1;
  return (
    <section className="connection-empty-state startup-card">
      <h1>{host} connection</h1>
      <div
        className="startup-track"
        role="progressbar"
        aria-label="Startup progress"
        aria-valuemin={0}
        aria-valuenow={completed}
        aria-valuemax={total}
      >
        <span
          style={completed === undefined ? undefined : { width: `${(completed / total) * 100}%` }}
        />
      </div>
      <p role="status">
        {busy
          ? [
              current?.message ?? "Reading connection settings",
              progress && progressLabel(progress),
              current && `${Math.max(0, Math.floor((now - current.start) / 1000))} s`,
            ]
              .filter(Boolean)
              .join(" · ")
          : "Disconnected"}
      </p>
      <Button onClick={busy ? cancel : retry}>
        {busy ? "Cancel connection" : error ? "Retry" : "Reconnect"}
      </Button>
      <div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <StartupDetails attempt={attempt} />
        {error &&
          /host startup timed out|shell initialization timed out/i.test(error) &&
          (settingsLocation === "local" ? (
            <Button
              onClick={() =>
                void invoke("reveal_host_settings").catch((failure: unknown) =>
                  setRevealError(String(failure)),
                )
              }
            >
              Show host settings file
            </Button>
          ) : (
            settingsLocation && (
              <p>
                Host settings file: <code>{settingsLocation}/settings.json</code>
              </p>
            )
          ))}
        {error && revealError && <p role="alert">{revealError}</p>}
        {error?.includes("Desktop session") && (
          <details open>
            <summary>Connection timeout</summary>
            <DesktopTimeoutField />
          </details>
        )}
      </div>
    </section>
  );
}
