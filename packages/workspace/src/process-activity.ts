import type { ContentBlock } from "@harness/protocol";
import {
  boundView,
  type OutputStore,
  type OutputWriter,
  type SpawnedProcess,
} from "@harness/execution";
import type { Activity, ActivityResult } from "@harness/activities";

/** Spill to a file once buffered output crosses this; below it a quick command stays file-less. */
const MATERIALIZE_BYTES = 16 * 1024;
const VIEW = { maxLines: 40, maxLineBytes: 1024, maxTotalBytes: 16 * 1024, mode: "tail" as const };

export interface ProcessActivityInit {
  id: string;
  /** Display title (the command); also the basis for the completion summary. */
  title: string;
  proc: SpawnedProcess;
  store: OutputStore;
}

/**
 * The process `Activity` kind, built over a `SpawnedProcess`: buffers output, spills to a file past
 * `MATERIALIZE_BYTES` or on `persist()`, and keeps a cheaply-trimmed recent tail (bounded precisely
 * by `boundView` only when shown). `done` resolves once and writes a self-describing exit footer.
 */
export function createProcessActivity(init: ProcessActivityInit): Activity {
  const { id, title, proc, store } = init;
  const started = Date.now();
  // `recent`: full output until materialized, then a plain-slice tail (no re-bounding per chunk).
  let recent = "";
  let materialized = false;
  let writer: OutputWriter | undefined;
  const trimTail = (text: string): string =>
    text.length > MATERIALIZE_BYTES ? text.slice(-MATERIALIZE_BYTES) : text;

  const persist = (): void => {
    if (materialized) return;
    materialized = true;
    writer = store.open(id);
    writer.write(recent);
    recent = trimTail(recent);
  };

  proc.onData((chunk) => {
    if (materialized) {
      writer!.write(chunk);
      recent = trimTail(recent + chunk);
    } else {
      recent += chunk;
      if (Buffer.byteLength(recent, "utf8") > MATERIALIZE_BYTES) persist();
    }
  });

  const peek = (opts?: { filter?: string }): ContentBlock[] => {
    const view = boundView(recent, { ...VIEW, ...(opts?.filter ? { filter: opts.filter } : {}) });
    return [{ type: "text", text: view || "(no output yet)" }];
  };

  const done: Promise<ActivityResult> = proc.exit.then(async ({ code, signal, error }) => {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const how = error
      ? `failed to start (${error.message})`
      : signal
        ? `killed (${signal})`
        : `exited ${code ?? 0}`;
    const summary = `\`${title}\` ${how} after ${secs}s`;
    const status: "ok" | "error" = error || signal || code === null || code !== 0 ? "error" : "ok";
    const view: ContentBlock[] = [{ type: "text", text: boundView(recent, VIEW) || "(no output)" }];
    try {
      if (writer) {
        await writer.close(`\n--- ${summary} ---\n`);
        view.push({ type: "text", text: `full output: ${writer.path}` });
      }
    } catch {
      // file close failed — the in-memory view still describes the outcome
    }
    return { status, summary, view };
  });

  return { id, kind: "process", title, peek, kill: () => proc.kill(), persist, done };
}
