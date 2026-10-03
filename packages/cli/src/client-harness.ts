import type {
  Conversation,
  ConversationId,
  Item,
  ModelConfig,
  ModelUsageSummary,
  PluginContract,
} from "@harness/protocol";
import {
  HarnessClient,
  HarnessDomainClient,
  type HarnessClientService,
  type RpcConnection,
} from "@harness/client";
import { APPROVAL_CLIENT_CONTRACT_VERSION, ApprovalClient } from "@harness/approval";
import { appProvidersRequest, type ProviderStatus } from "@harness/server/client-protocol";
import { CLI_PLUGIN_CONTRACTS, CliPluginClient } from "./client-plugins.ts";
export interface CliService extends HarnessClientService {
  createConversation(options?: {
    cwd?: string;
    overrides?: Record<string, unknown>;
  }): Promise<Conversation>;
  getConversation(id: ConversationId): Promise<Conversation | undefined>;
  listConversations(): Promise<Conversation[]>;
  getItems(id: ConversationId): Promise<Item[]>;
  prepare(id: ConversationId): Promise<void>;
  deleteConversationIfEmpty(id: ConversationId): Promise<void>;
  deactivateSession(
    id: ConversationId,
    options?: { force?: boolean },
  ): Promise<{ status: "busy" | "deactivated" }>;
  attachedConversation(id: ConversationId): Promise<Conversation>;
  usageSummary(id: ConversationId): Promise<ModelUsageSummary>;
  closeConnection?(): void;
}

export interface Harness {
  client: HarnessClient;
  service: CliService;
  providers: ProviderStatus[];
  plugins: CliPluginClient;
  /** Model used only when no settings layer configures one (no `auth login`, no project config). */
  fallbackModel: ModelConfig;
  close(): Promise<void>;
}

const CLIENT_CONTRACTS: PluginContract[] = [
  { id: "approval", version: APPROVAL_CLIENT_CONTRACT_VERSION },
  ...CLI_PLUGIN_CONTRACTS,
];

export async function buildClientHarness(
  connection: RpcConnection,
  closeTransport: () => Promise<void>,
  signal?: AbortSignal,
): Promise<Harness> {
  const wireClient = new HarnessClient({
    connection,
    client: { name: "harness-tui", version: "0.0.0" },
    plugins: CLIENT_CONTRACTS,
  });
  const approvals = new ApprovalClient(wireClient);
  const plugins = new CliPluginClient(wireClient, approvals);
  const service = new HarnessDomainClient(wireClient);
  const cancelled = () => wireClient.closeConnection();
  signal?.addEventListener("abort", cancelled, { once: true });
  let providers: ProviderStatus[];
  try {
    signal?.throwIfAborted();
    await service.start();
    providers = await wireClient.peer.request(appProvidersRequest, {});
    signal?.throwIfAborted();
  } catch (error) {
    wireClient.closeConnection();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelled);
  }
  return {
    client: wireClient,
    service,
    providers,
    plugins,
    fallbackModel: service.defaultModel(),
    close: async () => {
      service.closeConnection();
      await closeTransport();
    },
  };
}
