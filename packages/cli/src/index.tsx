import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { ConfirmInput, Spinner } from "@inkjs/ui";
import type {
  Conversation,
  ConversationId,
  Item,
  ModelConfig,
  ModelUsageSummary,
  PluginContract,
} from "@harness/protocol";
import { formatError } from "@harness/protocol";
import type { SettingsDoc } from "@harness/config";
import { APPROVAL_CLIENT_CONTRACT_VERSION, ApprovalClient } from "@harness/approval";
import {
  HarnessClient,
  type HarnessClientService,
  HarnessDomainClient,
  createInProcessMessageConnectionPair,
  type RpcConnection,
} from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { buildServerHarness } from "@harness/server";
import { appProvidersRequest, type ProviderStatus } from "@harness/server/client-protocol";
import { modelAvailabilityMessage } from "./provider-status.ts";
export { ACTIVITY_APPROVAL_DEFAULTS, runStdioServer } from "@harness/server";
import { App, type SessionMutation } from "./app.tsx";
import { CLI_PLUGIN_CONTRACTS, CliPluginClient, type CliPlugins } from "./client-plugins.ts";
import { ResumePicker } from "./resume-picker.tsx";
const INSTRUCTIONS = "You are a helpful coding agent.";

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
  providers: ProviderStatus[];
  plugins: CliPluginClient;
  /** Model used only when no settings layer configures one (no `auth login`, no project config). */
  fallbackModel: ModelConfig;
  close(): Promise<void>;
}

const CLIENT_CONTRACTS: PluginContract[] = [
  { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
  ...CLI_PLUGIN_CONTRACTS,
];

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
  const providers = await wireClient.peer.request(appProvidersRequest, {});
  return {
    service,
    providers,
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

/** Warns when the session's configured model isn't backed by a registered (signed-in) provider. */
function notifyModel(
  service: HarnessClientService,
  providers: ProviderStatus[],
  model: ModelConfig,
): void {
  if (model.provider === "demo") {
    console.log(
      "No model provider configured — running on the demo provider. Run `harness auth login` to sign in.",
    );
    return;
  }
  const message = modelAvailabilityMessage(service.availableModels(), providers, model);
  if (message) console.log(message);
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
      notifyModel(service, harness.providers, start.session.conversation.config.model);
    }

    const { waitUntilExit } = render(
      <Root
        service={service}
        plugins={plugins}
        providerLabels={Object.fromEntries(harness.providers.map(({ id, label }) => [id, label]))}
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
  providerLabels?: Readonly<Record<string, string>>;
  start: Start;
  cwd: string;
  onActive: (id: ConversationId | undefined) => void;
}

interface TransitionRequest {
  targetId: ConversationId;
  mutation?: SessionMutation;
}

/** Two screens — picker and session — with `/resume` (and launch) toggling between them. */
export function Root({
  service,
  plugins,
  providerLabels = {},
  start,
  cwd,
  onActive,
}: RootProps): ReactElement | null {
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
      providerLabels={providerLabels}
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
