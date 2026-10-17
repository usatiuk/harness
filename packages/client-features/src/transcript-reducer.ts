import {
  addUsage,
  assertNever,
  isKernelEvent,
  textOf,
  zeroUsage,
  type PendingInput,
  type HarnessEvent,
  type Item,
  type ModelUsage,
  type ModelUsageSummary,
  type ToolStatus,
  type TurnStatus,
  type Usage,
} from "@harness/protocol";
import { isActivityEvent } from "@harness/activities/client";
import { isSandboxStatus, type SandboxPhase } from "@harness/sandbox/client";
import {
  approvalAnnotationOf,
  isApprovalRequest,
  isApprovalDecidedEvent,
  type ApprovalAnnotation,
  type ApprovalResponder,
} from "@harness/approval/client";
import { isAutoApprovalEvent } from "@harness/auto-approval/client";
import type { ModelConfig } from "@harness/protocol";

/**
 * One rendered line of transcript. Durable content derives from the event stream
 * or committed item log; explicitly local cells exist only for this client
 * session. Components render cells in Ink or React; this module remains pure.
 */
export type Cell =
  | { kind: "plugin_message"; id: string; turnId: string; text: string; pluginId: string }
  | { kind: "user"; id: string; turnId: string; text: string; createdAt: number }
  | {
      kind: "assistant";
      turnId: string;
      text: string;
      streaming: boolean;
      id?: string;
      phase?: string | null;
    }
  | {
      kind: "reasoning";
      turnId: string;
      text: string;
      streaming: boolean;
      startedAt: number;
      completedAt?: number;
      /** Present only when this client observed the beginning of a streamed reasoning block. */
      observedTiming?: true;
      id?: string;
    }
  | {
      kind: "tool";
      id?: string;
      conversationId?: string;
      callId: string;
      parentCallId?: string;
      turnId?: string;
      name: string;
      args: unknown;
      startedAt: number;
      completedAt?: number;
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
  | { kind: "compaction"; id: string; text: string }
  | { kind: "provider_output"; id: string; turnId: string; text: string }
  // Plugin-injected context (e.g. an AGENTS.md), shown as a distinct transcript line.
  | { kind: "context"; id: string; text: string }
  // A failed turn's error message. Immutable, so it migrates straight to scrollback.
  | { kind: "error"; id: string; text: string }
  // Session-local terminal marker. Reconstructed item history deliberately omits it.
  | { kind: "worked"; id: string; duration: number }
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

type TurnState =
  | { id?: never; status: "idle" }
  | { id: string; status: "running"; startedAt: number }
  | { id: string; status: Exclude<TurnStatus, "running"> };

export interface State {
  cells: Cell[];
  turn: TurnState;
  /** A middleware request (e.g. approval) awaiting a decision; cleared when its turn ends. */
  pending: { requestId: string; summary: string }[];
  /** Durable facts already folded from history or the live suffix. */
  itemIds: ReadonlySet<string>;
  /** Accepted-but-not-yet-injected input (queue/steer), mirrored from the engine's `inbox` event. */
  pendingInput: PendingInput[];
  /** Tracked activities this session, newest last; folded from `activity.*` plugin events. */
  activities: ActivityLine[];
  /** Latest dev-container build/start phase; folded from `sandbox.status` events. Absent until one arrives. */
  sandbox?: { phase: SandboxPhase; message?: string };
  /** Running token totals across the conversation (live events + resume seed). */
  usage: Usage;
  /** At least one completed invocation omitted accounting, so totals are lower bounds. */
  usageIncomplete?: true;
  /** Σ of stored per-row costs in USD; rows with no rate card contribute nothing. */
  cost: number;
  costIncomplete?: boolean;
  /** The latest request's total prompt size — the context-fill numerator. */
  lastInputTokens?: number;
  agentContext?: ModelUsageSummary["agentContext"];
  lastTurn?: ModelUsageSummary["lastTurn"];
}

export const emptyState: State = {
  cells: [],
  turn: { status: "idle" },
  pending: [],
  itemIds: new Set(),
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
  receivedAt: number,
  phase?: string | null,
): State {
  const idx = openIndex(state.cells, kind, turnId);
  if (idx === -1) {
    return {
      ...state,
      cells: [
        ...state.cells,
        kind === "assistant"
          ? { kind, turnId, text, streaming: true, ...(phase !== undefined ? { phase } : {}) }
          : { kind, turnId, text, streaming: true, startedAt: receivedAt, observedTiming: true },
      ],
    };
  }
  const cells = state.cells.slice();
  const c = cells[idx] as Extract<Cell, { kind: "assistant" | "reasoning" }>;
  cells[idx] = {
    ...c,
    text: c.text + text,
    ...(kind === "assistant" && phase !== undefined ? { phase } : {}),
  };
  return { ...state, cells };
}

/** Finalize the open streaming cell with canonical content + id (or push one if none streamed). */
function finalizeStream(
  state: State,
  kind: "assistant" | "reasoning",
  turnId: string,
  id: string,
  text: string,
  completedAt: number,
  phase?: string | null,
): State {
  const idx = openIndex(state.cells, kind, turnId);
  if (idx === -1) {
    return {
      ...state,
      cells: [
        ...state.cells,
        kind === "assistant"
          ? { kind, turnId, text, streaming: false, id, ...(phase !== undefined ? { phase } : {}) }
          : { kind, turnId, text, streaming: false, id, startedAt: completedAt, completedAt },
      ],
    };
  }
  const cells = state.cells.slice();
  const c = cells[idx] as Extract<Cell, { kind: "assistant" | "reasoning" }>;
  const finalized: Cell =
    c.kind === "assistant"
      ? {
          kind: "assistant",
          turnId,
          text,
          streaming: false,
          id,
          ...(phase !== undefined ? { phase } : {}),
        }
      : { ...c, text, streaming: false, id, completedAt };
  // Canonical append order wins when display hints arrived during the preview.
  cells.splice(idx, 1);
  cells.push(finalized);
  return { ...state, cells };
}

function clearPending(state: State): State {
  return state.pending.length === 0 ? state : { ...state, pending: [] };
}

function reduceItem(state: State, item: Item, receivedAt?: number): State {
  if (state.itemIds.has(item.id)) {
    const streamKind =
      item.type === "message" && item.role === "assistant"
        ? "assistant"
        : item.type === "reasoning"
          ? "reasoning"
          : undefined;
    if (streamKind === undefined) return state;
    const index = openIndex(state.cells, streamKind, item.turnId);
    if (index === -1) return state;
    // History may already contain the durable item while its attach suffix still contains the
    // preceding deltas. The repeated canonical item closes that overlap by removing its draft.
    return { ...state, cells: state.cells.filter((_, cellIndex) => cellIndex !== index) };
  }
  const itemIds = new Set(state.itemIds).add(item.id);
  let next: State;
  switch (item.type) {
    case "message":
      if (item.role === "user") {
        next = {
          ...state,
          cells: [
            ...state.cells,
            {
              ...(item.source?.kind === "plugin"
                ? { kind: "plugin_message" as const, pluginId: item.source.pluginId }
                : { kind: "user" as const, createdAt: item.createdAt }),
              id: item.id,
              turnId: item.turnId,
              text: textOf(item.content),
            },
          ],
        };
      } else if (item.role === "assistant") {
        next = finalizeStream(
          state,
          "assistant",
          item.turnId,
          item.id,
          textOf(item.content),
          item.createdAt,
          item.phase,
        );
      } else {
        next = state;
      }
      break;
    case "reasoning":
      next = finalizeStream(
        state,
        "reasoning",
        item.turnId,
        item.id,
        textOf(item.content),
        receivedAt ?? item.createdAt,
      );
      break;
    case "compaction":
      next = {
        ...state,
        cells: [...state.cells, { kind: "compaction", id: item.id, text: textOf(item.content) }],
      };
      break;
    case "provider_output":
      next = {
        ...state,
        cells: [
          ...state.cells,
          { kind: item.type, id: item.id, turnId: item.turnId, text: textOf(item.content) },
        ],
      };
      break;
    case "context":
      next = {
        ...state,
        cells: [...state.cells, { kind: "context", id: item.id, text: textOf(item.content) }],
      };
      break;
    case "tool_call":
      next = {
        ...state,
        cells: [
          ...state.cells,
          {
            kind: "tool",
            id: item.id,
            conversationId: item.conversationId,
            callId: item.callId,
            turnId: item.turnId,
            name: item.name,
            args: item.args,
            ...(item.parentCallId ? { parentCallId: item.parentCallId } : {}),
            startedAt: item.createdAt,
          },
        ],
      };
      break;
    case "tool_result":
      next = {
        ...state,
        cells: state.cells.map((cell): Cell => {
          if (
            cell.kind !== "tool" ||
            cell.callId !== item.callId ||
            cell.conversationId !== item.conversationId
          )
            return cell;
          const approval = approvalAnnotationOf(item.annotations);
          const settled: Extract<Cell, { kind: "tool" }> = {
            ...cell,
            status: item.status,
            output: textOf(item.content),
            completedAt: item.createdAt,
            ...(approval ? { approval } : {}),
          };
          delete settled.approvalProgress;
          return settled;
        }),
      };
      break;
    default:
      return assertNever(item);
  }
  return { ...next, itemIds };
}

/** Fold one event into the transcript state. Pure; handles `activity.*` plugin events plus kernel events. */
export function reduce(state: State, event: HarnessEvent, receivedAt: number): State {
  if (isAutoApprovalEvent(event)) {
    return {
      ...state,
      cells: state.cells.map((cell) => {
        if (
          cell.kind !== "tool" ||
          cell.callId !== event.callId ||
          cell.conversationId !== event.conversationId
        )
          return cell;
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
        cell.kind === "tool" &&
        cell.callId === event.callId &&
        cell.conversationId === event.conversationId
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
      if (event.status === "running") {
        return {
          ...state,
          turn: { id: event.turnId, status: event.status, startedAt: receivedAt },
        };
      }
      // A terminal event owns state only when it closes the currently running turn. This makes
      // duplicate and stale terminal delivery harmless by construction.
      if (state.turn.status !== "running" || state.turn.id !== event.turnId) return state;
      const turn = { id: event.turnId, status: event.status };
      // A parked request can't outlive its turn.
      const ended = clearPending(state);
      // A terminal status closes any partial stream that did not receive a final item
      // (most commonly an interrupted/aborted provider stream).
      const cells = ended.cells.map((c): Cell => {
        if (c.kind === "assistant" && c.streaming && c.turnId === event.turnId) {
          return { ...c, streaming: false };
        }
        if (c.kind === "reasoning" && c.streaming && c.turnId === event.turnId) {
          return { ...c, streaming: false, completedAt: c.completedAt ?? receivedAt };
        }
        if (c.kind === "tool" && c.status === undefined && c.turnId === event.turnId) {
          const output =
            event.status === "aborted"
              ? "interrupted"
              : event.status === "failed"
                ? (event.error ?? "turn failed")
                : "tool did not complete";
          const settled: Extract<Cell, { kind: "tool" }> = {
            ...c,
            status: "error",
            output,
            completedAt: receivedAt,
          };
          delete settled.approvalProgress;
          return settled;
        }
        return c;
      });
      const worked: Cell = {
        kind: "worked",
        id: `${event.turnId}:worked`,
        duration: Math.max(0, receivedAt - state.turn.startedAt),
      };
      if (event.status !== "failed") return { ...ended, turn, cells: [...cells, worked] };
      return {
        ...ended,
        turn,
        cells: [
          ...cells,
          { kind: "error", id: `${event.turnId}:error`, text: event.error ?? "turn failed" },
          worked,
        ],
      };
    }
    case "item.appended":
      return reduceItem(state, event.item, receivedAt);
    case "text_delta":
      return appendDelta(state, "assistant", event.turnId, event.text, receivedAt, event.phase);
    case "reasoning_delta":
      return appendDelta(state, "reasoning", event.turnId, event.text, receivedAt);
    case "request.created": {
      if (!isApprovalRequest(event.request)) return state;
      const req = event.request;
      return {
        ...state,
        cells: state.cells.map((cell) =>
          cell.kind === "tool" &&
          cell.callId === req.call.callId &&
          cell.conversationId === event.conversationId
            ? {
                ...cell,
                approvalProgress: { status: "reviewing", responder: "human" },
              }
            : cell,
        ),
        pending: state.pending.some(({ requestId }) => requestId === event.requestId)
          ? state.pending
          : [
              ...state.pending,
              { requestId: event.requestId, summary: `approve ${req.call.name}?` },
            ],
      };
    }
    case "request.resolved":
      return {
        ...state,
        pending: state.pending.filter(({ requestId }) => requestId !== event.requestId),
      };
    case "workspace.changed":
    case "title.changed":
      return state;
    case "config.changed":
      return state; // not a transcript line
    case "head.changed":
      return state;
    case "usage.changed": {
      const next: State = {
        ...state,
        usage: event.summary.usage,
        cost: event.summary.cost,
        costIncomplete: event.summary.costIncomplete ?? false,
        agentContext: event.summary.agentContext,
        lastTurn: event.summary.lastTurn,
        ...(event.summary.incomplete ? { usageIncomplete: true } : {}),
        ...(event.summary.lastInputTokens === undefined
          ? {}
          : { lastInputTokens: event.summary.lastInputTokens }),
      };
      if (!event.summary.incomplete) delete next.usageIncomplete;
      if (event.summary.lastInputTokens === undefined) delete next.lastInputTokens;
      return next;
    }
    default:
      return assertNever(event);
  }
}

/**
 * Seed state from a committed item log (resume). Folds items into finalized durable
 * cells, pairing `tool_call`+`tool_result` by `callId`; session-local work footers
 * are intentionally absent. `usageRows` seed the running totals so a resumed usage
 * footer matches a live one.
 */
export function init(items: Item[], usageSeed: ModelUsage[] | ModelUsageSummary = []): State {
  let state: State = { ...emptyState, itemIds: new Set() };
  for (const item of items) state = reduceItem(state, item);
  if (!Array.isArray(usageSeed)) {
    return {
      ...state,
      usage: usageSeed.usage,
      ...(usageSeed.incomplete ? { usageIncomplete: true as const } : {}),
      cost: usageSeed.cost,
      costIncomplete: usageSeed.costIncomplete ?? false,
      agentContext: usageSeed.agentContext,
      lastTurn: usageSeed.lastTurn,
      ...(usageSeed.lastInputTokens === undefined
        ? {}
        : { lastInputTokens: usageSeed.lastInputTokens }),
    };
  }
  const knownUsageRows = usageSeed.filter(
    (row): row is ModelUsage & { usage: Usage } => row.usage !== null,
  );
  const usage = knownUsageRows.reduce((sum, row) => addUsage(sum, row.usage), zeroUsage());
  const cost = usageSeed.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const latest = usageSeed.at(-1);
  const last = latest?.inputTokensAreContext === false ? undefined : latest?.usage?.inputTokens;
  return {
    ...state,
    usage,
    ...(usageSeed.some((row) => row.usage === null) ? { usageIncomplete: true as const } : {}),
    cost,
    costIncomplete: usageSeed.some((row) => row.cost === null || row.costIncomplete === true),
    ...(last !== undefined ? { lastInputTokens: last } : {}),
  };
}
