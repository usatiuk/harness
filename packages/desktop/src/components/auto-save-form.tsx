import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useFetcher } from "react-router";
import { Button, ChoiceCommit } from "../ui.tsx";
import type { ActionResult } from "./action-feedback.tsx";

type Write = () => Promise<void>;
export const PreferenceWrites = createContext<Map<string, Write> | null>(null);

/** For ordinary preferences only. Credentials and consequential operations have explicit submitters. */
export function AutoSaveForm({
  preference,
  action = "/actions",
  className,
  disabled = false,
  children,
  afterSave,
}: {
  preference: string;
  action?: string;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
  afterSave?: (data: Extract<ActionResult, { ok: true }>) => ReactNode;
}) {
  const fetcher = useFetcher<ActionResult>();
  const queue = useContext(PreferenceWrites);
  const form = useRef<HTMLFormElement>(null);
  const latest = useRef<FormData | null>(null);
  const dirty = useRef(false);
  const [hint, setHint] = useState("");

  function save() {
    const element = form.current;
    if (!element || disabled) return;
    const invalid = element.querySelector<HTMLInputElement>("input:invalid");
    if (invalid) {
      setHint(`Not saved: ${invalid.validationMessage}`);
      return;
    }
    dirty.current = false;
    latest.current = new FormData(element);
    void sendLatest();
  }
  async function sendLatest() {
    if (!queue) throw new Error("AutoSaveForm needs a session write queue");
    const data = latest.current;
    if (!data) throw new Error("No preference edit to save");
    setHint("Saving…");
    let write: Write = () => {
      setHint((current) => (current === "Saving…" ? "" : current));
      return fetcher.submit(data, { method: "post", action });
    };
    const busy = queue.has(preference);
    queue.set(preference, write);
    if (busy) return;
    // Keep the in-flight write; across remounts only the newest queued form
    // follows it. Disposing the session clears its map and stops the drain.
    try {
      for (;;) {
        await write();
        const next = queue.get(preference);
        if (!next || next === write) break;
        write = next;
      }
    } finally {
      queue.delete(preference);
    }
  }
  const result = fetcher.state === "idle" && !hint ? fetcher.data : undefined;
  const message =
    fetcher.state !== "idle" ? "Saving…" : hint || result?.message || (result?.ok ? "Saved" : "");
  return (
    <ChoiceCommit.Provider
      value={(change) => {
        flushSync(change);
        save();
      }}
    >
      <form
        ref={form}
        className={className}
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty.current) save();
        }}
        onChange={(event) => {
          const target = event.target;
          if (!(target instanceof HTMLInputElement) || !target.name) return;
          if (target.type === "checkbox" || target.type === "radio") save();
          else {
            dirty.current = true;
            setHint("Unsaved edit");
          }
        }}
        onBlur={(event) => {
          if (dirty.current && event.target instanceof HTMLInputElement) save();
        }}
      >
        <fieldset className="preference-fields" disabled={disabled}>
          {children}
        </fieldset>
        {message && (
          <div className="save-feedback" role={result?.ok === false ? "alert" : "status"}>
            {message}
            {result?.ok && afterSave?.(result)}
            {result?.ok === false && (
              <Button size="sm" disabled={disabled} onClick={() => void sendLatest()}>
                Retry save
              </Button>
            )}
          </div>
        )}
      </form>
    </ChoiceCommit.Provider>
  );
}
