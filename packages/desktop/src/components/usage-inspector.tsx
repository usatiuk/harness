import { inputCapacity } from "@harness/client-features";
import type { ModelInfo } from "@harness/protocol";
import type { State } from "@harness/client-features/transcript-reducer";
import { Button, PopoverControl } from "../ui.tsx";

const unavailable = "Unavailable";
const tokens = (count: number | null | undefined) => count?.toLocaleString() ?? unavailable;
const reuse = (cached: number | null | undefined, input: number | undefined) =>
  cached != null && input
    ? `${((100 * cached) / input).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    : unavailable;
const cachedInput = (cached: number | null | undefined, input: number | undefined) =>
  cached == null ? "Not reported" : `${tokens(cached)}${input ? ` (${reuse(cached, input)})` : ""}`;
const time = (createdAt: number) =>
  new Date(createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const recordedCost = (cost: number | null | undefined, incomplete: boolean) =>
  cost == null
    ? unavailable
    : `${incomplete ? "≥" : ""}$${cost.toFixed(4)}${incomplete ? " (incomplete)" : ""}`;

export function ContextUsage({
  state,
  models,
  selected,
}: {
  state: State;
  models: ModelInfo[];
  selected: Pick<ModelInfo, "provider" | "model">;
}) {
  const latest = state.agentContext;
  const matches = latest?.provider === selected.provider && latest.model === selected.model;
  const measurement = state.contextMeasurements?.find(
    ({ provider, model }) => provider === selected.provider && model === selected.model,
  );
  const catalog = models.find(
    (model) => model.provider === selected.provider && model.model === selected.model,
  );
  const { used, basis, percent } = inputCapacity(
    catalog,
    measurement?.inputTokens ?? (matches ? latest.usage?.inputTokens : undefined),
  );
  const latestModel = models.find(
    (model) => model.provider === latest?.provider && model.model === latest?.model,
  );
  const request = latest?.lastRequest;
  const usage = request ? request.usage : latest?.usage;
  const cached = request ? request.cachedReadTokens : usage?.cachedReadTokens || undefined;
  const coverage = state.cacheRead;
  const utilization = percent === undefined ? unavailable : `${percent}% of ${basis}`;
  const total = (value: number) => `${state.usageIncomplete ? "≥" : ""}${tokens(value)}`;
  return (
    <PopoverControl
      label="Context and usage"
      trigger={
        <Button
          variant="ghost"
          className="context-control"
          aria-label={`Context usage: ${percent === undefined ? "unknown" : utilization}`}
        >
          <svg
            className="context-ring"
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 18 18"
            fill="none"
            strokeWidth="3"
          >
            <circle cx="9" cy="9" r="7.5" stroke="var(--control-border)" />
            <circle
              cx="9"
              cy="9"
              r="7.5"
              stroke="var(--ink)"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - Math.min(percent ?? 0, 100)}
              transform="rotate(-90 9 9)"
            />
          </svg>
        </Button>
      }
    >
      <h3>Context and usage</h3>
      <dl className="context-facts">
        <dt>Input measured</dt>
        <dd>{tokens(used)}</dd>
        {measurement && (!matches || !latest.usage) && (
          <>
            <dt>Measured at</dt>
            <dd>{time(measurement.createdAt)}</dd>
          </>
        )}
        <dt>Input utilization</dt>
        <dd>{utilization}</dd>
        <dt>Input limit</dt>
        <dd>{tokens(catalog?.maxInputTokens)}</dd>
        <dt>Shared context window</dt>
        <dd>{tokens(catalog?.contextWindow)}</dd>
      </dl>
      <h4>Last request</h4>
      <p className="muted shortcut-help">
        {latest
          ? `${latestModel?.label ?? latest.model} · ${time(latest.createdAt)}`
          : "No usage reported yet."}
      </p>
      <dl className="context-facts" aria-label="Last request">
        <dt>Input</dt>
        <dd>{tokens(usage?.inputTokens)}</dd>
        <dt>Output</dt>
        <dd>{tokens(usage?.outputTokens)}</dd>
        <dt>Cached input</dt>
        <dd>{cachedInput(cached, usage?.inputTokens)}</dd>
        <dt>Recorded cost</dt>
        <dd>{recordedCost(request?.cost, request?.costIncomplete ?? false)}</dd>
      </dl>
      <h4>Entire conversation</h4>
      <dl className="context-facts" aria-label="Entire conversation">
        <dt>Input</dt>
        <dd>{total(state.usage.inputTokens)}</dd>
        <dt>Output</dt>
        <dd>{total(state.usage.outputTokens)}</dd>
        <dt>Cached input (reported requests)</dt>
        <dd>
          {cachedInput(
            coverage?.reportedRequests ? coverage.cachedReadTokens : undefined,
            coverage?.inputTokens,
          )}
        </dd>
        <dt>Cache reporting</dt>
        <dd>
          {coverage?.totalRequests
            ? `${tokens(coverage.reportedRequests)} of ${tokens(coverage.totalRequests)} requests`
            : unavailable}
        </dd>
        <dt>Recorded cost</dt>
        <dd>{recordedCost(state.cost, state.costIncomplete ?? false)}</dd>
      </dl>
      <p className="muted shortcut-help">
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
