import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { ConfirmInput, Spinner } from "@inkjs/ui";
import {
  formatError,
  isKernelEvent,
  jsonValueSchema,
  type Conversation,
  type ConversationId,
  type Item,
  type ModelConfig,
  type ModelUsageSummary,
  type PluginEntry,
  type PluginContract,
} from "@harness/protocol";
import { defaultHome, readGlobalSettings, type SettingsDoc } from "@harness/config";
import { SqliteStore } from "@harness/store-sqlite";
import { reapStoppedSandboxes, sandboxPlugin } from "@harness/sandbox";
import { activitiesPlugin } from "@harness/activities";
import { agentsPlugin } from "@harness/agents";
import { outputPlugin } from "@harness/output";
import { workspacePlugin } from "@harness/workspace";
import {
  APPROVAL_CLIENT_CONTRACT_VERSION,
  ApprovalClient,
  approvalDecideRequest,
  approvalPlugin,
  isApprovalRequest,
} from "@harness/approval";
import { autoApprovalPlugin } from "@harness/auto-approval";
import { subagentsDefinition } from "@harness/subagents";
import { HarnessService } from "@harness/service";
import { HarnessRpcSession } from "@harness/service";
import {
  HarnessClient,
  type HarnessClientService,
  HarnessDomainClient,
  createInProcessMessageConnectionPair,
  type RpcConnection,
} from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { modelCompaction } from "@harness/core";
import { createCustomProviderPlugins } from "@harness/custom-providers";
import { DemoProvider } from "./demo-provider.ts";
import { authRegistry } from "./auth.ts";
import { credentialStoreForRead } from "./credential-store.ts";
import { App, type SessionMutation } from "./app.tsx";
import {
  CLI_PLUGIN_CONTRACTS,
  CliPluginClient,
  registerCliPluginServer,
  type CliPlugins,
} from "./client-plugins.ts";
import { ResumePicker } from "./resume-picker.tsx";

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
  connectStdio?: boolean | undefined;
  ssh?: string | undefined;
}

/** Builds the new-conversation top layer; a model-id override always drops the fallback preset. */
export function launchOverrides(fallback: ModelConfig, requestedModel?: string): SettingsDoc {
  return requestedModel
    ? {
        instructions: INSTRUCTIONS,
        model: { provider: fallback.provider, model: requestedModel },
      }
    : { instructions: INSTRUCTIONS };
}

export interface Session {
  conversation: Conversation;
  items: Item[];
  usage: ModelUsageSummary;
}

export interface CliService extends HarnessClientService {
  createConversation(options?: {
    cwd?: string;
    overrides?: Record<string, unknown>;
  }): Promise<Conversation>;
  getConversation(id: ConversationId): Promise<Conversation | undefined>;
  listConversations(): Promise<Conversation[]>;
  getItems(id: ConversationId): Promise<Item[]>;
  prepare(id: ConversationId): Promise<void>;
  deleteConversationIfEmpty(id: ConversationId): Promise<void>;
  deactivateSession(
    id: ConversationId,
    options?: { force?: boolean },
  ): Promise<{ status: "busy" | "deactivated" }>;
  attachedConversation(id: ConversationId): Promise<Conversation>;
  usageSummary(id: ConversationId): Promise<ModelUsageSummary>;
  closeConnection?(): void;
}

export type Start = { kind: "session"; session: Session } | { kind: "picker" };

interface Harness {
  service: CliService;
  plugins: CliPluginClient;
  /** Model used only when no settings layer configures one (no `auth login`, no project config). */
  fallbackModel: ModelConfig;
  close(): Promise<void>;
}

interface ServerHarness {
  service: HarnessService;
  rpcSession: HarnessRpcSession;
  store: SqliteStore;
  close(closePeer?: boolean): Promise<void>;
}

const CLIENT_CONTRACTS: PluginContract[] = [
  { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
  ...CLI_PLUGIN_CONTRACTS,
];

/**
 * Composition root. Each registry provider contributes a plugin when it has credentials (a stored
 * key, its env var, or an OAuth session); the first such provider seeds the fallback model.
 */
async function buildServerHarness(connection: RpcConnection): Promise<ServerHarness> {
  const store = new SqliteStore(join(defaultHome(), "store.db"));
  let startedSession: HarnessRpcSession | undefined;
  try {
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
    // Config-defined providers (`customProviders` in global settings) join the same registry as
    // signed-in built-ins; their plugin id doubles as the model provider id.
    const customProviders = (await readGlobalSettings(defaultHome())).customProviders;
    plugins.push(...createCustomProviderPlugins(customProviders ?? {}));
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
    void reapStoppedSandboxes();
    // Late-bind the runner so the subagents tool can spawn/observe/abort children. Mirrors the
    // engine's late-binding of `configFor`; safe because no tool runs before the service is built.
    subagentsDefinition.bindRunner(service);
    const rpcSession = new HarnessRpcSession({
      connection,
      service,
      server: { name: "harness", version: "0.0.0" },
      plugins: CLIENT_CONTRACTS,
      defaultModel: resolvedFallback,
    });
    startedSession = rpcSession;
    registerCliPluginServer(rpcSession, service);
    const approvalRequests = new Map<string, AbortController>();
    rpcSession.observeEvents((event, rootId) => {
      if (!isKernelEvent(event)) return;
      if (event.type === "request.resolved") {
        approvalRequests.get(event.requestId)?.abort();
        approvalRequests.delete(event.requestId);
        return;
      }
      if (event.type !== "request.created" || !isApprovalRequest(event.request)) return;
      if (approvalRequests.has(event.requestId)) return;
      if (!rpcSession.supportsClientPlugin("approval", APPROVAL_CLIENT_CONTRACT_VERSION)) {
        service.respond(event.conversationId, event.requestId, { decision: "deny" });
        return;
      }
      const controller = new AbortController();
      approvalRequests.set(event.requestId, controller);
      void rpcSession
        .request(
          approvalDecideRequest,
          {
            requestId: event.requestId,
            rootConversationId: rootId,
            conversationId: event.conversationId,
            call: {
              callId: event.request.call.callId,
              name: event.request.call.name,
              args: jsonValueSchema.parse(event.request.call.args),
            },
            relationship: event.request.relationship,
          },
          { signal: controller.signal },
        )
        .then(
          (response) => service.respond(event.conversationId, event.requestId, response),
          () => service.respond(event.conversationId, event.requestId, { decision: "deny" }),
        )
        .finally(() => approvalRequests.delete(event.requestId));
    });
    rpcSession.start();
    let closed = false;
    return {
      service,
      rpcSession,
      store,
      close: async (closePeer = true) => {
        if (closed) return;
        closed = true;
        await rpcSession.shutdown(closePeer);
        subagentsDefinition.resetSession();
        store.close();
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await startedSession?.shutdown();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      subagentsDefinition.resetSession();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      store.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "server startup and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}

async function buildClientHarness(
  connection: RpcConnection,
  closeTransport: () => Promise<void>,
): Promise<Harness> {
  const wireClient = new HarnessClient({
    connection,
    client: { name: "harness-tui", version: "0.0.0" },
    plugins: CLIENT_CONTRACTS,
  });
  const approvals = new ApprovalClient(wireClient.peer);
  const plugins = new CliPluginClient(wireClient, approvals);
  const service = new HarnessDomainClient(wireClient);
  await service.start();
  return {
    service,
    plugins,
    fallbackModel: service.defaultModel(),
    close: async () => {
      service.closeConnection();
      await closeTransport();
    },
  };
}

async function buildHarness(): Promise<Harness> {
  const connections = createInProcessMessageConnectionPair();
  const server = await buildServerHarness(connections.right);
  try {
    return await buildClientHarness(connections.left, () => server.close(false));
  } catch (error) {
    await server.close();
    throw error;
  }
}

const waitForChild = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolvePromise) => child.once("close", () => resolvePromise()));

async function buildSpawnedHarness(child: ChildProcess): Promise<Harness> {
  if (child.stdout === null || child.stdin === null) {
    child.kill();
    throw new Error("server process did not expose protocol pipes");
  }
  const connection = createNdjsonMessageConnection(child.stdout, child.stdin);
  try {
    return await buildClientHarness(connection, () => waitForChild(child));
  } catch (error) {
    child.kill();
    await waitForChild(child);
    throw error;
  }
}

async function buildStdioHarness(): Promise<Harness> {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("cannot locate the harness CLI entry point");
  return buildSpawnedHarness(
    spawn(process.execPath, [...process.execArgv, entry, "server", "--stdio"], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    }),
  );
}

async function buildSshHarness(destination: string): Promise<Harness> {
  const args = sshServerArgs(destination);
  return buildSpawnedHarness(
    spawn("ssh", args, {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    }),
  );
}

/** Fixed SSH invocation: only the validated destination is variable. */
export function sshServerArgs(destination: string): string[] {
  if (destination.startsWith("-") || !/^[A-Za-z0-9_.@:[\]-]+$/u.test(destination)) {
    throw new Error("invalid SSH destination");
  }
  return ["-T", "--", destination, "harness server --stdio"];
}

/** Headless server entry point. Stdout is exclusively the NDJSON protocol. */
export async function runStdioServer(): Promise<void> {
  const connection = createNdjsonMessageConnection(process.stdin, process.stdout);
  const closed = new Promise<void>((resolvePromise) => connection.onClose(() => resolvePromise()));
  const server = await buildServerHarness(connection);
  let stop!: () => void;
  const signal = new Promise<void>((resolvePromise) => (stop = resolvePromise));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await Promise.race([closed, signal]);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await server.close(true);
  }
}

/** Warns when the session's configured model isn't backed by a registered (signed-in) provider. */
function notifyModel(service: HarnessClientService, model: ModelConfig): void {
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

export async function loadSession(service: CliService, id: string): Promise<Session> {
  const conversation = await service.attachedConversation(id as ConversationId);
  if (!conversation) throw new Error(`unknown conversation: ${id}`);
  const [items, usage] = await Promise.all([
    service.getItems(conversation.id),
    service.usageSummary(conversation.id),
  ]);
  return { conversation, items, usage };
}

/** Parses launch flags into a running TUI: new session, resume by id, or resume picker. */
export async function launch(opts: LaunchOptions = {}): Promise<void> {
  if (opts.connectStdio && opts.ssh !== undefined) {
    throw new Error("choose either --connect-stdio or --ssh");
  }
  const harness = opts.ssh
    ? await buildSshHarness(opts.ssh)
    : opts.connectStdio
      ? await buildStdioHarness()
      : await buildHarness();
  const { service, plugins, fallbackModel } = harness;
  try {
    // Canonicalize once so a `--cwd ./x` flag and a stored `workspaceRoot` compare equal.
    const remote = opts.ssh !== undefined;
    const cwd = remote ? (opts.cwd ?? ".") : resolve(opts.cwd ?? process.cwd());
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
      const overrides = launchOverrides(fallbackModel, opts.model);
      const conversation = await service.createConversation({
        ...(remote && opts.cwd === undefined ? {} : { cwd }),
        overrides,
      });
      console.log(`conversation ${conversation.id}\n`);
      created.add(conversation.id);
      await service.prepare(conversation.id);
      start = {
        kind: "session",
        session: {
          conversation,
          items: [],
          usage: {
            usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
            incomplete: false,
            cost: 0,
          },
        },
      };
    }

    if (start.kind === "session") {
      notifyModel(service, start.session.conversation.config.model);
    }

    const { waitUntilExit } = render(
      <Root
        service={service}
        plugins={plugins}
        start={start}
        cwd={cwd}
        onActive={() => undefined}
      />,
      // Ctrl+C is handled in-app (clear prompt / cancel overlay); Ctrl+D quits when empty.
      {
        exitOnCtrlC: false,
        incrementalRendering: true,
      },
    );
    await waitUntilExit();
    await Promise.all([...created].map((id) => service.deleteConversationIfEmpty(id)));
  } finally {
    await harness.close();
  }
}

interface RootProps {
  service: CliService;
  plugins: CliPlugins;
  start: Start;
  cwd: string;
  onActive: (id: ConversationId | undefined) => void;
}

interface TransitionRequest {
  targetId: ConversationId;
  mutation?: SessionMutation;
}

/** Two screens — picker and session — with `/resume` (and launch) toggling between them. */
export function Root({ service, plugins, start, cwd, onActive }: RootProps): ReactElement | null {
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

  const activate = async (request: TransitionRequest, forceReload = false): Promise<void> => {
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
      // Configuration mutation requires the current attachment. Persist it first, then replace the
      // runtime so the next attachment constructs services from the new durable configuration.
      if (request.mutation) {
        try {
          await request.mutation.apply();
        } catch (cause) {
          publish(`sandbox change failed: ${formatError(cause)}`);
          return;
        }
      }

      if (leaving?.conversation.id === request.targetId) {
        const result = await service.deactivateSession(leaving.conversation.id, {
          // A persisted service-config mutation must finish replacing the old fixed service.
          // Liveness was checked before mutation; force only closes a race with newly arriving work.
          force: forceReload || request.mutation !== undefined,
        });
        if (result.status === "busy") {
          publish("wait for or interrupt the current turn before switching");
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
      setSession(null);
      setPicking(true);
      setError(`could not activate conversation: ${formatError(cause)}`);
    } finally {
      transitionInFlight.current = false;
      setTransitioning(undefined);
    }
  };

  const requestActivation = (request: TransitionRequest): void => {
    if (transitionInFlight.current) return;
    if (session?.conversation.id === request.targetId) {
      const running = plugins.runningActivities(session.conversation.id);
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
          plugins={plugins}
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
        onConfirm={() => void activate(pendingSwitch.request, true)}
        onCancel={() => setPendingSwitch(null)}
      />
    </Box>
  ) : picking ? (
    <PickerScreen
      service={service}
      plugins={plugins}
      cwd={cwd}
      onSelect={(id) => requestActivation({ targetId: id as ConversationId })}
      onCancel={() => setPicking(false)}
    />
  ) : undefined;

  return (
    <App
      key={`${session.conversation.id}:${generation}`}
      service={service}
      plugins={plugins}
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
    />
  );
}

/**
 * Fetches the conversation list and renders the picker. Defaults to the current
 * project (conversations rooted at `cwd`); `a` toggles showing all. Esc cancels.
 */
function PickerScreen({
  service,
  plugins,
  cwd,
  onSelect,
  onCancel,
}: {
  service: CliService;
  plugins: CliPlugins;
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
      const topLevel = await plugins.topLevel(all.map((conversation) => conversation.id));
      setList(all.filter((conversation) => topLevel.has(conversation.id)));
    })();
  }, [service, plugins]);

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
