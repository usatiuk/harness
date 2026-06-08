import { join, resolve } from "node:path";
import { useEffect, useState, type ReactElement } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import type {
  Conversation,
  ConversationId,
  Item,
  ModelConfig,
  PluginEntry,
} from "@harness/protocol";
import { defaultHome } from "@harness/config";
import { SqliteStore } from "@harness/store-sqlite";
import { localExecutionPlugin } from "@harness/execution";
import { workspacePlugin } from "@harness/workspace";
import { approvalPlugin } from "@harness/approval";
import { HarnessService } from "@harness/service";
import { createOpenAIPlugin } from "@harness/openai-api";
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
}

type Start = { kind: "session"; session: Session } | { kind: "picker" };

interface Harness {
  service: HarnessService;
  store: SqliteStore;
  model: ModelConfig;
}

/** Composition root: the durable store, a model plugin, and the execution/approval stack. */
function buildHarness(): Harness {
  const store = new SqliteStore(join(defaultHome(), "store.db"));
  const apiKey = process.env.OPENAI_API_KEY;
  const modelPlugin: PluginEntry = apiKey
    ? createOpenAIPlugin({ apiKey })
    : { id: "demo", providers: () => [new DemoProvider()] };
  const model: ModelConfig = apiKey
    ? { provider: "openai", model: process.env.OPENAI_MODEL ?? "gpt-5.1" }
    : { provider: "demo", model: "demo-1" };
  const service = new HarnessService({
    store,
    plugins: [modelPlugin, localExecutionPlugin, workspacePlugin, approvalPlugin],
  });
  return { service, store, model };
}

async function loadSession(service: HarnessService, id: string): Promise<Session> {
  const conversation = await service.getConversation(id as ConversationId);
  if (!conversation) throw new Error(`unknown conversation: ${id}`);
  return { conversation, items: await service.getItems(conversation.id) };
}

/** Parses launch flags into a running TUI: new session, resume by id, or resume picker. */
export async function launch(opts: LaunchOptions = {}): Promise<void> {
  const { service, store, model } = buildHarness();
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
    const modelConfig = opts.model ? { ...model, model: opts.model } : model;
    const conversation = await service.createConversation({
      cwd,
      overrides: { instructions: INSTRUCTIONS, model: modelConfig },
    });
    console.log(`conversation ${conversation.id}`);
    created.add(conversation.id);
    start = { kind: "session", session: { conversation, items: [] } };
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
