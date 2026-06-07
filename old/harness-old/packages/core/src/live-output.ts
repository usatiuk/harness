import { nowIso } from "./ids.ts";
import type { ContentBlock, JsonValue, SourceRef } from "@harness/protocol";

export type OutputKind = "stdout" | "stderr" | "model_text" | "model_reasoning" | "log" | "progress" | "jsonl" | "binary";

export interface OutputScope {
  conversationId?: string;
  turnId?: string;
  source?: SourceRef;
  activityId?: string;
  toolExecutionId?: string;
  channelId?: string;
  kind?: OutputKind;
}

export interface OutputChannelOpen {
  conversationId: string;
  turnId?: string;
  source: SourceRef;
  activityId?: string;
  toolExecutionId?: string;
  name: string;
  kind: OutputKind;
}

export interface OutputFrameInput {
  text?: string;
  payload?: JsonValue;
}

export interface OutputFrame {
  channelId: string;
  sequence: number;
  conversationId: string;
  turnId?: string;
  source: SourceRef;
  activityId?: string;
  toolExecutionId?: string;
  name: string;
  kind: OutputKind;
  text?: string;
  payload?: JsonValue;
  createdAt: string;
}

export interface OutputChannelPreview {
  channelId: string;
  conversationId: string;
  turnId?: string;
  source: SourceRef;
  activityId?: string;
  toolExecutionId?: string;
  name: string;
  kind: OutputKind;
  frameCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OutputPreview {
  channels: OutputChannelPreview[];
  frames: OutputFrame[];
  truncated: boolean;
}

export interface OutputPeekOptions {
  after?: number;
  limit?: number;
}

export type OutputFrameListener = (frame: OutputFrame) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface OutputChannelHandle {
  id: string;
  append(frame: OutputFrameInput): Promise<OutputFrame>;
  close(): Promise<void>;
}

export interface LiveOutputSink {
  openChannel(input: OutputChannelOpen): OutputChannelHandle;
  peek(scope: OutputScope, input?: OutputPeekOptions): OutputPreview | undefined;
  subscribe?(scope: OutputScope, listener: OutputFrameListener): Unsubscribe;
}

interface ChannelState extends OutputChannelPreview {
  frames: OutputFrame[];
  closed: boolean;
}

export class InMemoryLiveOutputSink implements LiveOutputSink {
  private readonly channels = new Map<string, ChannelState>();
  private readonly listeners = new Set<{ scope: OutputScope; listener: OutputFrameListener }>();

  public constructor(private readonly options: { maxFramesPerChannel?: number; maxCharsPerFrame?: number } = {}) {}

  public openChannel(input: OutputChannelOpen): OutputChannelHandle {
    const channelId = createOutputChannelId(input);
    const timestamp = nowIso();
    const state: ChannelState = {
      channelId,
      conversationId: input.conversationId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      source: input.source,
      ...(input.activityId ? { activityId: input.activityId } : {}),
      ...(input.toolExecutionId ? { toolExecutionId: input.toolExecutionId } : {}),
      name: input.name,
      kind: input.kind,
      frameCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      frames: [],
      closed: false
    };
    this.channels.set(channelId, state);
    return {
      id: channelId,
      append: async (frame) => this.appendFrame(channelId, frame),
      close: async () => {
        const current = this.channels.get(channelId);
        if (current) {
          current.closed = true;
          current.updatedAt = nowIso();
        }
      }
    };
  }

  public peek(scope: OutputScope, input?: OutputPeekOptions): OutputPreview | undefined {
    const channels = [...this.channels.values()].filter((channel) => matchesScope(channel, scope));
    if (channels.length === 0) {
      return undefined;
    }
    const after = input?.after ?? -1;
    const limit = input?.limit ?? 100;
    const matchingFrames = channels
      .flatMap((channel) => channel.frames)
      .filter((frame) => frame.sequence > after && matchesScope(frame, scope))
      .sort((left, right) => left.sequence - right.sequence);
    const frames = matchingFrames.slice(Math.max(0, matchingFrames.length - limit));
    return {
      channels: channels.map(({ frames: _frames, closed: _closed, ...channel }) => channel),
      frames,
      truncated: matchingFrames.length > frames.length
    };
  }

  public subscribe(scope: OutputScope, listener: OutputFrameListener): Unsubscribe {
    const entry = { scope, listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  private async appendFrame(channelId: string, input: OutputFrameInput): Promise<OutputFrame> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error(`Live output channel ${channelId} is not open`);
    }
    if (channel.closed) {
      throw new Error(`Live output channel ${channelId} is closed`);
    }
    const text = input.text === undefined ? undefined : boundedPreviewText(input.text, this.options.maxCharsPerFrame ?? 8000);
    const frame: OutputFrame = {
      channelId,
      sequence: channel.frameCount,
      conversationId: channel.conversationId,
      ...(channel.turnId ? { turnId: channel.turnId } : {}),
      source: channel.source,
      ...(channel.activityId ? { activityId: channel.activityId } : {}),
      ...(channel.toolExecutionId ? { toolExecutionId: channel.toolExecutionId } : {}),
      name: channel.name,
      kind: channel.kind,
      ...(text === undefined ? {} : { text }),
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      createdAt: nowIso()
    };
    channel.frameCount += 1;
    channel.updatedAt = frame.createdAt;
    channel.frames.push(frame);
    const maxFrames = this.options.maxFramesPerChannel ?? 200;
    if (channel.frames.length > maxFrames) {
      channel.frames.splice(0, channel.frames.length - maxFrames);
    }
    await Promise.all([...this.listeners]
      .filter((entry) => matchesScope(frame, entry.scope))
      .map(async (entry) => {
        try {
          await entry.listener(frame);
        } catch {
          // Live output is best-effort and must not change tool/model execution.
        }
      }));
    return frame;
  }
}

export class NullLiveOutputSink implements LiveOutputSink {
  public openChannel(input: OutputChannelOpen): OutputChannelHandle {
    const id = createOutputChannelId(input);
    return {
      id,
      append: async (frame) => ({
        channelId: id,
        sequence: 0,
        conversationId: input.conversationId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        source: input.source,
        ...(input.activityId ? { activityId: input.activityId } : {}),
        ...(input.toolExecutionId ? { toolExecutionId: input.toolExecutionId } : {}),
        name: input.name,
        kind: input.kind,
        ...(frame.text === undefined ? {} : { text: frame.text }),
        ...(frame.payload === undefined ? {} : { payload: frame.payload }),
        createdAt: nowIso()
      }),
      close: async () => {}
    };
  }

  public peek(): OutputPreview | undefined {
    return undefined;
  }
}

export interface OutputChunk {
  kind: OutputKind;
  text: string;
}

export interface ToolOutputFinalInput {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  metadata?: Record<string, JsonValue>;
}

export interface ToolOutputPresentation {
  content: ContentBlock[];
  data: JsonValue;
}

export interface ToolOutputPresenter {
  observeChunk?(chunk: OutputChunk): void;
  prepareFinal(input: ToolOutputFinalInput): Promise<ToolOutputPresentation>;
}

export type ToolOutputPresenterFactory = (input: {
  toolName: string;
  callId: string;
  metadata?: Record<string, JsonValue>;
}) => ToolOutputPresenter;

export function createDefaultToolOutputPresenter(): ToolOutputPresenter {
  return new BoundedToolOutputPresenter();
}

export class BoundedToolOutputPresenter implements ToolOutputPresenter {
  private readonly buffers = new Map<OutputKind, BoundedTextBuffer>();

  public constructor(private readonly options: { maxCharsPerKind?: number } = {}) {}

  public observeChunk(chunk: OutputChunk): void {
    let buffer = this.buffers.get(chunk.kind);
    if (!buffer) {
      buffer = new BoundedTextBuffer(this.options.maxCharsPerKind ?? 4000);
      this.buffers.set(chunk.kind, buffer);
    }
    buffer.append(chunk.text);
  }

  public async prepareFinal(input: ToolOutputFinalInput): Promise<ToolOutputPresentation> {
    const outputs = Object.fromEntries([...this.buffers.entries()].map(([kind, buffer]) => [kind, buffer.snapshot()])) as Record<string, JsonValue>;
    const content: ContentBlock[] = [];
    for (const [kind, value] of Object.entries(outputs)) {
      if (isOutputSnapshot(value) && value.text.length > 0) {
        content.push({ type: "text", text: `${kind}:\n${value.text}` });
      }
    }
    content.push({
      type: "data",
      label: "output",
      data: {
        status: input.status,
        summary: input.summary,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        outputs
      }
    });
    return {
      content,
      data: {
        output: outputs
      }
    };
  }
}

class BoundedTextBuffer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private stored = "";
  private head = "";
  private tail = "";
  private truncated = false;
  private charCount = 0;
  private byteCount = 0;

  public constructor(private readonly maxChars: number) {
    this.headLimit = Math.ceil(maxChars / 2);
    this.tailLimit = Math.floor(maxChars / 2);
  }

  public append(text: string): void {
    this.charCount += text.length;
    this.byteCount += Buffer.byteLength(text, "utf8");
    if (!this.truncated && this.stored.length + text.length <= this.maxChars) {
      this.stored += text;
      return;
    }
    if (!this.truncated) {
      const headRemainder = Math.max(0, this.headLimit - this.stored.length);
      this.head = `${this.stored}${text.slice(0, headRemainder)}`.slice(0, this.headLimit);
      this.tail = text.length >= this.tailLimit
        ? text.slice(-this.tailLimit)
        : `${this.stored.slice(-(this.tailLimit - text.length))}${text}`.slice(-this.tailLimit);
      this.stored = "";
      this.truncated = true;
      return;
    }
    this.tail = `${this.tail}${text}`.slice(-this.tailLimit);
  }

  public snapshot(): { text: string; charCount: number; byteCount: number; truncated: boolean; omittedChars: number } {
    if (!this.truncated) {
      return {
        text: this.stored,
        charCount: this.charCount,
        byteCount: this.byteCount,
        truncated: false,
        omittedChars: 0
      };
    }
    const omittedChars = Math.max(0, this.charCount - this.head.length - this.tail.length);
    return {
      text: `${this.head}\n[... truncated ${omittedChars} chars ...]\n${this.tail}`,
      charCount: this.charCount,
      byteCount: this.byteCount,
      truncated: true,
      omittedChars
    };
  }
}

function createOutputChannelId(input: OutputChannelOpen): string {
  return [
    "out",
    input.conversationId,
    input.turnId ?? "none",
    input.source.type,
    input.source.id ?? "none",
    input.toolExecutionId ?? "none",
    input.activityId ?? "none",
    input.kind,
    input.name,
    Math.random().toString(36).slice(2)
  ].join("_");
}

function boundedPreviewText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const headLimit = Math.ceil(maxChars / 2);
  const tailLimit = Math.floor(maxChars / 2);
  const head = text.slice(0, headLimit);
  const tail = text.slice(-tailLimit);
  const omittedChars = Math.max(0, text.length - head.length - tail.length);
  return `${head}\n[... live output truncated ${omittedChars} chars ...]\n${tail}`;
}

function matchesScope(value: OutputFrame | ChannelState, scope: OutputScope): boolean {
  return (scope.conversationId === undefined || value.conversationId === scope.conversationId) &&
    (scope.turnId === undefined || value.turnId === scope.turnId) &&
    (scope.channelId === undefined || value.channelId === scope.channelId) &&
    (scope.kind === undefined || value.kind === scope.kind) &&
    (scope.activityId === undefined || value.activityId === scope.activityId) &&
    (scope.toolExecutionId === undefined || value.toolExecutionId === scope.toolExecutionId) &&
    (scope.source === undefined || (value.source.type === scope.source.type && value.source.id === scope.source.id));
}

function isOutputSnapshot(value: JsonValue): value is { text: string; charCount: number; byteCount: number; truncated: boolean; omittedChars: number } {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.text === "string";
}
