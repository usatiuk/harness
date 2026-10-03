// A separate server process with real protocol/plugin composition and an isolated database.
import { createNdjsonMessageConnection } from "@harness/client/node";
import { HarnessRpcSession, HarnessService } from "@harness/service";
import { SqliteStore } from "@harness/store-sqlite";
import { activitiesPlugin } from "@harness/activities";
import { sandboxPlugin } from "@harness/sandbox";
import { workspacePlugin } from "@harness/workspace";
import {
  APPROVAL_CLIENT_CONTRACT_VERSION,
  approvalDecideRequest,
  approvalPlugin,
  isApprovalRequest,
} from "@harness/approval";
import { isKernelEvent, jsonValueSchema } from "@harness/protocol";
import { CLI_PLUGIN_CONTRACTS, registerCliPluginServer } from "./client-plugins.ts";
import { DemoProvider } from "./demo-provider.ts";

const connection = createNdjsonMessageConnection(process.stdin, process.stdout);
const closed = new Promise<void>((resolve) => connection.onClose(() => resolve()));
const store = new SqliteStore(":memory:");
const service = new HarnessService({
  store,
  home: process.cwd(),
  defaults: { model: { provider: "demo", model: "demo-1" } },
  plugins: [
    { id: "demo", providers: () => [new DemoProvider()] },
    sandboxPlugin,
    activitiesPlugin,
    workspacePlugin,
    approvalPlugin,
  ],
});
const session = new HarnessRpcSession({
  connection,
  service,
  server: { name: "parallel-stdio-fixture", version: "1" },
  plugins: [{ id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION }, ...CLI_PLUGIN_CONTRACTS],
});
registerCliPluginServer(session, service);
const requests = new Map<string, AbortController>();
session.observeEvents((event, rootId) => {
  if (!isKernelEvent(event)) return;
  if (event.type === "request.resolved") {
    requests.get(event.requestId)?.abort();
    requests.delete(event.requestId);
  } else if (event.type === "request.created" && isApprovalRequest(event.request)) {
    const controller = new AbortController();
    requests.set(event.requestId, controller);
    void session
      .request(
        approvalDecideRequest,
        {
          requestId: event.requestId,
          rootConversationId: rootId,
          conversationId: event.conversationId,
          call: {
            callId: event.request.call.callId,
            name: event.request.call.name,
            args: jsonValueSchema.parse(event.request.call.args),
          },
          relationship: event.request.relationship,
        },
        { signal: controller.signal },
      )
      .then(
        (answer) => service.respond(event.conversationId, event.requestId, answer),
        () => service.respond(event.conversationId, event.requestId, { decision: "deny" }),
      )
      .finally(() => requests.delete(event.requestId));
  }
});
session.start();
await closed;
await session.shutdown();
store.close();
