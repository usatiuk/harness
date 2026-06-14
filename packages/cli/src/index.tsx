import { join, resolve } from "node:path";
import { useEffect, useState, type ReactElement } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
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
import { localExecutionPlugin } from "@harness/execution";
import { activitiesPlugin } from "@harness/activities";
import { outputPlugin } from "@harness/output";
import { workspacePlugin } from "@harness/workspace";
import { approvalPlugin } from "@harness/approval";
import { HarnessService } from "@harness/service";
import { createOpenAIPlugin } from "@harness/openai-api";
import { createAnthropicPlugin } from "@harness/anthropic-api";
import { KeyringSecretStore } from "@harness/secrets";
import { CodexAuth, codexPlugin } from "@harness/openai-codex";
import { DemoProvider } from "./demo-provider.ts";
import { App } from "./app.tsx";
import { ResumePicker } from "./resume-picker.tsx";

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

/** Composition root: the durable store, the model plugins, and the execution/approval stack. */
function buildHarness(): Harness {
  const store = new SqliteStore(join(defaultHome(), "store.db"));
  const apiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const codex = new CodexAuth({ store: new KeyringSecretStore() });
  const plugins: PluginEntry[] = [
    codexPlugin(codex),
    ...(apiKey ? [createOpenAIPlugin({ apiKey })] : []),
    ...(anthropicKey ? [createAnthropicPlugin({ apiKey: anthropicKey })] : []),
    { id: "demo", providers: () => [new DemoProvider()] },
    localExecutionPlugin,
    activitiesPlugin,
    outputPlugin,
    workspacePlugin,
    approvalPlugin,
  ];
  const fallbackModel: ModelConfig = apiKey
    ? { provider: "openai", model: process.env.OPENAI_MODEL ?? "gpt-5.1" }
    : anthropicKey
      ? { provider: "anthropic", model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8" }
      : { provider: "demo", model: "demo-1" };
  const service = new HarnessService({ store, plugins });
  return { service, store, fallbackModel };
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
  const { service, store, fallbackModel } = buildHarness();
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
    const conversation = await service.createConversation({
      cwd,
      defaults: { model: fallbackModel },
      overrides,
    });
    console.log(`conversation ${conversation.id}`);
    created.add(conversation.id);
    start = { kind: "session", session: { conversation, items: [], usage: [] } };
  }

  // Every conversation shown this run, so all in-flight turns drain before the WAL closes.
  const touched = new Set<ConversationId>();
  const { waitUntilExit } = render(
    <Root service={service} start={start} cwd={cwd} onActive={(id) => touched.add(id)} />,
  );
  try {
    await waitUntilExit();
    await Promise.all([...touched].map((id) => service.whenIdle(id)));
    await Promise.all([...created].map((id) => service.deleteConversationIfEmpty(id)));
  } finally {
    // Reap any still-running background activities (dev servers, watchers) before exit.
    activitiesPlugin.shutdownAll();
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

  useEffect(() => {
    if (session) onActive(session.conversation.id);
  }, [session, onActive]);

  const open = (next: Session): void => {
    setSession(next);
    setPicking(false);
  };
  const resume = (id?: string): void => {
    if (id) void loadSession(service, id).then(open);
    else setPicking(true);
  };

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
      cwd={session.conversation.config.workspaceRoot ?? cwd}
      launchCwd={cwd}
      onResume={resume}
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
    void service.listConversations().then(setList);
  }, [service]);

  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (input === "a") setShowAll((v) => !v);
  });

  if (list === null) return <Text dimColor>loading…</Text>;
  const shown = showAll ? list : list.filter((c) => c.config.workspaceRoot === cwd);
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
