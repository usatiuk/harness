import type { ContentBlock } from "@harness/protocol";
import {
  boundView,
  COMMAND_VIEW_DEFAULT_BYTES,
  resolveCommandView,
  type BoundOptions,
  type OutputStore,
  type OutputWriter,
  type ShellKind,
  type SpawnedProcess,
} from "@harness/execution";
import type { Activity, ActivityResult } from "@harness/activities";

/** Spill to a file once buffered output crosses this; below it a quick command stays file-less.
 * Same value as the default command view ceiling so the default tail is always in-memory. */
const MATERIALIZE_BYTES = COMMAND_VIEW_DEFAULT_BYTES;

export interface ProcessActivityInit {
  id: string;
  command: string;
  shell: ShellKind;
  name?: string;
  proc: SpawnedProcess;
  store: OutputStore;
  /** Per-activity output widening: `maxLines` selects a wider tail via `resolveCommandView`. */
  view?: { maxLines?: number };
}

/**
 * The process `Activity` kind, built over a `SpawnedProcess`: buffers output, spills to a file past
 * `MATERIALIZE_BYTES` or on `persist()`, and keeps a cheaply-trimmed recent tail (bounded precisely
 * by `boundView` only when shown). `done` resolves once and writes a self-describing exit footer.
 */
export function createProcessActivity(init: ProcessActivityInit): Activity {
  const { id, name, command, shell, proc, store } = init;
  // One resolved view per activity: the default 40-line/16 KiB tail, or the caller's widened
  // `max_lines` tail (clamped to the shared caps). Both live progress and the terminal result
  // render through it.
  const view: BoundOptions = resolveCommandView(init.view?.maxLines);
  const started = new Date();
  // `recent`: full output until materialized, then a plain-slice tail (no re-bounding per chunk).
  let recent = "";
  let spillError: string | undefined;
  let writer: OutputWriter | undefined;
  let exited = false;
  const trimTail = (text: string): string =>
    text.length > view.maxTotalBytes ? text.slice(-view.maxTotalBytes) : text;

  const persist = (): string | undefined => {
    if (spillError !== undefined) return undefined;
    if (writer || exited) return writer?.path;
    try {
      writer = store.open(id);
      writer.write(
        `Activity: ${id}\n${name === undefined ? "" : `Name: ${name}\n`}Started: ${started.toString()}\nShell: ${shell}\nCommand:\n${command}\n--- output ---\n`,
      );
      writer.write(recent);
    } catch (error) {
      // onData runs outside tool dispatch. Report failed capture with the process result.
      spillError = String(error);
    }
    recent = trimTail(recent);
    return spillError === undefined ? writer?.path : undefined;
  };

  proc.onData((chunk) => {
    // A descendant can keep an inherited pipe open after its parent has exited.
    if (exited) return;
    if (writer || spillError !== undefined) {
      if (spillError === undefined) writer?.write(chunk);
      recent = trimTail(recent + chunk);
    } else {
      recent += chunk;
      if (Buffer.byteLength(recent, "utf8") > MATERIALIZE_BYTES) persist();
    }
  });

  const output = (empty: string, opts?: { filter?: string }): ContentBlock[] => {
    const seen = boundView(recent, { ...view, ...(opts?.filter ? { filter: opts.filter } : {}) });
    const log = writer && spillError === undefined ? `Log: ${writer.path}\n` : "";
    return [{ type: "text", text: log + (seen || empty) }];
  };

  const done: Promise<ActivityResult> = proc.exit.then(async ({ code, signal, error }) => {
    exited = true;
    const secs = ((Date.now() - started.getTime()) / 1000).toFixed(1);
    const how = error
      ? `failed to start (${error.message})`
      : signal
        ? `killed (${signal})`
        : code === null
          ? "exited without a status"
          : `exited ${code}`;
    const summary = `${how} after ${secs}s`;
    const status: "ok" | "error" = error || signal || code === null || code !== 0 ? "error" : "ok";
    try {
      await writer?.close(`\n--- ${summary} ---\n`);
    } catch (error) {
      spillError = String(error);
    }
    const seen = output("(no output)");
    if (spillError !== undefined) {
      const error = `Could not save full output: ${spillError}`;
      return {
        status: "error",
        summary: `${summary}; ${error}`,
        view: [...seen, { type: "text", text: error }],
      };
    }
    return { status, summary, view: seen };
  });

  return {
    id,
    kind: "process",
    title: name ?? id,
    preserveModelView: true,
    peek: (opts) => output("(no output yet)", opts),
    kill: () => proc.kill(),
    persist,
    done,
  };
}
