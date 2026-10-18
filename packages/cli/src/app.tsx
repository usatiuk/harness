import type { ClientQuestionRequest } from "@harness/questions/client";
import { QuestionsOverlay } from "./questions-overlay.tsx";
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
import { ConfirmInput, Spinner, Select } from "@inkjs/ui";
import {
  findModel,
  formatError,
  textOf,
  type ItemId,
  isKernelEvent,
  type Conversation,
  type HarnessEvent,
  type Item,
  type ModelUsage,
  type ModelUsageSummary,
  type Usage,
} from "@harness/protocol";
import type { HarnessClientService } from "@harness/client";
import {
  isSandboxStatus,
  sandboxConfigSchema,
  type SandboxBackend,
  type SandboxPhase,
} from "@harness/sandbox/client";
import { init, reduce, type Cell, type State } from "./transcript-reducer.ts";
import { presetsFor, runCommand, type CommandContext } from "./commands.ts";
import { ModelPicker, PresetPicker } from "./model-picker.tsx";
import { ActivitiesOverlay } from "./activities-overlay.tsx";
import { SandboxOverlay, type SandboxView } from "./sandbox-overlay.tsx";
import type { CliPlugins } from "./client-plugins.ts";
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
  service: HarnessClientService;
  plugins: CliPlugins;
  providerLabels?: Readonly<Record<string, string>>;
  conversation: Conversation;
  initialItems: Item[];
  /** Stored usage rows seeding the footer totals on resume. */
  initialUsage: ModelUsage[] | ModelUsageSummary;
  cwd: string;
  /** Where this process was launched; a note flags it when it differs from `cwd`. */
  launchCwd: string;
  /** Switch conversation (id resumes directly; omitted opens the picker). */
  onResume: (id?: string) => void;
  /** Reload this conversation, optionally applying a mutation between teardown and activation. */
  onReload: (mutation?: SessionMutation) => void;
  /** Disables input while the session owner tears down or activates a root scope. */
  transitioning?: string;
  /** Resume/confirmation UI owned by the session root while this App stays subscribed. */
  sessionOverlay?: ReactNode;
  /** A session-owner message that must survive an App remount. */
  notice?: { id: number; text: string };
  onHosts?: () => void;
  drafts?: Map<string, string>;
}

export interface SessionMutation {
  apply(): Promise<void>;
  success: string;
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
  plugins,
  providerLabels = {},
  conversation,
  initialItems,
  initialUsage,
  cwd: initialCwd,
  launchCwd,
  onResume,
  onReload,
  transitioning,
  sessionOverlay,
  notice,
  onHosts,
  drafts,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(appReduce, undefined, () =>
    init(initialItems, initialUsage),
  );
  const [config, setConfig] = useState(conversation.config);
  const [cwd, setCwd] = useState(initialCwd);
  const [initialSandboxBackend] = useState<SandboxBackend>(
    () => sandboxConfigSchema.parse(conversation.config.plugins?.["sandbox"] ?? {}).backend,
  );
  const sandboxState = plugins.sandbox(conversation.id, initialSandboxBackend);
  const activeSandboxBackend = sandboxState.backend;
  const activities = useMemo(() => plugins.activities(conversation.id), [plugins, conversation.id]);
  const model = config.model;
  const [modelPicking, setModelPicking] = useState(false);
  const [presetPicking, setPresetPicking] = useState(false);
  const [forkPicking, setForkPicking] = useState(false);
  const [showActivities, setShowActivities] = useState(false);
  const [showQuestions, setShowQuestions] = useState(false);
  const [questions, setQuestions] = useState<ClientQuestionRequest[]>([]);
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
  const pending = state.pending[0];
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
        if (isKernelEvent(event) && event.type === "workspace.changed") setCwd(event.workspaceRoot);
        if (isKernelEvent(event) && event.type === "config.changed") {
          setConfig(event.config);
        }
      }),
    [service, conversation.id],
  );

  useEffect(
    () =>
      plugins.subscribe(conversation.id, (event) => {
        if (
          isSandboxStatus(event) &&
          event.phase === "warning" &&
          event.conversationId === conversation.id
        ) {
          note(
            `warning: ${event.message ?? "Shared Docker control may interrupt other conversations."}`,
          );
        }
        dispatch({ type: "event", event, receivedAt: Date.now() });
      }),
    [plugins, conversation.id, note],
  );

  useEffect(
    () =>
      plugins.questions.subscribe(conversation.id, (event) => {
        setQuestions((current) =>
          event.type === "created"
            ? [...current.filter((request) => request.id !== event.request.id), event.request]
            : current.filter((request) => request.id !== event.requestId),
        );
      }),
    [plugins, conversation.id],
  );

  useEffect(() => {
    return plugins.approvals.subscribe(conversation.id, (event) => {
      if (event.type === "resolved") {
        dispatch({
          type: "event",
          event: {
            type: "request.resolved",
            conversationId: conversation.id,
            requestId: event.requestId,
          },
          receivedAt: Date.now(),
        });
        return;
      }
      dispatch({
        type: "event",
        event: {
          type: "request.created",
          conversationId: conversation.id,
          requestId: event.approval.requestId,
          request: {
            kind: "approval",
            call: event.approval.call,
            ...(event.approval.relationship ? { relationship: event.approval.relationship } : {}),
          },
        },
        receivedAt: Date.now(),
      });
    });
  }, [plugins, conversation.id]);

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
      if (showQuestions) return setShowQuestions(false);
      if (forkPicking) return setForkPicking(false);
      if (showActivities) return setShowActivities(false);
      if (showSandbox) return setShowSandbox(false);
      if (modelPicking) return setModelPicking(false);
      if (presetPicking) return setPresetPicking(false);
      return;
    }
    if (!key.escape) return;
    if (showQuestions) setShowQuestions(false);
    else if (forkPicking) setForkPicking(false);
    else if (showActivities) setShowActivities(false);
    else if (showSandbox) setShowSandbox(false);
    else if (modelPicking) setModelPicking(false);
    else if (presetPicking) setPresetPicking(false);
    else if (menuOpen.current)
      return; // the composer closes its own menu
    else if (busy) report(service.deliver(conversation.id, "", "interrupt"));
  });

  // One-shot `!cmd` runs on the server's execution backend; output remains a local presentation cell.
  const runShell = (command: string): void => {
    const run = plugins.runShell(conversation.id, command, (id, event) => {
      dispatch(
        event.type === "data"
          ? { type: "shell-delta", id, text: event.text }
          : { type: "shell-end", id, exitCode: event.exitCode },
      );
    });
    dispatch({ type: "shell-start", id: run.id, command });
    report(run.accepted);
  };

  // Configuration changes go through the session owner so persistence happens while attached,
  // followed immediately by runtime replacement with the new backend.
  const sandboxView: SandboxView = useMemo(() => {
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
      containerActive: sandboxState.containerActive,
      phase: state.sandbox?.phase,
      setBackend: (backend) => save({ backend }, `sandbox backend → ${backend}`),
      setWorkspaceWrite: (enabled) =>
        save({ native: { workspaceWrite: enabled } }, `native workspace write → ${enabled}`),
      setNetwork: (enabled) =>
        save({ native: { network: enabled } }, `native network → ${enabled}`),
      rebuild: () => {
        note("rebuilding the container…"); // progress streams via the sandbox status chip
        void plugins.rebuildSandbox(conversation.id).then(
          (status) =>
            note(
              status === "done" ? "sandbox rebuilt" : "Docker is not active in this conversation",
            ),
          (e: unknown) => note(`error: ${String(e)}`),
        );
      },
      stop: () => {
        note("stopping sandbox…");
        void plugins.stopSandbox(conversation.id).then(
          (status) =>
            note(
              status === "done" ? "sandbox stopped" : "Docker is not active in this conversation",
            ),
          (e: unknown) => note(`error: ${String(e)}`),
        );
      },
    };
  }, [
    service,
    conversation.id,
    activeSandboxBackend,
    sandboxState.containerActive,
    sandboxConfig.native.workspaceWrite,
    sandboxConfig.native.network,
    state.sandbox?.phase,
    note,
    busy,
    onReload,
    plugins,
  ]);

  // Memoized so the composer's completion menu, keyed on `ctx`, doesn't recompute on every
  // streaming re-render. The sandbox controls come from the memoized `sandboxView` above,
  // so they don't churn this identity.
  const ctx: CommandContext = useMemo(
    () => ({
      service,
      plugins,
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
      fork: () => setForkPicking(true),
      showActivities: () => setShowActivities(true),
      showQuestions: () => setShowQuestions(true),
      showSandbox: () => setShowSandbox(true),
      sandbox: sandboxView,
      exit,
      ...(onHosts ? { manageHosts: onHosts } : {}),
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
      plugins,
      onHosts,
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
              <WorkFooterView retry={state.modelRetry} />
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
                onConfirm={() => {
                  report(plugins.approvals.respond(pending.requestId, "allow"));
                }}
                onCancel={() => {
                  report(plugins.approvals.respond(pending.requestId, "deny"));
                }}
              />
            </Box>
          ) : showQuestions ? (
            <QuestionsOverlay
              requests={questions}
              respond={(id, response) => plugins.questions.respond(id, response)}
              onClose={() => setShowQuestions(false)}
            />
          ) : forkPicking ? (
            <Box flexDirection="column">
              <Text>Fork before a user message</Text>
              <Select
                options={[
                  ...state.cells
                    .filter((cell) => cell.kind === "user")
                    .toReversed()
                    .map((cell) => ({
                      label:
                        cell.kind === "user" ? cell.text.replace(/\s+/gu, " ").slice(0, 80) : "",
                      value: cell.id,
                    })),
                  { label: "Cancel", value: "cancel" },
                ]}
                onChange={(itemId) => {
                  setForkPicking(false);
                  if (itemId === "cancel") return;
                  void service
                    .forkBefore(conversation.id, itemId as ItemId)
                    .then((result) => {
                      if (result.draft.some((block) => block.type !== "text"))
                        throw new Error(
                          `Fork ${result.conversation.id} created; this composer cannot edit non-text content`,
                        );
                      if (!drafts) throw new Error("Fork draft storage is unavailable");
                      drafts.set(result.conversation.id, textOf(result.draft));
                      onResume(result.conversation.id);
                    })
                    .catch((error: unknown) => note(`fork failed: ${formatError(error)}`));
                }}
              />
            </Box>
          ) : modelPicking ? (
            <ModelPicker
              models={service.availableModels()}
              providerLabels={providerLabels}
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
                report(service.setPreset(conversation.id, model, value));
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
              {questions.length > 0 && (
                <Text color="magenta">
                  {questions.length} pending question request(s) · /questions to answer
                </Text>
              )}
              <PendingPreview pending={state.pendingInput} verbose={verbose} />
              <SandboxProgress sandbox={state.sandbox} />
              <Rule />
              <Composer
                ctx={ctx}
                history={history}
                initialValue={drafts?.get(conversation.id) ?? ""}
                onValueChange={(value) => drafts?.set(conversation.id, value)}
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
                usageIncomplete={state.usageIncomplete ?? false}
                cost={state.cost}
                costIncomplete={state.costIncomplete ?? false}
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
  const maxHeight = "isTTY" in stdout && stdout.isTTY === true ? Math.max(0, rows - 1) : undefined;

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
  usageIncomplete: boolean,
  cost: number,
  lastInputTokens: number | undefined,
  contextWindow: number | undefined,
  costIncomplete = false,
): string {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) {
    return usageIncomplete ? "usage incomplete" : "";
  }
  const cachedPct = Math.round((usage.cachedReadTokens / Math.max(usage.inputTokens, 1)) * 100);
  let label = `↑${fmtTokens(usage.inputTokens)}`;
  if (cachedPct > 0) label += ` ${cachedPct}% cached`;
  label += ` ↓${fmtTokens(usage.outputTokens)}`;
  if (cost > 0) label += ` · ${costIncomplete ? "≥" : ""}$${cost.toFixed(2)}`;
  if (costIncomplete) label += " · cost incomplete";
  if (lastInputTokens !== undefined && contextWindow) {
    label += ` · ctx ${Math.round((lastInputTokens / contextWindow) * 100)}%`;
  }
  if (usageIncomplete) label += " · usage incomplete";
  return label;
}

function StatusBar({
  model,
  preset,
  cwd,
  usage,
  usageIncomplete,
  cost,
  costIncomplete,
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
  usageIncomplete: boolean;
  cost: number;
  costIncomplete: boolean;
  lastInputTokens: number | undefined;
  contextWindow: number | undefined;
  activeCount: number;
  sandboxBackend: SandboxBackend;
  sandboxPhase: SandboxPhase | undefined;
}): ReactElement {
  const label = preset ? `${model} (${preset})` : model;
  const tokens = usageLabel(
    usage,
    usageIncomplete,
    cost,
    lastInputTokens,
    contextWindow,
    costIncomplete,
  );
  const active =
    activeCount > 0 ? ` · ${activeCount} ${activeCount === 1 ? "activity" : "activities"}` : "";
  return (
    <Box>
      <Text color="green">●</Text>
      <Text dimColor>{`  ${label}${tokens ? ` · ${tokens}` : ""}${active} · ${cwd}`}</Text>
      {sandboxBackend !== "none" ? (
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
  warning: "yellow",
};

/** Compact status for the backend fixed to this loaded conversation. */
function SandboxChip({
  backend,
  phase,
}: {
  backend: Exclude<SandboxBackend, "none">;
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
  verbose,
}: {
  pending: State["pendingInput"];
  verbose: boolean;
}): ReactElement | null {
  if (pending.length === 0) return null;
  const backgroundCount = pending.filter((input) => input.source.kind === "plugin").length;
  return (
    <Box flexDirection="column">
      {pending
        .filter((input) => verbose || input.source.kind === "user")
        .map((p, i) => (
          <Text key={i} dimColor>
            {`⤷ ${p.source.kind === "plugin" ? `${p.source.pluginId} · ` : ""}${p.intent}: ${truncate(p.text, 60)}`}
          </Text>
        ))}
      {backgroundCount > 0 && !verbose && (
        <Text dimColor>
          {`⤷ ${backgroundCount} background ${backgroundCount === 1 ? "message" : "messages"} queued`}
        </Text>
      )}
    </Box>
  );
}

/** A dim horizontal rule spanning the terminal width; delimits the prompt region. */
function Rule(): ReactElement {
  const { columns: width } = useWindowSize();
  return <Text dimColor>{"─".repeat(Math.max(0, width))}</Text>;
}
