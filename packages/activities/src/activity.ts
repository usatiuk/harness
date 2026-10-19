import type { ContentBlock } from "@harness/protocol";

/** Terminal outcome of an activity — the settled, model-facing result. */
export interface ActivityResult {
  status: "ok" | "error";
  /** One-line summary, e.g. "`npm test` exited 1 after 12s". */
  summary: string;
  /** Bounded output for the model (tail), plus a file pointer when the output was spilled. */
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
  /** Optional owner-local readable reference; expires with this tracked handle. */
  readonly reference?: string;
  /** Live progress projection; callable repeatedly, before or after completion. */
  peek(opts?: { filter?: string }): ContentBlock[];
  kill(): void;
  /** Flush buffered output to a file (e.g. when backgrounding); absent for kinds without files. */
  persist?(): void;
  /** Terminal result; never rejects — a failure resolves with an error `ActivityResult`. */
  readonly done: Promise<ActivityResult>;
}
