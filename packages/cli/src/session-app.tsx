import { useEffect, useRef, useState, type ReactElement } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ConfirmInput, Spinner } from "@inkjs/ui";
import type {
  Conversation,
  ConversationId,
  Item,
  ModelConfig,
  ModelUsageSummary,
} from "@harness/protocol";
import { formatError } from "@harness/protocol";
import type { SettingsDoc } from "@harness/config";
import { App, type SessionMutation } from "./app.tsx";
import { type CliPlugins } from "./client-plugins.ts";
import { ResumePicker } from "./resume-picker.tsx";
import type { CliService } from "./client-harness.ts";
const INSTRUCTIONS = "You are a helpful coding agent.";

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

export type Start = { kind: "session"; session: Session } | { kind: "picker" };

export async function loadSession(service: CliService, id: string): Promise<Session> {
  const conversation = await service.attachedConversation(id as ConversationId);
  if (!conversation) throw new Error(`unknown conversation: ${id}`);
  const [items, usage] = await Promise.all([
    service.getItems(conversation.id),
    service.usageSummary(conversation.id),
  ]);
  return { conversation, items, usage };
}

interface RootProps {
  service: CliService;
  plugins: CliPlugins;
  providerLabels?: Readonly<Record<string, string>>;
  start: Start;
  cwd: string;
  onActive: (id: ConversationId | undefined) => void;
  onHosts?: () => void;
  drafts?: Map<string, string>;
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
  onHosts,
  drafts,
}: RootProps): ReactElement | null {
  const { exit } = useApp();
  const [session, setSession] = useState<Session | null>(
    start.kind === "session" ? start.session : null,
  );
  const [picking, setPicking] = useState(start.kind === "picker");
  const [generation, setGeneration] = useState(0);
  const [transitioning, setTransitioning] = useState<string | undefined>();
  const [notice, setNotice] = useState<{ id: number; text: string }>();
  const [localDrafts] = useState(() => new Map<string, string>());
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
      {...(onHosts ? { onHosts } : {})}
      drafts={drafts ?? localDrafts}
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
