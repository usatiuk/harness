import { join, resolve } from "node:path";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { ConfirmInput, Spinner } from "@inkjs/ui";
import {
  formatError,
  type Conversation,
  type ConversationId,
  type Item,
  type ModelConfig,
  type ModelUsage,
  type PluginEntry,
} from "@harness/protocol";
import { defaultHome, type SettingsDoc } from "@harness/config";
import { SqliteStore } from "@harness/store-sqlite";
import { reapStoppedSandboxes, sandboxPlugin } from "@harness/sandbox";
import { activitiesPlugin, type ActivityManager } from "@harness/activities";
import { agentsPlugin } from "@harness/agents";
import { outputPlugin } from "@harness/output";
import { workspacePlugin } from "@harness/workspace";
import { approvalPlugin } from "@harness/approval";
import { autoApprovalPlugin } from "@harness/auto-approval";
import { subagentsDefinition } from "@harness/subagents";
import { HarnessService } from "@harness/service";
import { modelCompaction } from "@harness/core";
import { DemoProvider } from "./demo-provider.ts";
import { authRegistry } from "./auth.ts";
import { credentialStoreForRead } from "./credential-store.ts";
import { App, type SessionMutation } from "./app.tsx";
import type { ActivitiesView } from "./activities-overlay.tsx";
import { ResumePicker } from "./resume-picker.tsx";

/** The activity manager for a conversation, resolved off the engine — the same instance tools use. */
const activityManager = (
  service: HarnessService,
  id: ConversationId,
): ActivityManager | undefined => service.service(id, "activities") as ActivityManager | undefined;

/** Live activity output/kill handles for a conversation; list/count come from the event stream. */
const makeActivities = (service: HarnessService, convId: ConversationId): ActivitiesView => ({
  peek: (id) => activityManager(service, convId)?.get(id)?.peek() ?? [],
  kill: (id) => activityManager(service, convId)?.get(id)?.kill(),
});

/** Live work anywhere in the active root's loaded subagent family. */
const runningActivities = (service: HarnessService, root: ConversationId): number =>
  [root, ...subagentsDefinition.registry.descendantsOf(root)].reduce(
    (sum, id) => sum + (activityManager(service, id)?.runningCount() ?? 0),
    0,
  );

const INSTRUCTIONS = "You are a helpful coding agent.";

/** Activity controls only act on work already started by this conversation. */
export const ACTIVITY_APPROVAL_DEFAULTS = {
  activity_wait: "allow",
  activity_peek: "allow",
  activity_list: "allow",
  activity_kill: "allow",
} as const;

export interface LaunchOptions {
  /** Resume mode (pick from a list when no `conversationId` is given). */
  resume?: boolean;
  conversationId?: string | undefined;
  model?: string | undefined;
  cwd?: string | undefined;
}

export interface Session {
  conversation: Conversation;
  items: Item[];
  usage: ModelUsage[];
}

export type Start = { kind: "session"; session: Session } | { kind: "picker" };

interface Harness {
  service: HarnessService;
  store: SqliteStore;
  /** Model used only when no settings layer configures one (no `auth login`, no project config). */
  fallbackModel: ModelConfig;
}

/**
 * Composition root. Each registry provider contributes a plugin when it has credentials (a stored
 * key, its env var, or an OAuth session); the first such provider seeds the fallback model.
 */
async function buildHarness(): Promise<Harness> {
  const store = new SqliteStore(join(defaultHome(), "store.db"));
  const { store: secrets } = await credentialStoreForRead(defaultHome());
  const registry = authRegistry(secrets);
  const plugins: PluginEntry[] = [];
  let fallbackModel: ModelConfig | undefined;
  // Resolve providers concurrently; a configured backend that can't be reached (e.g. a locked
  // configured credential backend) warns and is skipped — we never silently fall back.
  const built = await Promise.all(
    [...registry.values()].map((entry) =>
      entry.buildPlugin().then(
        (plugin) => ({ entry, plugin }),
        (reason: unknown) => {
          console.error(`Could not load ${entry.method.label}: ${String(reason)}`);
          return { entry, plugin: null };
        },
      ),
    ),
  );
  for (const { entry, plugin } of built) {
    if (!plugin) continue;
    plugins.push(plugin);
    fallbackModel ??= entry.defaultModel;
  }
  plugins.push(
    { id: "demo", providers: () => [new DemoProvider()] },
    sandboxPlugin,
    activitiesPlugin,
    outputPlugin,
    workspacePlugin,
    approvalPlugin,
    agentsPlugin,
    autoApprovalPlugin,
    subagentsDefinition,
    { id: "compaction", policies: () => ({ compaction: modelCompaction }) },
  );
  const resolvedFallback: ModelConfig = fallbackModel ?? { provider: "demo", model: "demo-1" };
  // Lowest cascade layer: every conversation has a model even on resume with no settings, and
  // resolution never fails "no model configured".
  const service = new HarnessService({
    store,
    plugins,
    defaults: {
      model: resolvedFallback,
      plugins: {
        approval: { tools: ACTIVITY_APPROVAL_DEFAULTS },
      },
    },
  });
  // Late-bind the runner so the subagents tool can spawn/observe/abort children. Mirrors the
  // engine's late-binding of `configFor`; safe because no tool runs before the service is built.
  subagentsDefinition.bindRunner(service);
  return { service, store, fallbackModel: resolvedFallback };
}

/** Warns when the session's configured model isn't backed by a registered (signed-in) provider. */
function notifyModel(service: HarnessService, model: ModelConfig): void {
  if (model.provider === "demo") {
    console.log(
      "No model provider configured — running on the demo provider. Run `harness auth login` to sign in.",
    );
    return;
  }
  const registered = new Set(service.availableModels().map((m) => m.provider));
  if (!registered.has(model.provider)) {
    console.log(
      `Configured model ${model.provider}/${model.model} isn't signed in. ` +
        `Run \`harness auth login --provider ${model.provider}\` (or set its API key env var).`,
    );
  }
}

export async function loadSession(service: HarnessService, id: string): Promise<Session> {
  const conversation = await service.getConversation(id as ConversationId);
  if (!conversation) throw new Error(`unknown conversation: ${id}`);
  const [items, usage] = await Promise.all([
    service.getItems(conversation.id),
    service.usage(conversation.id),
    // Activation happens only after the previous runtime family has been deactivated.
    service.prepare(conversation.id),
  ]);
  return { conversation, items, usage };
}

/** Parses launch flags into a running TUI: new session, resume by id, or resume picker. */
export async function launch(opts: LaunchOptions = {}): Promise<void> {
  const { service, store, fallbackModel } = await buildHarness();
  // Best-effort sweep of stopped sandbox containers left by past sessions (no-op without docker).
  void reapStoppedSandboxes();
  // Canonicalize once so a `--cwd ./x` flag and a stored `workspaceRoot` compare equal.
  const cwd = resolve(opts.cwd ?? process.cwd());
  // Conversations this instance created; empty ones are dropped on exit.
  const created = new Set<ConversationId>();

  let start: Start;
  if (opts.conversationId) {
    start = { kind: "session", session: await loadSession(service, opts.conversationId) };
  } else if (opts.resume) {
    start = { kind: "picker" };
  } else {
    // `--model` overrides the model id on the fallback provider (a dev convenience); otherwise
    // the settings cascade picks the model, falling back to `fallbackModel` only when none is set.
    const overrides: SettingsDoc = opts.model
      ? { instructions: INSTRUCTIONS, model: { ...fallbackModel, model: opts.model } }
      : { instructions: INSTRUCTIONS };
    const conversation = await service.createConversation({ cwd, overrides });
    console.log(`conversation ${conversation.id}`);
    created.add(conversation.id);
    await service.prepare(conversation.id);
    start = { kind: "session", session: { conversation, items: [], usage: [] } };
  }

  if (start.kind === "session") {
    notifyModel(service, start.session.conversation.config.model);
  }

  let activeId: ConversationId | undefined;
  const { waitUntilExit } = render(
    <Root service={service} start={start} cwd={cwd} onActive={(id) => (activeId = id)} />,
    // Ctrl+C is handled in-app (clear prompt / cancel overlay); Ctrl+D quits when empty.
    {
      exitOnCtrlC: false,
      incrementalRendering: true,
    },
  );
  try {
    await waitUntilExit();
    if (activeId) {
      const result = await service.deactivateSession(activeId, { force: true });
      if (result.status === "deactivated") {
        subagentsDefinition.resetSession();
      }
    }
    await Promise.all([...created].map((id) => service.deleteConversationIfEmpty(id)));
  } finally {
    store.close();
  }
}

interface RootProps {
  service: HarnessService;
  start: Start;
  cwd: string;
  onActive: (id: ConversationId | undefined) => void;
}

interface TransitionRequest {
  targetId: ConversationId;
  mutation?: SessionMutation;
}

/** Two screens — picker and session — with `/resume` (and launch) toggling between them. */
export function Root({ service, start, cwd, onActive }: RootProps): ReactElement | null {
  const { exit } = useApp();
  const [session, setSession] = useState<Session | null>(
    start.kind === "session" ? start.session : null,
  );
  const [picking, setPicking] = useState(start.kind === "picker");
  const [generation, setGeneration] = useState(0);
  const [transitioning, setTransitioning] = useState<string | undefined>();
  const [notice, setNotice] = useState<{ id: number; text: string }>();
  const [error, setError] = useState<string>();
  const noticeId = useRef(0);
  const transitionInFlight = useRef(false);
  const [pendingSwitch, setPendingSwitch] = useState<{
    request: TransitionRequest;
    running: number;
  } | null>(null);

  useEffect(() => {
    onActive(session?.conversation.id);
  }, [session, onActive]);

  const publish = (text: string): void => {
    setNotice({ id: ++noticeId.current, text });
  };

  const activate = async (request: TransitionRequest): Promise<void> => {
    if (transitionInFlight.current) return;
    transitionInFlight.current = true;
    const leaving = session;
    setPicking(false);
    setPendingSwitch(null);
    setError(undefined);
    setTransitioning(
      leaving?.conversation.id === request.targetId
        ? "reloading conversation"
        : "switching conversation",
    );
    try {
      if (leaving) {
        const result = await service.deactivateSession(leaving.conversation.id);
        if (result.status === "busy") {
          publish("wait for or interrupt the current turn before switching");
          return;
        }
        subagentsDefinition.resetSession();
      }

      if (request.mutation) {
        try {
          await request.mutation.apply();
        } catch (cause) {
          if (!leaving) throw cause;
          const restored = await loadSession(service, leaving.conversation.id);
          setSession(restored);
          setGeneration((value) => value + 1);
          publish(`sandbox change failed: ${formatError(cause)}`);
          return;
        }
      }

      const next = await loadSession(service, request.targetId);
      setSession(next);
      setGeneration((value) => value + 1);
      const message =
        request.mutation?.success ??
        (leaving?.conversation.id === request.targetId ? "conversation reloaded" : undefined);
      if (message) publish(message);
    } catch (cause) {
      let failure = cause;
      try {
        const cleanup = await service.deactivateSession(request.targetId, { force: true });
        if (cleanup.status === "deactivated") subagentsDefinition.resetSession();
      } catch (cleanupCause) {
        failure = new AggregateError(
          [cause, cleanupCause],
          `activation failed: ${formatError(cause)}; cleanup failed: ${formatError(cleanupCause)}`,
        );
      }
      setSession(null);
      setPicking(true);
      setError(`could not activate conversation: ${formatError(failure)}`);
    } finally {
      transitionInFlight.current = false;
      setTransitioning(undefined);
    }
  };

  const requestActivation = (request: TransitionRequest): void => {
    if (transitionInFlight.current) return;
    if (session) {
      const running = runningActivities(service, session.conversation.id);
      if (running > 0) {
        setPendingSwitch({ request, running });
        return;
      }
    }
    void activate(request);
  };

  const resume = (id?: string): void => {
    if (id) requestActivation({ targetId: id as ConversationId });
    else setPicking(true);
  };

  if (!session && picking) {
    return (
      <Box flexDirection="column">
        {error ? <Text color="red">{error}</Text> : null}
        <PickerScreen
          service={service}
          cwd={cwd}
          onSelect={(id) => requestActivation({ targetId: id as ConversationId })}
          onCancel={() => (session ? setPicking(false) : exit())}
        />
      </Box>
    );
  }
  if (!session) return transitioning ? <Spinner label={transitioning} /> : null;

  const sessionOverlay = pendingSwitch ? (
    <Box>
      <Text color="yellow">
        {`stop ${pendingSwitch.running} running ${pendingSwitch.running === 1 ? "activity" : "activities"} and ${pendingSwitch.request.targetId === session.conversation.id ? "reload" : "switch"}? `}
      </Text>
      <ConfirmInput
        onConfirm={() => void activate(pendingSwitch.request)}
        onCancel={() => setPendingSwitch(null)}
      />
    </Box>
  ) : picking ? (
    <PickerScreen
      service={service}
      cwd={cwd}
      onSelect={(id) => requestActivation({ targetId: id as ConversationId })}
      onCancel={() => setPicking(false)}
    />
  ) : undefined;

  return (
    <App
      key={`${session.conversation.id}:${generation}`}
      service={service}
      conversation={session.conversation}
      initialItems={session.items}
      initialUsage={session.usage}
      cwd={session.conversation.workspaceRoot ?? cwd}
      launchCwd={cwd}
      onResume={resume}
      onReload={(mutation) =>
        requestActivation({ targetId: session.conversation.id, ...(mutation ? { mutation } : {}) })
      }
      {...(transitioning ? { transitioning } : {})}
      {...(sessionOverlay ? { sessionOverlay } : {})}
      {...(notice ? { notice } : {})}
      activities={makeActivities(service, session.conversation.id)}
    />
  );
}

/**
 * Fetches the conversation list and renders the picker. Defaults to the current
 * project (conversations rooted at `cwd`); `a` toggles showing all. Esc cancels.
 */
function PickerScreen({
  service,
  cwd,
  onSelect,
  onCancel,
}: {
  service: HarnessService;
  cwd: string;
  onSelect: (id: string) => void;
  onCancel: () => void;
}): ReactElement {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    // Hide spawn-marked subagent children so only user-started conversations list. One keyed read
    // per row is cheap against the listing's per-record resolve; batch if it ever profiles.
    void (async () => {
      const all = await service.listConversations();
      const marks = await Promise.all(
        all.map((c) => service.getPluginState("subagents", c.id, "spawn")),
      );
      setList(all.filter((_, i) => marks[i] == null));
    })();
  }, [service]);

  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (input === "a") setShowAll((v) => !v);
  });

  if (list === null) return <Text dimColor>loading…</Text>;
  const shown = showAll ? list : list.filter((c) => c.workspaceRoot === cwd);
  if (shown.length === 0) {
    const hint =
      !showAll && list.length > 0
        ? "no conversations in this project — press a to show all"
        : "no conversations yet.";
    return (
      <Box flexDirection="column">
        <Text dimColor>{hint}</Text>
        <Text dimColor>(esc to go back)</Text>
      </Box>
    );
  }
  return <ResumePicker conversations={shown} showingAll={showAll} onSelect={onSelect} />;
}
