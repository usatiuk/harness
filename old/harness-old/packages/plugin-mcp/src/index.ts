import type { HarnessPlugin } from "@harness/core";
import type { ContentBlock, InteractionRequest, JsonValue, McpServerConfig } from "@harness/protocol";

export const SOURCE_FIRST_MARKER = "plugin-mcp:src";
export const MCP_PLUGIN_ID = "plugin.mcp";

export interface McpServerDescriptor {
  name: string;
  config: McpServerConfig;
  source: "profile" | "conversation";
}

export function createMcpPlugin(): HarnessPlugin {
  return {
    id: MCP_PLUGIN_ID,
    async contextFragments(input) {
      const serverNames = listProfileMcpServers(readMcpServers(input.pluginConfig)).filter((server) => server.config.enabled).map((server) => server.name);
      if (serverNames.length === 0) {
        return [];
      }
      return [{ type: "text", text: `Profile MCP servers available: ${serverNames.join(", ")}` }];
    }
  };
}

export function listProfileMcpServers(config: Record<string, McpServerConfig>): McpServerDescriptor[] {
  return Object.entries(config).map(([name, server]) => ({ name, config: server, source: "profile" }));
}

export function mapMcpElicitationToInteraction(input: {
  conversationId: string;
  turnId: string;
  activityId?: string;
  prompt: ContentBlock[];
  requestedSchema?: JsonValue;
  sensitive?: boolean;
}): Omit<InteractionRequest, "id" | "status" | "response" | "createdAt" | "updatedAt"> {
  return {
    conversationId: input.conversationId,
    turnId: input.turnId,
    ...(input.activityId ? { activityId: input.activityId } : {}),
    origin: "mcp_elicitation",
    kind: "user_input",
    prompt: input.prompt,
    ...(input.requestedSchema === undefined ? {} : { requestedSchema: input.requestedSchema })
  };
}

export function readMcpServers(config: JsonValue | undefined): Record<string, McpServerConfig> {
  if (!isRecord(config)) {
    return {};
  }
  const servers = config.servers;
  if (!isRecord(servers)) {
    return {};
  }
  const result: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server)) {
      continue;
    }
    result[name] = {
      ...(typeof server.command === "string" ? { command: server.command } : {}),
      args: Array.isArray(server.args) && server.args.every((item) => typeof item === "string") ? server.args : [],
      env: isStringRecord(server.env) ? server.env : {},
      ...(typeof server.url === "string" ? { url: server.url } : {}),
      enabled: typeof server.enabled === "boolean" ? server.enabled : true
    };
  }
  return result;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: JsonValue | undefined): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
