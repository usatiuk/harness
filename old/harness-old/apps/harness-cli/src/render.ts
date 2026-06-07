import type {
  ActivityRecord,
  ArtifactRecord,
  AssetRecord,
  ContentBlock,
  ContextBlock,
  ContextBuild,
  EffectiveProfile,
  HarnessEvent,
  InteractionRequest,
  ProfileRecord,
  ConversationRecord,
  StateNamespaceRecord,
  TurnState,
  TurnRecord
} from "@harness/protocol";
import type { RenderNode } from "@harness/ui-protocol";

export function renderProfiles(profiles: ProfileRecord[]): string {
  if (profiles.length === 0) {
    return "No profiles.";
  }
  return profiles.map((profile) => `${profile.id}\t${profile.name}\t${profile.config.model.provider}/${profile.config.model.modelId}\tadapter=${profile.config.model.adapter}`).join("\n");
}

export function renderConversations(conversations: ConversationRecord[]): string {
  if (conversations.length === 0) {
    return "No conversations.";
  }
  return conversations.map((conversation) => `${conversation.id}\t${conversation.status}\t${conversation.title ?? ""}`).join("\n");
}

export function renderEvents(events: HarnessEvent[]): string {
  if (events.length === 0) {
    return "No events.";
  }
  return events.map((event) => `${event.sequence}\t${event.type}\t${JSON.stringify(event.payload)}`).join("\n");
}

export function renderActivities(activities: ActivityRecord[]): string {
  if (activities.length === 0) {
    return "No activities.";
  }
  return activities.map((activity) => `${activity.id}\t${activity.kind}\t${activity.status}\t${activity.label}`).join("\n");
}

export function renderTurns(turns: TurnRecord[]): string {
  if (turns.length === 0) {
    return "No turns.";
  }
  return turns.map((turn) => `${turn.id}\t${turn.status}\tmessages=${turn.inputMessageIds.length}`).join("\n");
}

export function renderAssets(assets: AssetRecord[]): string {
  if (assets.length === 0) {
    return "No assets.";
  }
  return assets.map((asset) => `${asset.id}\t${asset.mimeType}\t${asset.byteSize}\t${asset.uri}`).join("\n");
}

export function renderArtifacts(artifacts: ArtifactRecord[]): string {
  if (artifacts.length === 0) {
    return "No artifacts.";
  }
  return artifacts.map((artifact) => `${artifact.id}\t${artifact.kind}\t${artifact.uri ?? ""}`).join("\n");
}

export function renderState(states: StateNamespaceRecord[]): string {
  if (states.length === 0) {
    return "No state namespaces.";
  }
  return states.map((state) => `${state.namespace}@${state.version}\t${JSON.stringify(state.value)}`).join("\n");
}

export function renderInteractions(interactions: InteractionRequest[]): string {
  if (interactions.length === 0) {
    return "No interactions.";
  }
  return interactions.map((interaction) => `${interaction.id}\t${interaction.status}\t${interaction.kind}\tturn=${interaction.turnId}`).join("\n");
}

export function renderTurnState(state: TurnState | undefined): string {
  if (!state) {
    return "No turn state.";
  }
  return `${state.id}\t${state.phase}\tturn=${state.turnId}\tactivity=${state.activeActivityId ?? ""}\ttool=${state.activeToolExecutionId ?? ""}`;
}

export function renderContextBlocks(blocks: ContextBlock[]): string {
  if (blocks.length === 0) {
    return "No context blocks.";
  }
  return blocks.map((block) => `${block.id}\t${block.kind}\tturn=${block.turnId ?? ""}\titems=${block.content.length}`).join("\n");
}

export function renderContextBuilds(builds: ContextBuild[]): string {
  if (builds.length === 0) {
    return "No context builds.";
  }
  return builds.map((build) => `${build.id}\t${build.modelConfig.provider}/${build.modelConfig.modelId}\tpolicy=${build.policyId}\tturn=${build.turnId ?? ""}`).join("\n");
}

export function renderEffectiveConfig(config: EffectiveProfile): string {
  return JSON.stringify(config, null, 2);
}

export function renderContentBlocks(blocks: ContentBlock[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case "text":
        return block.text;
      case "image_ref":
      case "file_ref":
      case "audio_ref":
      case "pdf_ref":
        return `[${block.type}:${block.assetId}]`;
      case "artifact_ref":
        return `[artifact:${block.artifactId}]`;
      case "interaction_ref":
        return `[interaction:${block.interactionId}]`;
      case "activity_ref":
        return `[activity:${block.activityId}]`;
      case "data":
        return JSON.stringify(block.data);
      case "tool_call_ref":
        return `[tool_call:${block.toolName}:${block.toolCallId}]`;
      case "tool_result_ref":
        return `[tool_result:${block.status}:${block.toolExecutionId}]`;
    }
  }).join("\n");
}

export function renderNode(node: RenderNode): string {
  switch (node.type) {
    case "text":
      return node.text;
    case "markdown":
      return node.markdown;
    case "code":
      return node.code;
    case "diff":
      return node.diff;
    case "table":
      return [node.columns.join("\t"), ...node.rows.map((row) => row.join("\t"))].join("\n");
    case "tree":
    case "raw_json":
      return JSON.stringify(node.value, null, 2);
    case "form":
      return node.fields.map((field) => `${field.name}\t${field.label}\t${field.kind}`).join("\n");
    case "progress":
      return `${node.label}\t${node.value ?? 0}/${node.total ?? "?"}`;
    case "link":
      return `${node.label}\t${node.href}`;
    case "asset_preview":
      return `[asset:${node.assetId}] ${node.label ?? ""}`;
    case "file_ref":
      return `[file:${node.assetId}] ${node.filename ?? ""}`;
  }
}
