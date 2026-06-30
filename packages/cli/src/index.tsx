import { join, resolve } from "node:path";
import { useEffect, useState, type ReactElement } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { ConfirmInput } from "@inkjs/ui";
import type {
  Conversation,
  ConversationId,
  Item,
  ModelConfig,
  ModelUsage,
  PluginEntry,
} from "@harness/protocol";
import { defaultHome, type SettingsDoc } from "@harness/config";
import { SqliteStore } from "@harness/store-sqlite";
import { reapStoppedSandboxes, sandboxPlugin } from "@harness/sandbox";
import { activitiesPlugin, type ActivityManager } from "@harness/activities";
import { outputPlugin } from "@harness/output";
import { workspacePlugin } from "@harness/workspace";
import { approvalPlugin } from "@harness/approval";
import { subagentsDefinition } from "@harness/subagents";
import { HarnessService } from "@harness/service";
import { DemoProvider } from "./demo-provider.ts";
import { authRegistry } from "./auth.ts";
import { credentialStoreForRead } from "./credential-store.ts";
import { App } from "./app.tsx";
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

const INSTRUCTIONS = "You are a helpful coding agent.";

export interface LaunchOptions {
  /** Resume mode (pick from a list when no `conversationId` is given). */
  resume?: boolean;
  conversationId?: string | undefined;
  model?: string | undefined;
  cwd?: string | undefined;
}

interface Session {
  conversation: Conversation;
  items: Item[];
  usage: ModelUsage[];
}

type Start = { kind: "session"; session: Session } | { kind: "picker" };

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
  // keyring) warns and is skipped — we never silently fall back to a different store.
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
    subagentsDefinition,
  );
  const resolvedFallback: ModelConfig = fallbackModel ?? { provider: "demo", model: "demo-1" };
  // Lowest cascade layer: every conversation has a model even on resume with no settings, and
  // resolution never fails "no model configured".
  const service = new HarnessService({ store, plugins, defaults: { model: resolvedFallback } });
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

async function loadSession(service: HarnessService, id: string): Promise<Session> {
  const conversation = await service.getConversation(id as ConversationId);
  if (!conversation) throw new Error(`unknown conversation: ${id}`);
  const [items, usage] = await Promise.all([
    service.getItems(conversation.id),
    service.usage(conversation.id),
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
    start = { kind: "session", session: { conversation, items: [], usage: [] } };
  }

  if (start.kind === "session") {
    notifyModel(service, start.session.conversation.config.model);
    // Warm the runtime so the execution backend (and its emit channel) is live before the first
    // turn: pre-turn `!cmd`/`/sandbox` reach a real backend and sandbox build progress streams.
    await service.prepare(start.session.conversation.id);
  }

  // Every conversation shown this run, so all in-flight turns drain before the WAL closes.
  const touched = new Set<ConversationId>();
  const { waitUntilExit } = render(
    <Root service={service} start={start} cwd={cwd} onActive={(id) => touched.add(id)} />,
    // Ctrl+C is handled in-app (clear prompt / cancel overlay); Ctrl+D quits when empty.
    { exitOnCtrlC: false },
  );
  try {
    await waitUntilExit();
    await Promise.all([...touched].map((id) => service.whenIdle(id)));
    await Promise.all([...created].map((id) => service.deleteConversationIfEmpty(id)));
  } finally {
    // Reap any still-running background activities (dev servers, watchers) before exit.
    activitiesPlugin.shutdownAll();
    // Awaited: an aborted child's final `updateTurn` must land before the DB closes.
    await subagentsDefinition.shutdownAll();
    store.close();
  }
}

interface RootProps {
  service: HarnessService;
  start: Start;
  cwd: string;
  onActive: (id: ConversationId) => void;
}

/** Two screens — picker and session — with `/resume` (and launch) toggling between them. */
function Root({ service, start, cwd, onActive }: RootProps): ReactElement | null {
  const { exit } = useApp();
  const [session, setSession] = useState<Session | null>(
    start.kind === "session" ? start.session : null,
  );
  const [picking, setPicking] = useState(start.kind === "picker");
  // A switch to a different conversation that the user must confirm because it will stop
  // the leaving conversation's running activities.
  const [pendingSwitch, setPendingSwitch] = useState<{
    next: Session;
    leavingId: ConversationId;
    running: number;
  } | null>(null);

  useEffect(() => {
    if (session) onActive(session.conversation.id);
  }, [session, onActive]);

  const commit = (next: Session): void => {
    setSession(next);
    setPicking(false);
    setPendingSwitch(null);
  };
  // Leaving a conversation would strand its background activities (invisible and unkillable
  // from the new view), so confirm-and-stop first. Durable turns keep running; only the
  // ephemeral activities are reaped.
  const open = (next: Session): void => {
    if (session && session.conversation.id !== next.conversation.id) {
      const running = activityManager(service, session.conversation.id)?.runningCount() ?? 0;
      if (running > 0) {
        setPendingSwitch({ next, leavingId: session.conversation.id, running });
        return;
      }
    }
    commit(next);
  };
  const resume = (id?: string): void => {
    if (id) void loadSession(service, id).then(open);
    else setPicking(true);
  };

  if (pendingSwitch) {
    const { next, leavingId, running } = pendingSwitch;
    const noun = running === 1 ? "activity" : "activities";
    return (
      <Box>
        <Text color="yellow">{`stop ${running} running ${noun} and switch? `}</Text>
        <ConfirmInput
          onConfirm={() => {
            activityManager(service, leavingId)?.killAll();
            // Cascade-stop the subagent tree (children + grandchildren) so none strand invisibly.
            subagentsDefinition.stopTree(service, leavingId);
            commit(next);
          }}
          onCancel={() => setPendingSwitch(null)}
        />
      </Box>
    );
  }
  if (picking) {
    return (
      <PickerScreen
        service={service}
        cwd={cwd}
        onSelect={(id) => void loadSession(service, id).then(open)}
        onCancel={() => (session ? setPicking(false) : exit())}
      />
    );
  }
  if (!session) return null;

  return (
    <App
      key={session.conversation.id} // remount on switch so the reducer re-seeds
      service={service}
      conversation={session.conversation}
      initialItems={session.items}
      initialUsage={session.usage}
      cwd={session.conversation.workspaceRoot ?? cwd}
      launchCwd={cwd}
      onResume={resume}
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
