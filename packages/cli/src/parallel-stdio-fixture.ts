import { registerApprovalServer } from "@harness/server/approvals";
import { HarnessRpcHost } from "@harness/service";
// A separate server process with real protocol/plugin composition and an isolated database.
import { createNdjsonMessageConnection } from "@harness/client/node";
import { HarnessRpcSession, HarnessService } from "@harness/service";
import { SqliteStore } from "@harness/store-sqlite";
import { activitiesPlugin } from "@harness/activities";
import { sandboxPlugin } from "@harness/sandbox";
import { workspacePlugin } from "@harness/workspace";
import { APPROVAL_CLIENT_CONTRACT_VERSION, approvalPlugin } from "@harness/approval";
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
const host = new HarnessRpcHost(service);
const session = new HarnessRpcSession({
  connection,
  host,
  server: { name: "parallel-stdio-fixture", version: "1" },
  plugins: [{ id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION }, ...CLI_PLUGIN_CONTRACTS],
});
registerCliPluginServer(session);
registerApprovalServer(session);
session.start();
await closed;
await host.shutdown();
await session.shutdown();
store.close();
