import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Box, Static, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
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
import { ActivityManager, type ActivityResult } from "@harness/activities";
import { LocalExecutionContext, type ExecutionContext } from "@harness/execution";
import {
  DockerExecutionContext,
  NativeExecutionContext,
  sandboxConfigSchema,
  type SandboxBackend,
  type SandboxPhase,
} from "@harness/sandbox";
import { init, reduce, type Cell, type State } from "./transcript-reducer.ts";
import { presetsFor, runCommand, type CommandContext } from "./commands.ts";
import { ModelPicker, PresetPicker } from "./model-picker.tsx";
import { ActivitiesOverlay, type ActivitiesView } from "./activities-overlay.tsx";
import { SandboxOverlay, type SandboxView } from "./sandbox-overlay.tsx";
import {
  CellView,
  ExplorationView,
  ThoughtView,
  WorkFooterView,
  truncate,
  VerboseContext,
} from "./cells.tsx";
import { Composer } from "./composer.tsx";
import { useHistory } from "./use-history.ts";
import {
  layoutTranscript,
  liveEntryStartIndex,
  type TranscriptEntry,
} from "./transcript-layout.ts";

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
  /** Reload this conversation, optionally applying a mutation between teardown and activation. */
  onReload: (mutation?: SessionMutation) => void;
  /** Disables input while the session owner tears down or activates a runtime family. */
  transitioning?: string;
  /** Resume/confirmation UI owned by the session root while this App stays subscribed. */
  sessionOverlay?: ReactNode;
  /** A session-owner message that must survive an App remount. */
  notice?: { id: number; text: string };
  /** Live activity output/kill handles for this conversation (list/count come from events). */
  activities: ActivitiesView;
}

export interface SessionMutation {
  apply(): Promise<void>;
  success: string;
}

/** Identify the execution backend that is actually cached for this conversation. */
export function sandboxBackendOf(execution: unknown): SandboxBackend | undefined {
  if (execution instanceof NativeExecutionContext) return "native";
  if (execution instanceof DockerExecutionContext) return "docker";
  if (execution instanceof LocalExecutionContext) return "local";
  return undefined;
}

type Action =
  | { type: "event"; event: HarnessEvent; receivedAt: number }
  | { type: "clear" }
  | { type: "note"; id: string; text: string }
  | { type: "shell-start"; id: string; command: string }
  | { type: "shell-delta"; id: string; text: string }
  | { type: "shell-end"; id: string; exitCode: number };

/** Bounds a live `!cmd` cell so a chatty command streams a tail rather than growing without limit. */
const SHELL_TAIL_CAP = 16 * 1024;

/** Clear the visible screen + scrollback buffer and home the cursor. Used on verbose toggle to wipe the frozen <Static> scrollback before reprinting it. */
const CLEAR_SCREEN_AND_SCROLLBACK = "[3J[H[2J";

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
      return reduce(state, action.event, action.receivedAt);
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

interface PositionedEntry {
  entry: TranscriptEntry;
  first: boolean;
}

const renderEntry = ({ entry, first }: PositionedEntry): ReactElement => (
  <Box
    key={entry.key}
    marginTop={entry.kind === "cell" && entry.cell.kind === "worked" ? 1 : first ? 0 : 1}
  >
    {entry.kind === "cell" ? (
      <CellView cell={entry.cell} />
    ) : entry.kind === "exploration" ? (
      <ExplorationView stage={entry.stage} />
    ) : (
      <ThoughtView thought={entry.thought} />
    )}
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
  onReload,
  transitioning,
  sessionOverlay,
  notice,
  activities,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(appReduce, undefined, () =>
    init(initialItems, initialUsage),
  );
  const [config, setConfig] = useState(conversation.config);
  const [initialSandboxBackend] = useState<SandboxBackend>(
    () => sandboxConfigSchema.parse(conversation.config.plugins?.["sandbox"] ?? {}).backend,
  );
  const activeSandboxBackend =
    sandboxBackendOf(service.service(conversation.id, "execution")) ?? initialSandboxBackend;
  const model = config.model;
  const [modelPicking, setModelPicking] = useState(false);
  const [presetPicking, setPresetPicking] = useState(false);
  const [showActivities, setShowActivities] = useState(false);
  const [showSandbox, setShowSandbox] = useState(false);
  const [verbose, setVerbose] = useState(false);
  // Bumped on verbose toggle to remount <Static> (new key) so it re-emits every
  // finalized cell — otherwise the scrollback is write-once and stays compact.
  const [staticEpoch, setStaticEpoch] = useState(0);
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
  const sandboxConfig = sandboxConfigSchema.parse(config.plugins?.["sandbox"] ?? {});

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
        dispatch({ type: "event", event, receivedAt: Date.now() });
        if (isKernelEvent(event) && event.type === "config.changed") {
          setConfig(event.config);
        }
      }),
    [service, conversation.id],
  );

  useEffect(() => {
    if (notice) dispatch({ type: "note", id: `session-note-${notice.id}`, text: notice.text });
  }, [notice]);

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
  useInput((input, key) => {
    if (transitioning || sessionOverlay) return;
    if (key.ctrl && input === "o") {
      // Clear the frozen scrollback before reprinting — see `staticEpoch` for the why.
      stdout?.write(CLEAR_SCREEN_AND_SCROLLBACK);
      setStaticEpoch((e) => e + 1);
      setVerbose((v) => !v);
      return;
    }
    if (key.ctrl && input === "c") {
      // Cancel the topmost overlay; in the main view the composer clears/interrupts instead.
      if (showActivities) return setShowActivities(false);
      if (showSandbox) return setShowSandbox(false);
      if (modelPicking) return setModelPicking(false);
      if (presetPicking) return setPresetPicking(false);
      return;
    }
    if (!key.escape) return;
    if (showActivities) setShowActivities(false);
    else if (showSandbox) setShowSandbox(false);
    else if (modelPicking) setModelPicking(false);
    else if (presetPicking) setPresetPicking(false);
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
    const done = proc.exit.then(
      ({ code, signal, error }): ActivityResult => ({
        status: error || signal || code === null || code !== 0 ? "error" : "ok",
        summary: error
          ? `local command failed to start: ${error.message}`
          : signal
            ? `local command killed (${signal})`
            : `local command exited ${code ?? 0}`,
        view: [],
      }),
    );
    const manager = service.service(conversation.id, "activities");
    if (manager instanceof ActivityManager) {
      manager.track(
        {
          id,
          kind: "shell",
          title: command,
          peek: () => [],
          kill: () => proc.kill(),
          done,
        },
        { callId: id, emit: () => {} },
      );
    }
    proc.onData((chunk) => dispatch({ type: "shell-delta", id, text: chunk }));
    report(proc.exit.then(({ code }) => dispatch({ type: "shell-end", id, exitCode: code ?? 0 })));
  };

  // Configuration changes go through the session owner so teardown happens before persistence and
  // the same conversation is freshly activated with the new backend.
  const sandboxView: SandboxView = useMemo(() => {
    const dockerCtx = (): DockerExecutionContext | undefined => {
      const ex = service.service(conversation.id, "execution");
      return ex instanceof DockerExecutionContext ? ex : undefined;
    };
    const save = (patch: Record<string, unknown>, label: string): void => {
      if (busy) return note("wait for or interrupt the current turn before changing the sandbox");
      onReload({
        apply: () =>
          service.setPluginConfig(conversation.id, "sandbox", patch, { saveGlobal: true }),
        success: label,
      });
    };
    return {
      backend: activeSandboxBackend,
      workspaceWrite: sandboxConfig.native.workspaceWrite,
      network: sandboxConfig.native.network,
      containerActive: dockerCtx()?.isProvisioned() ?? false,
      phase: state.sandbox?.phase,
      setBackend: (backend) => save({ backend }, `sandbox backend → ${backend}`),
      setWorkspaceWrite: (enabled) =>
        save({ native: { workspaceWrite: enabled } }, `native workspace write → ${enabled}`),
      setNetwork: (enabled) =>
        save({ native: { network: enabled } }, `native network → ${enabled}`),
      rebuild: () => {
        const ctx = dockerCtx();
        if (!ctx) return note("Docker is not active in this conversation");
        note("rebuilding the container…"); // progress streams via the sandbox status chip
        void ctx.rebuild().then(
          () => note("sandbox rebuilt"),
          (e: unknown) => note(`error: ${String(e)}`),
        );
      },
      stop: () => {
        const ctx = dockerCtx();
        if (!ctx) return note("Docker is not active in this conversation");
        note("stopping sandbox…");
        void ctx.stop().then(
          () => note("sandbox stopped"),
          (e: unknown) => note(`error: ${String(e)}`),
        );
      },
    };
  }, [
    service,
    conversation.id,
    activeSandboxBackend,
    sandboxConfig.native.workspaceWrite,
    sandboxConfig.native.network,
    state.sandbox?.phase,
    note,
    busy,
    onReload,
  ]);

  // Memoized so the composer's completion menu, keyed on `ctx`, doesn't recompute on every
  // streaming re-render. The sandbox controls come from the memoized `sandboxView` above,
  // so they don't churn this identity.
  const ctx: CommandContext = useMemo(
    () => ({
      service,
      conversationId: conversation.id,
      cwd,
      model,
      config,
      note,
      clear: () => dispatch({ type: "clear" }),
      resume: (id) =>
        busy ? note("wait for or interrupt the current turn before switching") : onResume(id),
      reload: () =>
        busy ? note("wait for or interrupt the current turn before reloading") : onReload(),
      pickModel: () => setModelPicking(true),
      pickPreset: () => setPresetPicking(true),
      showActivities: () => setShowActivities(true),
      showSandbox: () => setShowSandbox(true),
      sandbox: sandboxView,
      exit,
    }),
    [
      service,
      conversation.id,
      cwd,
      model,
      config,
      note,
      onResume,
      onReload,
      busy,
      exit,
      sandboxView,
    ],
  );

  const submit = (raw: string): void => {
    if (transitioning) return;
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

  // Finalized semantic stages advance into Static immediately. Only genuinely mutable cells stay
  // live, so later output never rewrites frozen scrollback.
  const entries = layoutTranscript(state.cells, verbose);
  const positioned = entries.map((entry, index) => ({ entry, first: index === 0 }));
  const cut = liveEntryStartIndex(entries);
  const done = positioned.slice(0, cut);
  const live = positioned.slice(cut);

  return (
    <VerboseContext.Provider value={verbose}>
      <Box flexDirection="column">
        <Static key={staticEpoch} items={done}>
          {renderEntry}
        </Static>
        <LiveViewport>
          {live.map(renderEntry)}
          {busy ? (
            <Box marginTop={1}>
              <WorkFooterView />
            </Box>
          ) : null}
          {entries.length > 0 || busy ? <Box height={1} /> : null}
          {sessionOverlay ? (
            sessionOverlay
          ) : transitioning ? (
            <Spinner label={transitioning} />
          ) : pending ? (
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
          ) : presetPicking ? (
            <PresetPicker
              presets={presetsFor(service, model)}
              current={model.preset}
              onSelect={(value) => {
                setPresetPicking(false);
                report(service.setModel(conversation.id, { ...model, preset: value }));
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
              <Rule />
              <Composer
                ctx={ctx}
                history={history}
                onSubmit={submit}
                onMenuOpenChange={setMenuOpen}
                onInterrupt={() => {
                  if (busy) report(service.deliver(conversation.id, "", "interrupt"));
                }}
              />
              <Rule />
              <StatusBar
                model={model.model}
                preset={model.preset}
                cwd={cwd}
                usage={state.usage}
                cost={state.cost}
                lastInputTokens={state.lastInputTokens}
                contextWindow={contextWindow}
                activeCount={activeCount}
                sandboxBackend={activeSandboxBackend}
                sandboxPhase={state.sandbox?.phase}
              />
            </>
          )}
        </LiveViewport>
      </Box>
    </VerboseContext.Provider>
  );
}

/**
 * Keeps Ink's mutable frame strictly shorter than the terminal. The full live
 * tree still lays out (including rich Markdown), but an oversized tree is
 * shifted upward and clipped so only its newest rows are painted.
 */
export function LiveViewport({ children }: { children: ReactNode }): ReactElement {
  const { stdout } = useStdout();
  const { rows } = useWindowSize();
  const maxHeight = stdout?.isTTY ? Math.max(0, rows - 1) : undefined;

  return (
    <Box
      flexDirection="column"
      maxHeight={maxHeight}
      overflowY={maxHeight === undefined ? "visible" : "hidden"}
      justifyContent="flex-end"
    >
      <Box flexDirection="column" flexShrink={0}>
        {children}
      </Box>
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
  model,
  preset,
  cwd,
  usage,
  cost,
  lastInputTokens,
  contextWindow,
  activeCount,
  sandboxBackend,
  sandboxPhase,
}: {
  model: string;
  preset: string | undefined;
  cwd: string;
  usage: Usage;
  cost: number;
  lastInputTokens: number | undefined;
  contextWindow: number | undefined;
  activeCount: number;
  sandboxBackend: SandboxBackend;
  sandboxPhase: SandboxPhase | undefined;
}): ReactElement {
  const label = preset ? `${model} (${preset})` : model;
  const tokens = usageLabel(usage, cost, lastInputTokens, contextWindow);
  const active =
    activeCount > 0 ? ` · ${activeCount} ${activeCount === 1 ? "activity" : "activities"}` : "";
  return (
    <Box>
      <Text color="green">●</Text>
      <Text dimColor>{`  ${label}${tokens ? ` · ${tokens}` : ""}${active} · ${cwd}`}</Text>
      {sandboxBackend !== "local" ? (
        <SandboxChip backend={sandboxBackend} phase={sandboxPhase} />
      ) : null}
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

/** Compact status for the backend fixed to this loaded conversation. */
function SandboxChip({
  backend,
  phase,
}: {
  backend: Exclude<SandboxBackend, "local">;
  phase: SandboxPhase | undefined;
}): ReactElement {
  if (backend === "native") return <Text dimColor>{" · 🫧 native"}</Text>;
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

/** A dim horizontal rule spanning the terminal width; delimits the prompt region. */
function Rule(): ReactElement {
  const { columns: width } = useWindowSize();
  return <Text dimColor>{"─".repeat(Math.max(0, width))}</Text>;
}
