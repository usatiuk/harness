import type {
  ActivityRecord,
  ActivityStatus,
  ArtifactRecord,
  AssetOrigin,
  AssetRecord,
  ContextBlock,
  ContentBlock,
  InteractionKind,
  InteractionOrigin,
  InteractionRequest,
  JsonValue,
  ConversationRecord,
  ToolCall,
  ToolResult
} from "@harness/protocol";
import type { ExecutionRuntime } from "./execution.ts";
import type { OutputChannelHandle, OutputKind, OutputPeekOptions, OutputPreview, ToolOutputPresenter } from "./live-output.ts";

export interface ToolExecutionIo {
  openLiveOutput(input: { activityId?: string; name: string; kind: OutputKind }): Promise<OutputChannelHandle>;
  peekActivityOutput(activityId: string, input?: OutputPeekOptions): Promise<OutputPreview | undefined>;
  createOutputPresenter(input?: { metadata?: Record<string, JsonValue> }): ToolOutputPresenter;
  createAsset(input: {
    uri: string;
    mimeType: string;
    byteSize: number;
    sha256?: string;
    origin: AssetOrigin;
    metadata?: Record<string, JsonValue>;
    derivedFromAssetId?: string;
  }): Promise<AssetRecord>;
  createArtifact(input: { kind: string; uri?: string; metadata?: Record<string, JsonValue> }): Promise<ArtifactRecord>;
  createInteraction(input: {
    origin?: InteractionOrigin;
    kind: InteractionKind;
    prompt: ContentBlock[];
    requestedSchema?: JsonValue;
    render?: InteractionRequest["render"];
  }): Promise<InteractionRequest>;
  createContextBlock(input: {
    kind: ContextBlock["kind"];
    content?: ContentBlock[];
    data?: JsonValue;
    metadata?: Record<string, JsonValue>;
  }): Promise<ContextBlock>;

  // Activity Control Methods
  createActivity(input: {
    ownerPluginId: string;
    kind: string;
    label: string;
    status?: ActivityStatus;
    cancellable?: boolean;
    activityState?: JsonValue;
    onCompletion?: { delivery: "asap" | "after_active" | "manual" };
  }): Promise<ActivityRecord>;
  completeActivity(id: string, result: JsonValue, status?: "completed" | "failed" | "cancelled"): Promise<ActivityRecord>;
  getActivity(id: string): Promise<ActivityRecord | undefined>;
  cancelActivity(id: string): Promise<void>;
  getActivityStatus(id: string): Promise<JsonValue>;
}

export type ToolExecutionOutcome =
  | { status: "completed"; result: ToolResult }
  | { status: "waiting"; interactionIds: string[]; activityIds?: string[]; resumeState?: JsonValue };

export interface HarnessTool {
  name: string;
  description: string;
  visibility?: "model" | "ui" | "both";
  inputSchema?: JsonValue;
  requiresExecutionContext: boolean;
  execute(input: {
    call: ToolCall;
    conversation: ConversationRecord;
    activity: ActivityRecord | undefined;
    runtime: ExecutionRuntime | undefined;
    io: ToolExecutionIo;
  }): Promise<ToolResult | ToolExecutionOutcome>;
  resume?(input: {
    call: ToolCall;
    conversation: ConversationRecord;
    activity: ActivityRecord | undefined;
    runtime: ExecutionRuntime | undefined;
    io: ToolExecutionIo;
    resumeState?: JsonValue;
    interactions: InteractionRequest[];
  }): Promise<ToolResult | ToolExecutionOutcome>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, HarnessTool>();

  public register(tool: HarnessTool): void {
    this.tools.set(tool.name, tool);
  }

  public get(name: string): HarnessTool | undefined {
    return this.tools.get(name);
  }

  public list(names?: string[]): HarnessTool[] {
    if (!names || names.length === 0) {
      return [...this.tools.values()];
    }
    return names.map((name) => this.tools.get(name)).filter((tool): tool is HarnessTool => tool !== undefined);
  }
}
