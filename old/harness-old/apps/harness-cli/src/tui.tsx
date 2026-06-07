import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, usePaste } from "ink";
import type { OpenAIChatGptAuthManager } from "@harness/auth-openai";
import type { InProcessHarnessService } from "@harness/service";
import type { ActivityRecord, ConversationRecord, HarnessEvent, InteractionRequest, JsonValue, ProfileConfig } from "@harness/protocol";
import { renderContentBlocks } from "./render.ts";

export interface TuiOptions {
  profile?: string;
  projectPath?: string;
  profileOverrides?: Partial<ProfileConfig>;
  openAIAuth?: OpenAIChatGptAuthManager;
}

export interface SlashCommand {
  name: string;
  args: string[];
}

export async function runTui(service: InProcessHarnessService, options: TuiOptions = {}): Promise<void> {
  const instance = render(<HarnessTui service={service} options={options} />);
  await instance.waitUntilExit();
}

export function parseSlashCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const parts = trimmed.slice(1).split(/\s+/u).filter((part) => part.length > 0);
  const name = parts.shift();
  return name ? { name, args: parts } : undefined;
}

function useHarnessConversation(service: InProcessHarnessService, options: TuiOptions) {
  const [conversation, setConversation] = useState<ConversationRecord | undefined>();
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [interactions, setInteractions] = useState<InteractionRequest[]>([]);
  const [composer, setComposer] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();
  const [statusMessage, setStatusMessage] = useState("starting");
  const lastEventSequenceRef = useRef(0);
  const outputCursorsRef = useRef(new Map<string, number>());
  const pendingOperationsRef = useRef(new Set<Promise<unknown>>());

  const resetConversationState = useCallback((next: ConversationRecord) => {
    lastEventSequenceRef.current = 0;
    outputCursorsRef.current = new Map();
    setConversation(next);
    setEvents([]);
    setOutputLines([]);
    setActivities([]);
    setInteractions([]);
  }, []);

  const trackOperation = useCallback((operation: Promise<unknown>) => {
    pendingOperationsRef.current.add(operation);
    void operation.finally(() => {
      pendingOperationsRef.current.delete(operation);
    });
  }, []);

  const waitForPendingOperations = useCallback(async () => {
    await Promise.allSettled([...pendingOperationsRef.current]);
  }, []);

  const createConversation = useCallback(async () => {
    const created = await service.createProjectlessConversation({
      ...(options.profile ? { profile: options.profile } : {}),
      ...(options.profileOverrides ? { profileOverrides: options.profileOverrides } : {}),
      title: "interactive"
    });
    const bound = options.projectPath ? await service.bindHostProject(created.id, options.projectPath) : created;
    resetConversationState(bound);
    setStatusMessage(`conversation ${bound.id}`);
  }, [service, options.profile, options.profileOverrides, options.projectPath, resetConversationState]);

  useEffect(() => {
    void createConversation().catch((error: unknown) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [createConversation]);

  useEffect(() => {
    if (!conversation) {
      return undefined;
    }
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) {
        return;
      }
      polling = true;
      try {
        const latestConversation = await service.getConversation(conversation.id);
        if (latestConversation && !cancelled) {
          setConversation(latestConversation);
        }
        const nextEvents = await service.listEvents(conversation.id, { after: lastEventSequenceRef.current, limit: 50 });
        if (nextEvents.length > 0 && !cancelled) {
          lastEventSequenceRef.current = nextEvents.at(-1)?.sequence ?? lastEventSequenceRef.current;
          setEvents((current) => [...current, ...nextEvents].slice(-160));
        }
        const nextActivities = await service.listActivities(conversation.id);
        const nextInteractions = await service.listPendingInteractions(conversation.id);
        if (!cancelled) {
          setActivities(nextActivities);
          setInteractions(nextInteractions);
        }
        const liveOutput = await Promise.all(nextActivities.map(async (activity) => service.peekActivityOutput(activity.id, { limit: 50 })));
        const newLines = liveOutput.flatMap((preview) => {
          if (!preview) {
            return [];
          }
          return preview.frames.flatMap((frame) => {
            const after = outputCursorsRef.current.get(frame.channelId);
            if (after !== undefined && frame.sequence <= after) {
              return [];
            }
            outputCursorsRef.current.set(frame.channelId, frame.sequence);
            return [`${frame.name}> ${frame.text ?? JSON.stringify(frame.payload ?? {})}`];
          });
        });
        if (newLines.length > 0 && !cancelled) {
          setOutputLines((current) => [...current, ...newLines].slice(-80));
        }
      } catch (error) {
        if (!cancelled) {
          setStatusMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [service, conversation?.id]);

  return {
    conversation,
    events,
    outputLines,
    activities,
    interactions,
    statusMessage,
    setStatusMessage,
    createConversation,
    resetConversationState,
    trackOperation,
    waitForPendingOperations
  };
}

interface TranscriptProps {
  events: HarnessEvent[];
  outputLines: string[];
}

function Transcript({ events, outputLines }: TranscriptProps) {
  const transcript = useMemo(() => transcriptLines(events, outputLines).slice(-24), [events, outputLines]);
  return (
    <>
      {transcript.map((line, index) => (
        <Text key={`line-${index}`} {...(line.color ? { color: line.color } : {})}>
          {line.text}
        </Text>
      ))}
    </>
  );
}

interface PendingInteractionProps {
  interaction: InteractionRequest | undefined;
}

function PendingInteraction({ interaction }: PendingInteractionProps) {
  if (!interaction) {
    return null;
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">
        Pending {interaction.kind}: {renderContentBlocks(interaction.prompt ?? [])}
      </Text>
    </Box>
  );
}

interface StatusBarProps {
  conversation: ConversationRecord | undefined;
  activeActivitiesCount: number;
  options: TuiOptions;
}

function StatusBar({ conversation, activeActivitiesCount, options }: StatusBarProps) {
  const model = conversation?.effectiveProfile.config.model;
  const approval = conversation?.effectiveProfile.config.approvalPolicy.mode ?? "?";
  const isChatGptProfile = model?.provider === "openai-chatgpt";

  return (
    <Text inverse>
      {` ${conversation?.status ?? "starting"} | ${model?.provider ?? "?"}/${model?.modelId ?? "?"} | auth ${isChatGptProfile ? "chatgpt" : "env"} | approvals ${approval} | ${options.projectPath ?? "no project"} | activities ${activeActivitiesCount} `}
    </Text>
  );
}

function HarnessTui({ service, options }: { service: InProcessHarnessService; options: TuiOptions }) {
  const { exit } = useApp();
  const {
    conversation,
    events,
    outputLines,
    activities,
    interactions,
    statusMessage,
    setStatusMessage,
    createConversation,
    resetConversationState,
    trackOperation,
    waitForPendingOperations
  } = useHarnessConversation(service, options);

  const [composer, setComposer] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();

  const handleSubmit = useCallback((value: string) => {
    const text = value.trim();
    if (text.length === 0) {
      return;
    }

    const slash = parseSlashCommand(text);
    if (slash) {
      setHistory((current) => [...current, text].slice(-100));
      setHistoryIndex(undefined);
      setComposer("");
      void handleSlashCommand(slash, {
        service,
        conversation,
        activities,
        interactions,
        createConversation,
        exit,
        ...(options.openAIAuth ? { openAIAuth: options.openAIAuth } : {}),
        setConversation: resetConversationState,
        waitForPendingOperations,
        setStatusMessage
      }).catch((error: unknown) => {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      });
      return;
    }

    const pending = interactions[0];
    if (pending) {
      setHistory((current) => [...current, text].slice(-100));
      setHistoryIndex(undefined);
      setComposer("");
      trackOperation(answerPendingInteraction(service, pending, text).catch((error: unknown) => {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }));
      return;
    }

    if (!conversation) {
      setStatusMessage("conversation is not ready");
      return;
    }
    setHistory((current) => [...current, text].slice(-100));
    setHistoryIndex(undefined);
    setComposer("");
    trackOperation(service.sendConversationInput({
      conversationId: conversation.id,
      message: [{ type: "text", text }],
      delivery: "asap"
    }).catch((error: unknown) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }));
  }, [activities, conversation, createConversation, exit, interactions, options.openAIAuth, resetConversationState, service, trackOperation, waitForPendingOperations, setStatusMessage]);

  useInput((input, key) => {
    if (key.return) {
      handleSubmit(composer);
      return;
    }
    if (key.backspace || key.delete) {
      setComposer((current) => current.slice(0, -1));
      return;
    }
    if (key.upArrow) {
      setHistoryIndex((current) => {
        const next = current === undefined ? history.length - 1 : Math.max(0, current - 1);
        setComposer(history[next] ?? "");
        return next;
      });
      return;
    }
    if (key.downArrow) {
      setHistoryIndex((current) => {
        if (current === undefined) {
          return undefined;
        }
        const next = current + 1;
        if (next >= history.length) {
          setComposer("");
          return undefined;
        }
        setComposer(history[next] ?? "");
        return next;
      });
      return;
    }
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (input.length > 0) {
      setComposer((current) => `${current}${input}`);
    }
  });

  usePaste((text) => {
    setComposer((current) => `${current}${text}`);
  });

  const activeActivitiesCount = activities.filter((activity) => activity.status === "running" || activity.status === "waiting" || activity.status === "queued").length;

  return (
    <Box flexDirection="column">
      <Text bold>Harness</Text>
      <Transcript events={events} outputLines={outputLines} />
      <PendingInteraction interaction={interactions[0]} />
      <StatusBar
        conversation={conversation}
        activeActivitiesCount={activeActivitiesCount}
        options={options}
      />
      <Text color="cyan">{`> ${composer}`}</Text>
      <Text dimColor>{statusMessage}</Text>
    </Box>
  );
}

async function handleSlashCommand(command: SlashCommand, context: {
  service: InProcessHarnessService;
  conversation: ConversationRecord | undefined;
  activities: ActivityRecord[];
  interactions: InteractionRequest[];
  createConversation: () => Promise<void>;
  exit: () => void;
  openAIAuth?: OpenAIChatGptAuthManager;
  setConversation: (conversation: ConversationRecord) => void;
  waitForPendingOperations: () => Promise<void>;
  setStatusMessage: (message: string) => void;
}): Promise<void> {
  switch (command.name) {
    case "help":
      context.setStatusMessage("/help /status /model /permissions /login /new /resume /compact /activities /subagents /exit");
      return;
    case "status":
      context.setStatusMessage(context.conversation ? `conversation ${context.conversation.id} ${context.conversation.status}` : "no conversation");
      return;
    case "model": {
      const model = context.conversation?.effectiveProfile.config.model;
      context.setStatusMessage(model ? `${model.provider}/${model.modelId} adapter=${model.adapter}` : "no model");
      return;
    }
    case "permissions": {
      const policy = context.conversation?.effectiveProfile.config.approvalPolicy;
      context.setStatusMessage(policy ? `${policy.mode} allow=${policy.allowTools.join(",") || "-"} deny=${policy.denyTools.join(",") || "-"}` : "no permissions");
      return;
    }
    case "login": {
      if (!context.openAIAuth) {
        context.setStatusMessage("auth manager unavailable");
        return;
      }
      const useDevice = command.args[0] === "device";
      context.setStatusMessage(useDevice ? "starting device login" : "starting browser login");
      const session = useDevice
        ? await context.openAIAuth.loginWithDeviceCode({
            onDeviceCode(info) {
              context.setStatusMessage(`open ${info.verificationUrl} code ${info.userCode}`);
            }
          })
        : await context.openAIAuth.loginWithBrowser({
            onAuthUrl(url) {
              context.setStatusMessage(`open ${url}`);
            }
          });
      context.setStatusMessage(`logged in ${session.accountId}`);
      return;
    }
    case "new":
      await context.createConversation();
      return;
    case "resume": {
      const id = command.args[0];
      if (!id) {
        context.setStatusMessage("usage: /resume <conversation-id>");
        return;
      }
      const conversation = await context.service.getConversation(id);
      if (!conversation) {
        context.setStatusMessage(`conversation ${id} not found`);
        return;
      }
      context.setConversation(conversation);
      context.setStatusMessage(`resumed ${conversation.id}`);
      return;
    }
    case "compact":
      if (!context.conversation) {
        context.setStatusMessage("no conversation");
        return;
      }
      await context.service.runCompaction(context.conversation.id);
      context.setStatusMessage("compaction complete");
      return;
    case "activities":
      context.setStatusMessage(context.activities.length === 0 ? "no activities" : context.activities.map((activity) => `${activity.id}:${activity.status}:${activity.label}`).join(" | "));
      return;
    case "subagents": {
      const subagents = context.activities.filter((activity) => activity.kind === "plugin.subagents.run");
      context.setStatusMessage(subagents.length === 0 ? "no subagents" : subagents.map((activity) => `${activity.id}:${activity.status}`).join(" | "));
      return;
    }
    case "exit":
      await context.waitForPendingOperations();
      context.exit();
      return;
    default:
      context.setStatusMessage(`unknown slash command: /${command.name}`);
  }
}

async function answerPendingInteraction(service: InProcessHarnessService, interaction: InteractionRequest, text: string): Promise<void> {
  if (interaction.kind === "approval") {
    const normalized = text.toLowerCase();
    await service.answerInteraction(interaction.id, { approved: normalized === "y" || normalized === "yes" || normalized === "approve" });
    return;
  }
  await service.answerInteraction(interaction.id, { text } as JsonValue);
}

function transcriptLines(events: HarnessEvent[], outputLines: string[]): Array<{ text: string; color?: string }> {
  const eventLines = events.map((event) => {
    if (event.type === "message.created" && isRecord(event.payload)) {
      const role = typeof event.payload.role === "string" ? event.payload.role : "message";
      return { text: `${role}> ${renderPayloadContent(event.payload.content)}`, color: role === "assistant" ? "green" : role === "user" ? "white" : "gray" };
    }
    if (event.type.startsWith("tool.")) {
      return { text: `tool> ${event.type} ${JSON.stringify(event.payload)}`, color: "magenta" };
    }
    if (event.type.startsWith("activity.")) {
      return { text: `activity> ${event.type} ${JSON.stringify(event.payload)}`, color: "blue" };
    }
    if (event.type === "model.failed") {
      return { text: `model> failed ${JSON.stringify(event.payload)}`, color: "red" };
    }
    return { text: `event> ${event.type}`, color: "gray" };
  });
  return [...eventLines, ...outputLines.map((text) => ({ text, color: "green" }))];
}

function renderPayloadContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return renderContentBlocks(value as Parameters<typeof renderContentBlocks>[0]).replace(/\s+/gu, " ").slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
