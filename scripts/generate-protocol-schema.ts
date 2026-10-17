import {
  feedbackStatusRequest,
  feedbackConfigureRequest,
  feedbackVoteRequest,
  feedbackRetryRequest,
  feedbackDecisionsRequest,
} from "@harness/feedback/client";
import {
  worktreeRepositoryRequest,
  worktreeCreateConversationRequest,
  worktreeOptionsRequest,
  worktreeSwitchRequest,
  worktreeManagedRequest,
  worktreeRemoveRequest,
} from "@harness/worktrees/client";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { format, resolveConfig } from "prettier";
import {
  coreRpcMessages,
  initializeRequest,
  type JsonValue,
  type RpcMessage,
} from "@harness/protocol";
import {
  activitiesEventNotification,
  activitiesSnapshotSchema,
  activityKillRequest,
  activityPeekRequest,
} from "@harness/activities";
import {
  approvalDecideRequest,
  approvalCreatedNotification,
  approvalResolvedNotification,
  approvalsSnapshotSchema,
} from "@harness/approval";
import {
  sandboxWorkspaceRequest,
  sandboxEnvironmentsRequest,
  sandboxEnvironmentControlRequest,
  sandboxEventNotification,
  sandboxRebuildRequest,
  sandboxSnapshotSchema,
  sandboxStopRequest,
} from "@harness/sandbox";
import {
  subagentsTopLevelRequest,
  subagentsInspectRequest,
  subagentsListRequest,
} from "@harness/subagents";
import { workspaceShellEventNotification, workspaceShellRunRequest } from "@harness/workspace";
import {
  appSettingsRequest,
  appConversationProjectsRequest,
  appConversationListRequest,
  appProvidersRequest,
  appSettingsUpdateRequest,
  appProviderConfigUpdateRequest,
  appProviderCreateRequest,
  appAuthLoginRequest,
  appAuthLogoutRequest,
  appAuthUrlNotification,
} from "@harness/server/client-protocol";
import {
  serverInfoRequest,
  serverStopRequest,
  serverReleaseRequest,
  managementInspectRequest,
  managementStopRequest,
  managementReleaseRequest,
} from "@harness/connections";

import { mcpRpcMessages } from "@harness/mcp/client";

const messages: readonly RpcMessage[] = [
  initializeRequest,
  feedbackStatusRequest,
  feedbackConfigureRequest,
  feedbackVoteRequest,
  feedbackRetryRequest,
  feedbackDecisionsRequest,
  worktreeOptionsRequest,
  worktreeSwitchRequest,
  worktreeManagedRequest,
  worktreeRemoveRequest,
  sandboxWorkspaceRequest,
  sandboxEnvironmentsRequest,
  sandboxEnvironmentControlRequest,
  worktreeRepositoryRequest,
  worktreeCreateConversationRequest,
  ...coreRpcMessages,
  serverInfoRequest,
  serverStopRequest,
  serverReleaseRequest,
  managementInspectRequest,
  managementStopRequest,
  managementReleaseRequest,
  approvalDecideRequest,
  approvalCreatedNotification,
  approvalResolvedNotification,
  activitiesEventNotification,
  activityPeekRequest,
  activityKillRequest,
  sandboxEventNotification,
  sandboxRebuildRequest,
  sandboxStopRequest,
  subagentsTopLevelRequest,
  subagentsInspectRequest,
  subagentsListRequest,
  workspaceShellRunRequest,
  workspaceShellEventNotification,
  appSettingsRequest,
  appConversationProjectsRequest,
  appConversationListRequest,
  appProvidersRequest,
  appSettingsUpdateRequest,
  appProviderConfigUpdateRequest,
  appProviderCreateRequest,
  appAuthLoginRequest,
  appAuthLogoutRequest,
  appAuthUrlNotification,
  ...mcpRpcMessages,
] as readonly RpcMessage[];

const definitions: Record<string, JsonValue> = {};
const manifest = messages.map((message) => {
  const name = message.method.replaceAll(/[^A-Za-z0-9]/gu, "_");
  definitions[`${name}_params`] = z.toJSONSchema(message.params, {
    io: "input",
    target: "draft-2020-12",
    unrepresentable: "throw",
  }) as JsonValue;
  if (message.kind === "request") {
    definitions[`${name}_result`] = z.toJSONSchema(message.result, {
      target: "draft-2020-12",
      unrepresentable: "throw",
    }) as JsonValue;
  }
  return {
    method: message.method,
    kind: message.kind,
    direction: message.direction,
    params: { $ref: `#/$defs/${name}_params` },
    ...(message.kind === "request" ? { result: { $ref: `#/$defs/${name}_result` } } : {}),
  };
});

definitions.activities_snapshot = z.toJSONSchema(activitiesSnapshotSchema, {
  target: "draft-2020-12",
  unrepresentable: "throw",
}) as JsonValue;
definitions.sandbox_snapshot = z.toJSONSchema(sandboxSnapshotSchema, {
  target: "draft-2020-12",
  unrepresentable: "throw",
}) as JsonValue;

definitions.approval_snapshot = z.toJSONSchema(approvalsSnapshotSchema, {
  target: "draft-2020-12",
  unrepresentable: "throw",
}) as JsonValue;

const document = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://harness.local/protocol/client.schema.json",
  title: "Harness client protocol",
  $defs: definitions,
  "x-harness-messages": manifest,
  "x-harness-snapshots": {
    approval: { $ref: "#/$defs/approval_snapshot" },
    activities: { $ref: "#/$defs/activities_snapshot" },
    sandbox: { $ref: "#/$defs/sandbox_snapshot" },
  },
};

const output = resolve("docs/protocol/client.schema.json");
await mkdir(resolve("docs/protocol"), { recursive: true });
await writeFile(
  output,
  await format(JSON.stringify(document), {
    ...(await resolveConfig(output)),
    parser: "json",
  }),
  "utf8",
);
