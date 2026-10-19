import { CircleHelp } from "lucide-react";
import { inputCapacity } from "@harness/client-features";
import type { CSSProperties } from "react";
import type { ModelInfo } from "@harness/protocol";
import type { State } from "@harness/client-features/transcript-reducer";
import { Button, PopoverControl } from "../ui.tsx";

export function ContextUsage({ state, models }: { state: State; models: ModelInfo[] }) {
  const checkpoint = state.agentContext;
  const { model: catalog, used, basis, percent } = inputCapacity(checkpoint, models);
  const unknown = "Unavailable";
  return (
    <PopoverControl
      label="Context and usage"
      trigger={
        <Button
          variant="ghost"
          className="context-control"
          aria-label={`Context usage: ${percent === undefined ? "unknown" : `${percent}% of ${basis}`}`}
        >
          {percent === undefined ? (
            <CircleHelp size={18} aria-hidden="true" />
          ) : (
            <span
              className="context-ring"
              aria-hidden="true"
              style={{ "--context-progress": `${Math.min(percent, 100)}%` } as CSSProperties}
            />
          )}
        </Button>
      }
    >
      <h3>Context and usage</h3>
      <dl className="context-facts">
        <dt>Last agent input</dt>
        <dd>{used?.toLocaleString() ?? unknown}</dd>
        <dt>Input limit</dt>
        <dd>{catalog?.maxInputTokens?.toLocaleString() ?? unknown}</dd>
        <dt>Shared context window</dt>
        <dd>{catalog?.contextWindow?.toLocaleString() ?? unknown}</dd>
        <dt>Input utilization</dt>
        <dd>{percent === undefined ? unknown : `${percent}% of ${basis}`}</dd>
        <dt>Cached input</dt>
        <dd>{checkpoint?.usage?.cachedReadTokens.toLocaleString() ?? unknown}</dd>
        <dt>Conversation input</dt>
        <dd>{state.usage.inputTokens.toLocaleString()}</dd>
        <dt>Conversation output</dt>
        <dd>{state.usage.outputTokens.toLocaleString()}</dd>
        <dt>Recorded cost</dt>
        <dd>
          {state.costIncomplete ? "≥" : ""}${state.cost.toFixed(4)}
          {state.costIncomplete ? " (incomplete)" : ""}
        </dd>
      </dl>
      <p className="muted shortcut-help">
        {checkpoint
          ? `Latest request · ${catalog?.label ?? checkpoint.model} · ${new Date(checkpoint.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : "No usage reported yet."}
        <br />
        Unsent draft not included.
        {state.usageIncomplete && (
          <>
            <br />
            Some usage wasn't reported.
          </>
        )}
      </p>
    </PopoverControl>
  );
}
export function LastTurnStats({ state }: { state: State }) {
  const turn = state.lastTurn;
  const speed =
    turn &&
    turn.agentOutputTokens !== null &&
    turn.agentDurationMs !== null &&
    turn.agentDurationMs > 0
      ? (turn.agentOutputTokens * 1000) / turn.agentDurationMs
      : undefined;
  return (
    <div className="turn-stats" aria-label="Last turn statistics">
      <span>Last turn{turn ? ` · ${turn.status}` : ""}</span>
      <span>
        {turn && (!turn.incomplete || turn.usage.inputTokens > 0)
          ? `${turn.incomplete ? "≥" : ""}${turn.usage.inputTokens.toLocaleString()} in`
          : "Input unavailable"}
      </span>
      <span>
        {turn && (!turn.incomplete || turn.usage.outputTokens > 0)
          ? `${turn.incomplete ? "≥" : ""}${turn.usage.outputTokens.toLocaleString()} out`
          : "Output unavailable"}
      </span>
      <span title="Agent output tokens per second of server-measured model request time, including request latency and excluding tools/approval waits.">
        {speed === undefined ? "Speed unavailable" : `${speed.toFixed(1)} tok/s`}
      </span>
      {turn?.incomplete && <span>Incomplete accounting</span>}
    </div>
  );
}
