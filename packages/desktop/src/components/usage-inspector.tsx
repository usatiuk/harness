import type { CSSProperties } from "react";
import type { ModelInfo } from "@harness/protocol";
import type { State } from "@harness/client-features/transcript-reducer";
import { Button, PopoverControl } from "../ui.tsx";

export function ContextUsage({ state, models }: { state: State; models: ModelInfo[] }) {
  const checkpoint = state.agentContext;
  const catalog =
    checkpoint &&
    models.find(
      (model) => model.provider === checkpoint.provider && model.model === checkpoint.model,
    );
  const capacity = catalog?.contextWindow;
  const used = checkpoint?.usage?.inputTokens;
  const percent = used !== undefined && capacity ? Math.round((100 * used) / capacity) : undefined;
  const unknown = "Unavailable";
  return (
    <PopoverControl
      label="Context and usage"
      trigger={
        <Button
          variant="ghost"
          className="context-control"
          aria-label={`Context usage: ${percent === undefined ? "unknown" : `${percent}%`}`}
        >
          <span
            className="context-ring"
            style={{ "--context-progress": `${Math.min(percent ?? 0, 100)}%` } as CSSProperties}
          />
        </Button>
      }
    >
      <h3>Context and usage</h3>
      <dl className="context-facts">
        <dt>Last agent input</dt>
        <dd>{used?.toLocaleString() ?? unknown}</dd>
        <dt>Context capacity</dt>
        <dd>{capacity?.toLocaleString() ?? unknown}</dd>
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
      <p className="muted">
        {checkpoint
          ? `${catalog?.label ?? checkpoint.model} · ${new Date(checkpoint.createdAt).toLocaleTimeString()}. `
          : "No reported agent request yet. "}
        The ring reflects the latest agent request attempt. Drafts and later context changes are not
        counted.
        {state.usageIncomplete
          ? " Accounting is incomplete; conversation totals are lower bounds."
          : ""}
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
