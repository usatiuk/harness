import {
  addUsage,
  assertNever,
  isKernelEvent,
  textOf,
  zeroUsage,
  type DeliveryIntent,
  type HarnessEvent,
  type Item,
  type ModelUsage,
  type ToolStatus,
  type TurnStatus,
  type Usage,
} from "@harness/protocol";
import { isActivityEvent } from "@harness/activities";
import { isSandboxStatus, type SandboxPhase } from "@harness/sandbox";
import {
  approvalAnnotationOf,
  isApprovalDecidedEvent,
  type ApprovalAnnotation,
  type ApprovalResponder,
} from "@harness/approval";
import { isAutoApprovalEvent } from "@harness/auto-approval";
import type { ModelConfig } from "@harness/protocol";

/**
 * One rendered line of transcript. Derived purely from the event stream (live) or
 * the committed item log (resume). Presentational components turn a `Cell` into Ink
 * nodes; this module never imports Ink, so it is unit-testable on its own.
 */
export type Cell =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; turnId: string; text: string; streaming: boolean; id?: string }
  | { kind: "reasoning"; turnId: string; text: string; streaming: boolean; id?: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: unknown;
      status?: ToolStatus;
      output?: string;
      approval?: ApprovalAnnotation;
      approvalProgress?: {
        status: "reviewing" | "allow" | "deny";
        responder: ApprovalResponder;
        model?: ModelConfig;
        reason?: string;
      };
    }
  | { kind: "compaction"; id: string }
  // Plugin-injected context (e.g. an AGENTS.md), shown as a distinct transcript line.
  | { kind: "context"; id: string; text: string }
  // A failed turn's error message. Immutable, so it migrates straight to scrollback.
  | { kind: "error"; id: string; text: string }
  // Local-only (command output / errors). The pure reducer never emits this; the app
  // wrapper does. Always immutable, so it migrates straight to scrollback.
  | { kind: "note"; id: string; text: string }
  // Local-only `!cmd` shell output, streamed live from a spawned process. The pure reducer
  // never emits this; the app wrapper grows `text` per chunk and finalizes on exit.
  | { kind: "shell"; id: string; command: string; text: string; streaming: boolean; exitCode?: number }; // prettier-ignore

/** One row in the activities overlay; `status === undefined` ⟺ still running. */
export interface ActivityLine {
  id: string;
  kind: string;
  title: string;
  status?: "ok" | "error";
  summary?: string;
}

export interface State {
  cells: Cell[];
  turn: { id?: string; status: TurnStatus | "idle" };
  /** A middleware request (e.g. approval) awaiting a decision; cleared when its turn ends. */
  pending?: { requestId: string; summary: string };
  /** Accepted-but-not-yet-injected input (queue/steer), mirrored from the engine's `inbox` event. */
  pendingInput: { intent: DeliveryIntent; text: string }[];
  /** Tracked activities this session, newest last; folded from `activity.*` plugin events. */
  activities: ActivityLine[];
  /** Latest dev-container build/start phase; folded from `sandbox.status` events. Absent until one arrives. */
  sandbox?: { phase: SandboxPhase; message?: string };
  /** Running token totals across the conversation (live events + resume seed). */
  usage: Usage;
  /** Σ of stored per-row costs in USD; rows with no rate card contribute nothing. */
  cost: number;
  /** The latest request's total prompt size — the context-fill numerator. */
  lastInputTokens?: number;
}

export const emptyState: State = {
  cells: [],
  turn: { status: "idle" },
  pendingInput: [],
  activities: [],
  usage: zeroUsage(),
  cost: 0,
};

/** Index of the still-open streaming cell of `kind` for `turnId`, or -1. */
function openIndex(cells: Cell[], kind: "assistant" | "reasoning", turnId: string): number {
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]!;
    if (c.kind === kind && c.streaming && c.turnId === turnId) return i;
  }
  return -1;
}

function appendDelta(
  state: State,
  kind: "assistant" | "reasoning",
  turnId: string,
  text: string,
): State {
  const idx = openIndex(state.cells, kind, turnId);
  if (idx === -1) {
    return { ...state, cells: [...state.cells, { kind, turnId, text, streaming: true }] };
  }
  const cells = state.cells.slice();
  const c = cells[idx] as Extract<Cell, { kind: "assistant" | "reasoning" }>;
  cells[idx] = { ...c, text: c.text + text };
  return { ...state, cells };
}

/** Finalize the open streaming cell with canonical content + id (or push one if none streamed). */
function finalizeStream(
  state: State,
  kind: "assistant" | "reasoning",
  turnId: string,
  id: string,
  text: string,
): State {
  const idx = openIndex(state.cells, kind, turnId);
  if (idx === -1) {
    return { ...state, cells: [...state.cells, { kind, turnId, text, streaming: false, id }] };
  }
  const cells = state.cells.slice();
  const c = cells[idx] as Extract<Cell, { kind: "assistant" | "reasoning" }>;
  cells[idx] = { ...c, text, streaming: false, id };
  return { ...state, cells };
}

/** Drop `pending` from a state (exactOptionalPropertyTypes forbids assigning `undefined`). */
function clearPending(state: State): State {
  if (state.pending === undefined) return state;
  const next = { ...state };
  delete next.pending;
  return next;
}

/** Fold one event into the transcript state. Pure; handles `activity.*` plugin events plus kernel events. */
export function reduce(state: State, event: HarnessEvent): State {
  if (isAutoApprovalEvent(event)) {
    return {
      ...state,
      cells: state.cells.map((cell) => {
        if (cell.kind !== "tool" || cell.callId !== event.callId) return cell;
        return {
          ...cell,
          approvalProgress: { status: "reviewing", responder: "auto", model: event.model },
        };
      }),
    };
  }
  if (isApprovalDecidedEvent(event)) {
    return {
      ...state,
      cells: state.cells.map((cell) =>
        cell.kind === "tool" && cell.callId === event.callId
          ? {
              ...cell,
              approvalProgress: {
                status: event.decision,
                responder: event.responder,
                ...(event.model ? { model: event.model } : {}),
                ...(event.reason ? { reason: event.reason } : {}),
              },
            }
          : cell,
      ),
    };
  }
  if (isActivityEvent(event)) {
    if (event.type === "activity.started") {
      return {
        ...state,
        activities: [...state.activities, { id: event.id, kind: event.kind, title: event.title }],
      };
    }
    return {
      ...state,
      activities: state.activities.map((a) =>
        a.id === event.id ? { ...a, status: event.status, summary: event.summary } : a,
      ),
    };
  }
  if (isSandboxStatus(event)) {
    const message = typeof event.message === "string" ? event.message : undefined;
    return { ...state, sandbox: { phase: event.phase, ...(message ? { message } : {}) } };
  }
  if (!isKernelEvent(event)) return state;
  switch (event.type) {
    case "inbox":
      return { ...state, pendingInput: event.pending };
    case "turn.status": {
      const turn = { id: event.turnId, status: event.status };
      if (event.status === "running") return { ...state, turn };
      // A parked request can't outlive its turn.
      const ended = clearPending(state);
      if (event.status !== "failed") return { ...ended, turn };
      // A failed turn never reaches "completed", so its streaming cells need closing here.
      const cells = ended.cells.map((c) =>
        (c.kind === "assistant" || c.kind === "reasoning") &&
        c.streaming &&
        c.turnId === event.turnId
          ? { ...c, streaming: false }
          : c,
      );
      return {
        ...ended,
        turn,
        cells: [
          ...cells,
          { kind: "error", id: `${event.turnId}:error`, text: event.error ?? "turn failed" },
        ],
      };
    }
    case "message": {
      const item = event.item;
      if (item.type !== "message") return state;
      if (item.role === "user") {
        return {
          ...state,
          cells: [...state.cells, { kind: "user", id: item.id, text: textOf(item.content) }],
        };
      }
      if (item.role === "assistant") {
        return finalizeStream(state, "assistant", item.turnId, item.id, textOf(item.content));
      }
      return state; // system messages aren't shown
    }
    case "reasoning": {
      const item = event.item;
      if (item.type !== "reasoning") return state;
      return finalizeStream(state, "reasoning", item.turnId, item.id, textOf(item.content));
    }
    case "compaction":
      return { ...state, cells: [...state.cells, { kind: "compaction", id: event.item.id }] };
    case "context": {
      const item = event.item;
      if (item.type !== "context") return state;
      return {
        ...state,
        cells: [...state.cells, { kind: "context", id: item.id, text: textOf(item.content) }],
      };
    }
    case "text_delta":
      return appendDelta(state, "assistant", event.turnId, event.text);
    case "reasoning_delta":
      return appendDelta(state, "reasoning", event.turnId, event.text);
    case "tool_call.started":
      return {
        ...state,
        cells: [
          ...state.cells,
          { kind: "tool", callId: event.callId, name: event.name, args: event.args },
        ],
      };
    case "tool_call.completed":
      return {
        ...state,
        cells: state.cells.map((c): Cell => {
          if (c.kind !== "tool" || c.callId !== event.callId) return c;
          const approval = approvalAnnotationOf(event.annotations);
          const settled: Extract<Cell, { kind: "tool" }> = {
            ...c,
            status: event.status,
            output: textOf(event.forModel),
            ...(approval ? { approval } : {}),
          };
          delete settled.approvalProgress;
          return settled;
        }),
      };
    case "request.created": {
      const req = event.request as { kind?: string; call?: { name?: string } };
      if (req.kind !== "approval") return state;
      return {
        ...state,
        pending: { requestId: event.requestId, summary: `approve ${req.call?.name ?? "tool"}?` },
      };
    }
    case "request.resolved":
      return state.pending?.requestId === event.requestId ? clearPending(state) : state;
    case "config.changed":
      return state; // not a transcript line
    case "usage":
      return {
        ...state,
        usage: addUsage(state.usage, event.usage),
        cost: state.cost + (event.cost ?? 0),
        lastInputTokens: event.usage.inputTokens,
      };
    default:
      return assertNever(event);
  }
}

/**
 * Seed state from a committed item log (resume). Folds items into finalized cells,
 * pairing `tool_call`+`tool_result` by `callId` — the same cells a live replay yields.
 * `usageRows` seed the running totals so a resumed footer matches a live one.
 */
export function init(items: Item[], usageRows: ModelUsage[] = []): State {
  const cells: Cell[] = [];
  const toolByCall = new Map<string, Extract<Cell, { kind: "tool" }>>();
  for (const item of items) {
    switch (item.type) {
      case "message":
        if (item.role === "user")
          cells.push({ kind: "user", id: item.id, text: textOf(item.content) });
        else if (item.role === "assistant")
          cells.push({
            kind: "assistant",
            turnId: item.turnId,
            text: textOf(item.content),
            streaming: false,
            id: item.id,
          });
        break; // system messages aren't shown
      case "reasoning":
        cells.push({
          kind: "reasoning",
          turnId: item.turnId,
          text: textOf(item.content),
          streaming: false,
          id: item.id,
        });
        break;
      case "tool_call": {
        const cell: Extract<Cell, { kind: "tool" }> = {
          kind: "tool",
          callId: item.callId,
          name: item.name,
          args: item.args,
        };
        cells.push(cell);
        toolByCall.set(item.callId, cell);
        break;
      }
      case "tool_result": {
        const cell = toolByCall.get(item.callId);
        if (cell) {
          cell.status = item.status;
          cell.output = textOf(item.content);
          const approval = approvalAnnotationOf(item.annotations);
          if (approval) cell.approval = approval;
        }
        break;
      }
      case "compaction":
        cells.push({ kind: "compaction", id: item.id });
        break;
      case "context":
        cells.push({ kind: "context", id: item.id, text: textOf(item.content) });
        break;
      default:
        assertNever(item);
    }
  }
  const usage = usageRows.reduce((sum, row) => addUsage(sum, row.usage), zeroUsage());
  const cost = usageRows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const last = usageRows.at(-1)?.usage.inputTokens;
  return {
    cells,
    turn: { status: "idle" },
    pendingInput: [],
    activities: [],
    usage,
    cost,
    ...(last !== undefined ? { lastInputTokens: last } : {}),
  };
}
