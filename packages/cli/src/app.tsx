import { useEffect, useMemo, useReducer, useRef, useState, type ReactElement } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { ConfirmInput, Spinner, TextInput } from "@inkjs/ui";
import {
  findModel,
  isKernelEvent,
  type Conversation,
  type HarnessEvent,
  type Item,
  type ModelUsage,
  type Usage,
} from "@harness/protocol";
import type { HarnessService } from "@harness/service";
import { init, reduce, type Cell, type State } from "./transcript-reducer.ts";
import { effortsFor, runCommand, type CommandContext } from "./commands.ts";
import { EffortPicker, ModelPicker } from "./model-picker.tsx";
import { CellView, cellKey } from "./cells.tsx";

const INSTRUCTIONS_PLACEHOLDER = "type a message…   (> queue · ! interrupt · /help · Esc abort)";

export interface AppProps {
  service: HarnessService;
  conversation: Conversation;
  initialItems: Item[];
  /** Stored usage rows seeding the footer totals on resume. */
  initialUsage: ModelUsage[];
  cwd: string;
  /** Where this process was launched; a note flags it when it differs from `cwd`. */
  launchCwd: string;
  /** Switch conversation (id resumes directly; omitted opens the picker). */
  onResume: (id?: string) => void;
}

type Action =
  | { type: "event"; event: HarnessEvent }
  | { type: "clear" }
  | { type: "note"; id: string; text: string };

/** Wraps the pure reducer with local-only actions (clear / note) the event stream can't express. */
function appReduce(state: State, action: Action): State {
  switch (action.type) {
    case "event":
      return reduce(state, action.event);
    case "clear":
      return { ...state, cells: [] };
    case "note":
      return {
        ...state,
        cells: [...state.cells, { kind: "note", id: action.id, text: action.text }],
      };
  }
}

const renderCell = (cell: Cell): ReactElement => (
  <Box key={cellKey(cell)}>
    <CellView cell={cell} />
  </Box>
);

export function App({
  service,
  conversation,
  initialItems,
  initialUsage,
  cwd,
  launchCwd,
  onResume,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(appReduce, undefined, () =>
    init(initialItems, initialUsage),
  );
  const [model, setModel] = useState(conversation.config.model);
  const [modelPicking, setModelPicking] = useState(false);
  const [effortPicking, setEffortPicking] = useState(false);
  const noteId = useRef(0);
  const busy = state.turn.status === "running";
  const pending = state.pending;
  // Keeps the catalog scan off the per-delta render path.
  const contextWindow = useMemo(
    () => findModel(service.availableModels(), model)?.contextWindow,
    [service, model],
  );

  const note = (text: string): void =>
    dispatch({ type: "note", id: `note-${++noteId.current}`, text });
  // Surface a rejected service call instead of letting the floating promise vanish.
  const report = (p: Promise<unknown>): void => {
    void p.catch((e: unknown) => note(`error: ${String(e)}`));
  };

  useEffect(
    () =>
      service.subscribe((event) => {
        dispatch({ type: "event", event });
        if (
          isKernelEvent(event) &&
          event.type === "config.changed" &&
          event.conversationId === conversation.id
        ) {
          setModel(event.model);
        }
      }),
    [service, conversation.id],
  );

  // Resuming a conversation rooted elsewhere: commands run in its workspace, not your cwd.
  useEffect(() => {
    if (cwd !== launchCwd) {
      dispatch({
        type: "note",
        id: "workspace-notice",
        text: `this conversation runs in ${cwd} (you launched from ${launchCwd})`,
      });
    }
  }, [cwd, launchCwd]);

  // Esc closes an open picker, else interrupts a running turn (also cancels a parked request).
  useInput((_input, key) => {
    if (!key.escape) return;
    if (modelPicking) setModelPicking(false);
    else if (effortPicking) setEffortPicking(false);
    else if (busy) report(service.deliver(conversation.id, "", "interrupt"));
  });

  const ctx: CommandContext = {
    service,
    conversationId: conversation.id,
    model,
    note,
    clear: () => dispatch({ type: "clear" }),
    resume: onResume,
    pickModel: () => setModelPicking(true),
    pickEffort: () => setEffortPicking(true),
    exit,
  };

  const submit = (raw: string): void => {
    const line = raw.trim();
    if (line === "") return;
    if (line.startsWith("/")) {
      if (!runCommand(line, ctx)) ctx.note(`unknown command: ${line}`);
      return;
    }
    if (line.startsWith(">")) {
      report(service.deliver(conversation.id, line.slice(1).trim(), "queue"));
      return;
    }
    if (line.startsWith("!")) {
      report(service.deliver(conversation.id, line.slice(1).trim(), "interrupt"));
      return;
    }
    report(service.deliver(conversation.id, line, busy ? "steer" : "send"));
  };

  // Finalized cells (longest immutable prefix) print once to native scrollback via
  // <Static>; only the live tail repaints. The prefix only ever grows, so Static is safe.
  const cut = firstLiveIndex(state.cells);
  const done = state.cells.slice(0, cut);
  const live = state.cells.slice(cut);

  return (
    <Box flexDirection="column">
      <Static items={done}>{renderCell}</Static>
      {live.map(renderCell)}
      {pending ? (
        <Box>
          <Text color="magenta">{`❓ ${pending.summary} `}</Text>
          <ConfirmInput
            onConfirm={() =>
              service.respond(conversation.id, pending.requestId, { decision: "allow" })
            }
            onCancel={() =>
              service.respond(conversation.id, pending.requestId, { decision: "deny" })
            }
          />
        </Box>
      ) : modelPicking ? (
        <ModelPicker
          models={service.availableModels()}
          current={model}
          onSelect={(next) => {
            setModelPicking(false);
            report(service.setModel(conversation.id, next));
          }}
        />
      ) : effortPicking ? (
        <EffortPicker
          efforts={effortsFor(service, model)}
          current={model.effort}
          onSelect={(value) => {
            setEffortPicking(false);
            report(service.setModel(conversation.id, { ...model, effort: value }));
          }}
        />
      ) : (
        <>
          <StatusBar
            busy={busy}
            model={model.model}
            effort={model.effort}
            cwd={cwd}
            usage={state.usage}
            cost={state.cost}
            lastInputTokens={state.lastInputTokens}
            contextWindow={contextWindow}
          />
          <Composer onSubmit={submit} />
        </>
      )}
    </Box>
  );
}

const fmtTokens = (n: number): string => {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
};

/** `↑124k 38% cached ↓8.2k · $0.41 · ctx 31%`; empty until any tokens flow. */
export function usageLabel(
  usage: Usage,
  cost: number,
  lastInputTokens: number | undefined,
  contextWindow: number | undefined,
): string {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return "";
  const cachedPct = Math.round((usage.cachedReadTokens / Math.max(usage.inputTokens, 1)) * 100);
  let label = `↑${fmtTokens(usage.inputTokens)}`;
  if (cachedPct > 0) label += ` ${cachedPct}% cached`;
  label += ` ↓${fmtTokens(usage.outputTokens)}`;
  if (cost > 0) label += ` · $${cost.toFixed(2)}`;
  if (lastInputTokens !== undefined && contextWindow) {
    label += ` · ctx ${Math.round((lastInputTokens / contextWindow) * 100)}%`;
  }
  return label;
}

function StatusBar({
  busy,
  model,
  effort,
  cwd,
  usage,
  cost,
  lastInputTokens,
  contextWindow,
}: {
  busy: boolean;
  model: string;
  effort: string | undefined;
  cwd: string;
  usage: Usage;
  cost: number;
  lastInputTokens: number | undefined;
  contextWindow: number | undefined;
}): ReactElement {
  const label = effort ? `${model} (${effort})` : model;
  const tokens = usageLabel(usage, cost, lastInputTokens, contextWindow);
  return (
    <Box>
      {busy ? <Spinner label="working" /> : <Text color="green">●</Text>}
      <Text dimColor>{`  ${label}${tokens ? ` · ${tokens}` : ""} · ${cwd}`}</Text>
    </Box>
  );
}

function Composer({ onSubmit }: { onSubmit: (value: string) => void }): ReactElement {
  // Remount on each submit (key bump) to clear the uncontrolled input.
  const [gen, setGen] = useState(0);
  return (
    <Box>
      <Text color="cyan">{"› "}</Text>
      <TextInput
        key={gen}
        placeholder={INSTRUCTIONS_PLACEHOLDER}
        onSubmit={(value) => {
          onSubmit(value);
          setGen((g) => g + 1);
        }}
      />
    </Box>
  );
}

const isLive = (c: Cell): boolean => {
  if (c.kind === "assistant" || c.kind === "reasoning") return c.streaming;
  if (c.kind === "tool") return c.status === undefined;
  return false;
};

const firstLiveIndex = (cells: Cell[]): number => {
  const i = cells.findIndex(isLive);
  return i === -1 ? cells.length : i;
};
