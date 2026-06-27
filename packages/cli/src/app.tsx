import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { ConfirmInput, Spinner } from "@inkjs/ui";
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
import type { ExecutionContext } from "@harness/execution";
import { DockerExecutionContext, type SandboxPhase } from "@harness/sandbox";
import { updateLocalSettings } from "@harness/config";
import { init, reduce, type Cell, type State } from "./transcript-reducer.ts";
import { effortsFor, runCommand, type CommandContext } from "./commands.ts";
import { EffortPicker, ModelPicker } from "./model-picker.tsx";
import { ActivitiesOverlay, type ActivitiesView } from "./activities-overlay.tsx";
import { SandboxOverlay, type SandboxView } from "./sandbox-overlay.tsx";
import { CellView, cellKey, truncate } from "./cells.tsx";
import { Composer } from "./composer.tsx";
import { useHistory } from "./use-history.ts";

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
  /** Live activity output/kill handles for this conversation (list/count come from events). */
  activities: ActivitiesView;
}

type Action =
  | { type: "event"; event: HarnessEvent }
  | { type: "clear" }
  | { type: "note"; id: string; text: string }
  | { type: "shell-start"; id: string; command: string }
  | { type: "shell-delta"; id: string; text: string }
  | { type: "shell-end"; id: string; exitCode: number };

/** Bounds a live `!cmd` cell so a chatty command streams a tail rather than growing without limit. */
const SHELL_TAIL_CAP = 16 * 1024;

/** Maps over a still-open shell cell, leaving every other cell (and finalized shells) untouched. */
function updateShell(
  state: State,
  id: string,
  fn: (c: Extract<Cell, { kind: "shell" }>) => Cell,
): State {
  return {
    ...state,
    cells: state.cells.map((c) => (c.kind === "shell" && c.id === id && c.streaming ? fn(c) : c)),
  };
}

/** Wraps the pure reducer with local-only actions (clear / note / `!cmd` shell) the event stream can't express. */
export function appReduce(state: State, action: Action): State {
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
    case "shell-start":
      return {
        ...state,
        cells: [
          ...state.cells,
          { kind: "shell", id: action.id, command: action.command, text: "", streaming: true },
        ],
      };
    case "shell-delta":
      return updateShell(state, action.id, (c) => ({
        ...c,
        text: (c.text + action.text).slice(-SHELL_TAIL_CAP),
      }));
    case "shell-end":
      return updateShell(state, action.id, (c) => ({
        ...c,
        streaming: false,
        exitCode: action.exitCode,
      }));
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
  activities,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(appReduce, undefined, () =>
    init(initialItems, initialUsage),
  );
  const [model, setModel] = useState(conversation.config.model);
  const [modelPicking, setModelPicking] = useState(false);
  const [effortPicking, setEffortPicking] = useState(false);
  const [showActivities, setShowActivities] = useState(false);
  const [showSandbox, setShowSandbox] = useState(false);
  const history = useHistory();
  // Set by the composer while its menu is open; lets Esc close the menu before interrupting.
  const menuOpen = useRef(false);
  const noteId = useRef(0);
  const busy = state.turn.status === "running";
  const pending = state.pending;
  // Memoized to keep the per-delta render path free of the activities scan.
  const activeCount = useMemo(
    () => state.activities.filter((a) => a.status === undefined).length,
    [state.activities],
  );
  // Keeps the catalog scan off the per-delta render path.
  const contextWindow = useMemo(
    () => findModel(service.availableModels(), model)?.contextWindow,
    [service, model],
  );
  // Config slice is opaque (`Record<string, unknown>`), so read `enabled` defensively.
  const sandboxEnabled =
    (conversation.config.plugins?.["sandbox"] as { enabled?: boolean } | undefined)?.enabled ===
    true;

  // Stable identities so the memoized ctx (via note) and the composer's menu-open
  // effect (via setMenuOpen) don't rebuild/refire each render.
  const note = useCallback(
    (text: string): void => dispatch({ type: "note", id: `note-${++noteId.current}`, text }),
    [],
  );
  const setMenuOpen = useCallback((o: boolean): void => {
    menuOpen.current = o;
  }, []);
  // Surface a rejected service call instead of letting the floating promise vanish.
  const report = (p: Promise<unknown>): void => {
    void p.catch((e: unknown) => note(`error: ${String(e)}`));
  };

  useEffect(
    () =>
      // Scoped: the engine filters the stream, so another conversation's events can't
      // leak into this reducer.
      service.subscribe(conversation.id, (event) => {
        dispatch({ type: "event", event });
        if (isKernelEvent(event) && event.type === "config.changed") {
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
    if (showActivities) setShowActivities(false);
    else if (showSandbox) setShowSandbox(false);
    else if (modelPicking) setModelPicking(false);
    else if (effortPicking) setEffortPicking(false);
    else if (menuOpen.current)
      return; // the composer closes its own menu
    else if (busy) report(service.deliver(conversation.id, "", "interrupt"));
  });

  // One-shot `!cmd` in this conversation's execution context (inside the container when sandboxed);
  // output streams into a local cell, not sent to the model. Imperative (called from submit), so it
  // can stay a plain closure and use `report`.
  const runShell = (command: string): void => {
    const ex = service.service(conversation.id, "execution") as ExecutionContext | undefined;
    if (!ex) return note("no execution backend configured");
    const id = `shell-${++noteId.current}`;
    dispatch({ type: "shell-start", id, command });
    const proc = ex.spawn(command);
    proc.onData((chunk) => dispatch({ type: "shell-delta", id, text: chunk }));
    report(proc.exit.then(({ code }) => dispatch({ type: "shell-end", id, exitCode: code ?? 0 })));
  };

  // Memoized so its identity stays stable across streaming re-renders, rebuilding only when a real
  // input changes (notably the live provisioning `phase`). The methods re-resolve the cached
  // execution instance at call time, so rebuild/stop act on the running container. Errors report
  // inline (not via the unstable `report`) to keep the dep list clean.
  const sandboxView: SandboxView = useMemo(() => {
    const dockerContext = (): DockerExecutionContext | undefined => {
      const ex = service.service(conversation.id, "execution");
      return ex instanceof DockerExecutionContext ? ex : undefined;
    };
    const onLive = (
      act: (ex: DockerExecutionContext) => Promise<unknown>,
      doing: string,
      done: string,
    ): void => {
      const ex = dockerContext();
      if (!ex)
        return note("this conversation is not sandboxed (enabling applies to new conversations)");
      note(doing);
      void act(ex).then(
        () => note(done),
        (e: unknown) => note(`error: ${String(e)}`),
      );
    };
    return {
      enabled: sandboxEnabled,
      active: dockerContext() !== undefined,
      phase: state.sandbox?.phase,
      setEnabled: (next) =>
        void updateLocalSettings(cwd, (doc) => {
          const prev = (doc.plugins?.["sandbox"] as Record<string, unknown> | undefined) ?? {};
          return { ...doc, plugins: { ...doc.plugins, sandbox: { ...prev, enabled: next } } };
        }).then(
          (path) =>
            note(
              `sandbox ${next ? "enabled" : "disabled"} in ${path} — applies to new conversations`,
            ),
          (e: unknown) => note(`error: ${String(e)}`),
        ),
      rebuild: () => onLive((ex) => ex.rebuild(), "rebuilding sandbox…", "sandbox rebuilt"),
      stop: () => onLive((ex) => ex.stop(), "stopping sandbox…", "sandbox stopped"),
    };
  }, [service, conversation.id, sandboxEnabled, state.sandbox?.phase, cwd, note]);

  // Memoized (main's intent) so the composer's completion menu, keyed on `ctx`, doesn't recompute
  // on every streaming re-render. The sandbox controls come from the memoized `sandboxView` above,
  // so they don't churn this identity.
  const ctx: CommandContext = useMemo(
    () => ({
      service,
      conversationId: conversation.id,
      cwd,
      model,
      note,
      clear: () => dispatch({ type: "clear" }),
      resume: onResume,
      pickModel: () => setModelPicking(true),
      pickEffort: () => setEffortPicking(true),
      showActivities: () => setShowActivities(true),
      showSandbox: () => setShowSandbox(true),
      sandbox: sandboxView,
      exit,
    }),
    [service, conversation.id, cwd, model, note, onResume, exit, sandboxView],
  );

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
      const command = line.slice(1).trim();
      if (command) runShell(command);
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
      ) : showActivities ? (
        <ActivitiesOverlay
          activities={state.activities}
          view={activities}
          onClose={() => setShowActivities(false)}
        />
      ) : showSandbox ? (
        <SandboxOverlay view={sandboxView} onClose={() => setShowSandbox(false)} />
      ) : (
        <>
          <PendingPreview pending={state.pendingInput} />
          <SandboxProgress sandbox={state.sandbox} />
          <StatusBar
            busy={busy}
            model={model.model}
            effort={model.effort}
            cwd={cwd}
            usage={state.usage}
            cost={state.cost}
            lastInputTokens={state.lastInputTokens}
            contextWindow={contextWindow}
            activeCount={activeCount}
            sandboxEnabled={sandboxEnabled}
            sandboxPhase={state.sandbox?.phase}
          />
          <Composer ctx={ctx} history={history} onSubmit={submit} onMenuOpenChange={setMenuOpen} />
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
  activeCount,
  sandboxEnabled,
  sandboxPhase,
}: {
  busy: boolean;
  model: string;
  effort: string | undefined;
  cwd: string;
  usage: Usage;
  cost: number;
  lastInputTokens: number | undefined;
  contextWindow: number | undefined;
  activeCount: number;
  sandboxEnabled: boolean;
  sandboxPhase: SandboxPhase | undefined;
}): ReactElement {
  const label = effort ? `${model} (${effort})` : model;
  const tokens = usageLabel(usage, cost, lastInputTokens, contextWindow);
  const active =
    activeCount > 0 ? ` · ${activeCount} ${activeCount === 1 ? "activity" : "activities"}` : "";
  return (
    <Box>
      {busy ? <Spinner label="working" /> : <Text color="green">●</Text>}
      <Text dimColor>{`  ${label}${tokens ? ` · ${tokens}` : ""}${active} · ${cwd}`}</Text>
      {sandboxEnabled ? <SandboxChip phase={sandboxPhase} /> : null}
    </Box>
  );
}

const SANDBOX_CHIP_COLOR: Record<SandboxPhase, string> = {
  build: "yellow",
  create: "yellow",
  postCreate: "yellow",
  ready: "green",
  error: "red",
};

/** `🐳 <phase>` status chip, shown only when the sandbox is enabled; dim until the first status. */
function SandboxChip({ phase }: { phase: SandboxPhase | undefined }): ReactElement {
  if (phase === undefined) return <Text dimColor>{" · 🐳 idle"}</Text>;
  return <Text color={SANDBOX_CHIP_COLOR[phase]}>{` · 🐳 ${phase}`}</Text>;
}

const SANDBOX_IN_PROGRESS: SandboxPhase[] = ["build", "create", "postCreate"];

/** A spinner with the live build/start phase while the container is coming up; hidden otherwise. */
function SandboxProgress({
  sandbox,
}: {
  sandbox: { phase: SandboxPhase; message?: string } | undefined;
}): ReactElement | null {
  if (!sandbox || !SANDBOX_IN_PROGRESS.includes(sandbox.phase)) return null;
  const detail = sandbox.message ? `: ${truncate(sandbox.message, 60)}` : "";
  return (
    <Box>
      <Spinner label={`sandbox ${sandbox.phase}${detail}`} />
    </Box>
  );
}

/** Compact preview of accepted-but-not-yet-injected input, above the composer. */
function PendingPreview({
  pending,
}: {
  pending: { intent: string; text: string }[];
}): ReactElement | null {
  if (pending.length === 0) return null;
  return (
    <Box flexDirection="column">
      {pending.map((p, i) => (
        <Text key={i} dimColor>
          {`⤷ ${p.intent}: ${truncate(p.text, 60)}`}
        </Text>
      ))}
    </Box>
  );
}

const isLive = (c: Cell): boolean => {
  if (c.kind === "assistant" || c.kind === "reasoning" || c.kind === "shell") return c.streaming;
  if (c.kind === "tool") return c.status === undefined;
  return false;
};

const firstLiveIndex = (cells: Cell[]): number => {
  const i = cells.findIndex(isLive);
  return i === -1 ? cells.length : i;
};
