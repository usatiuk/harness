import type { ContentBlock } from "@harness/protocol";

/** Terminal outcome of an activity — the settled, model-facing result. */
export interface ActivityResult {
  status: "ok" | "error";
  /** One-line summary, e.g. "exited 1 after 12s". */
  summary: string;
  /** Result delivered on completion: e.g. a command's output tail or a child turn's final answer. */
  view: ContentBlock[];
}

/**
 * A tracked unit of work, self-contained and carrying its own behavior (a process is one kind, a
 * subagent another). Status and result are read off `done`, never stored separately.
 */
export interface Activity {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  /** Opt in to lookup by this owner-local reference or title. Otherwise only the ID is a handle. */
  readonly reference?: string;
  /** Peek owns its output budget (e.g. a process's selected tail), rather than the generic tool bound. */
  readonly preserveModelView?: true;
  /** Live progress projection; callable repeatedly, before or after completion. */
  peek(opts?: { filter?: string }): ContentBlock[];
  kill(): void;
  /** Flush buffered output to a file (e.g. when backgrounding); absent for kinds without files. */
  persist?(): string | undefined;
  /** Terminal result; never rejects — a failure resolves with an error `ActivityResult`. */
  readonly done: Promise<ActivityResult>;
}
