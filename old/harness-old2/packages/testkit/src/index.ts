import {
    HarnessKernel,
    createId,
    finalResponseEvents,
    nowIso,
    type HarnessStore,
    type ModelProvider,
} from "@harness/core";
import { HarnessService } from "@harness/service";
import {
    agentRunRecordSchema,
    contextBuildSchema,
    conversationItemInputSchema,
    conversationItemSchema,
    conversationRecordSchema,
    profileRecordSchema,
    providerPayloadSchema,
    type AgentRunRecord,
    type AgentRunStatus,
    type ConversationItem,
    type ConversationRecord,
    type ContextBuild,
    type ModelAccounting,
    type ModelCapabilities,
    type ModelConfig,
    type ModelFinalResponse,
    type ModelRequest,
    type ModelStreamEvent,
    type ProfileConfig,
    type ProfileRecord,
    type ProviderPayload,
    type ProviderResponse,
} from "@harness/protocol";
import type { JSONType } from "zod";

export class RecordingModelProvider implements ModelProvider {
    public readonly provider = "fake";
    public readonly inputs: ModelRequest[] = [];
    private readonly queue: Array<
        | ModelFinalResponse
        | ((
              input: ModelRequest,
          ) => ModelFinalResponse | Promise<ModelFinalResponse>)
    > = [];

    public constructor(
        private readonly options: { defaultText?: string; fail?: Error } = {},
    ) {}

    public capabilities(): ModelCapabilities {
        return {
            inputContent: ["text"],
            outputContent: ["text"],
            providerPayloads: false,
        };
    }

    public validateModelConfig(config: ModelConfig): void {
        if (config.provider !== this.provider) {
            throw new Error(
                `Recording provider cannot run provider ${config.provider}`,
            );
        }
    }

    public enqueue(
        result:
            | ModelFinalResponse
            | ((
                  input: ModelRequest,
              ) => ModelFinalResponse | Promise<ModelFinalResponse>),
    ): void {
        this.queue.push(result);
    }

    public async *stream(input: ModelRequest): AsyncIterable<ModelStreamEvent> {
        this.inputs.push(input);
        if (this.options.fail) {
            throw this.options.fail;
        }
        const next = this.queue.shift();
        if (typeof next === "function") {
            yield* finalResponseEvents(await next(input));
            return;
        }
        if (next) {
            yield* finalResponseEvents(next);
            return;
        }
        yield* finalResponseEvents({
            assistant: {
                content: [
                    {
                        type: "text",
                        text: this.options.defaultText ?? "recorded response",
                    },
                ],
            },
        });
    }
}

export class BlockingModelProvider extends RecordingModelProvider {
    private unblockResolver: ((result: ModelFinalResponse) => void) | undefined;
    private readonly callResolvers: Array<{
        count: number;
        resolve: () => void;
    }> = [];

    public waitForStart(): Promise<void> {
        return this.waitForCalls(1);
    }

    public waitForCalls(count: number): Promise<void> {
        if (this.inputs.length >= count) {
            return Promise.resolve();
        }
        return new Promise((resolve) =>
            this.callResolvers.push({ count, resolve }),
        );
    }

    public unblock(
        result: ModelFinalResponse = {
            assistant: { content: [{ type: "text", text: "unblocked" }] },
        },
    ): void {
        if (!this.unblockResolver) {
            throw new Error("Blocking model has not started");
        }
        this.unblockResolver(result);
        this.unblockResolver = undefined;
    }

    public override async *stream(
        input: ModelRequest,
    ): AsyncIterable<ModelStreamEvent> {
        this.inputs.push(input);
        for (const waiter of [...this.callResolvers]) {
            if (this.inputs.length >= waiter.count) {
                waiter.resolve();
                this.callResolvers.splice(
                    this.callResolvers.indexOf(waiter),
                    1,
                );
            }
        }
        const result = await new Promise<ModelFinalResponse>((resolve) => {
            this.unblockResolver = resolve;
        });
        yield* finalResponseEvents(result);
    }
}

export interface TestHarness {
    store: MemoryHarnessStore;
    model: RecordingModelProvider;
    kernel: HarnessKernel;
    service: HarnessService;
}

type CommitAssistantResponseInput = Parameters<
    HarnessStore["commitAssistantResponse"]
>[0];
type CommitAssistantResponseResult = Awaited<
    ReturnType<HarnessStore["commitAssistantResponse"]>
>;

export function createTestHarness(
    model: RecordingModelProvider = new RecordingModelProvider(),
): TestHarness {
    const store = new MemoryHarnessStore();
    const kernel = new HarnessKernel({ store, models: [model] });
    const service = new HarnessService(kernel);
    return { store, model, kernel, service };
}

export class MemoryHarnessStore implements HarnessStore {
    private readonly profiles = new Map<string, ProfileRecord>();
    private readonly conversations = new Map<string, ConversationRecord>();
    private readonly items = new Map<string, ConversationItem[]>();
    private readonly runs = new Map<string, AgentRunRecord>();
    private readonly builds = new Map<string, ContextBuild[]>();
    private readonly providerPayloads = new Map<string, ProviderPayload[]>();
    private defaultProfileName: string | undefined;

    public async createProfile(input: {
        id?: string;
        name: string;
        config: ProfileConfig;
    }): Promise<ProfileRecord> {
        if (
            [...this.profiles.values()].some(
                (profile) => profile.name === input.name,
            )
        ) {
            throw new Error(`Profile ${input.name} already exists`);
        }
        const timestamp = nowIso();
        const profile = profileRecordSchema.parse({
            id: input.id ?? createId("prof"),
            name: input.name,
            config: input.config,
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        this.profiles.set(profile.id, profile);
        return structuredClone(profile);
    }

    public async listProfiles(): Promise<ProfileRecord[]> {
        return [...this.profiles.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((row) => structuredClone(row));
    }

    public async getProfileByName(
        name: string,
    ): Promise<ProfileRecord | undefined> {
        const profile = [...this.profiles.values()].find(
            (item) => item.name === name,
        );
        return profile ? structuredClone(profile) : undefined;
    }

    public async setDefaultProfileName(name: string): Promise<void> {
        this.defaultProfileName = name;
    }

    public async getDefaultProfileName(): Promise<string | undefined> {
        return this.defaultProfileName;
    }

    public async createConversation(input: {
        id?: string;
        profileName?: string;
        config: ProfileConfig;
        title?: string;
    }): Promise<ConversationRecord> {
        const timestamp = nowIso();
        const conversation = conversationRecordSchema.parse({
            id: input.id ?? createId("conv"),
            ...(input.profileName ? { profileName: input.profileName } : {}),
            config: input.config,
            ...(input.title ? { title: input.title } : {}),
            status: "created",
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        this.conversations.set(conversation.id, conversation);
        this.items.set(conversation.id, []);
        return structuredClone(conversation);
    }

    public async getConversation(
        id: string,
    ): Promise<ConversationRecord | undefined> {
        const conversation = this.conversations.get(id);
        return conversation ? structuredClone(conversation) : undefined;
    }

    public async listConversations(): Promise<ConversationRecord[]> {
        return [...this.conversations.values()]
            .sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
            )
            .map((row) => structuredClone(row));
    }

    public async updateConversation(input: {
        id: string;
        status?: ConversationRecord["status"];
        title?: string;
    }): Promise<ConversationRecord> {
        const current = this.conversations.get(input.id);
        if (!current) {
            throw new Error(`Conversation ${input.id} not found`);
        }
        const updated = conversationRecordSchema.parse({
            ...current,
            ...(input.status ? { status: input.status } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            updatedAt: nowIso(),
        });
        this.conversations.set(updated.id, updated);
        return structuredClone(updated);
    }

    public async appendConversationItem(
        rawInput: Parameters<HarnessStore["appendConversationItem"]>[0],
    ): Promise<ConversationItem> {
        const input = conversationItemInputSchema.parse(rawInput);
        const rows = this.items.get(input.conversationId);
        if (!rows) {
            throw new Error(`Conversation ${input.conversationId} not found`);
        }
        const item = conversationItemSchema.parse({
            ...input,
            id: input.id ?? createId("item"),
            sequence: rows.length + 1,
            createdAt: nowIso(),
        });
        rows.push(item);
        return structuredClone(item);
    }

    public async listConversationItems(
        conversationId: string,
        input: { after?: number; limit?: number } = {},
    ): Promise<ConversationItem[]> {
        const after = input.after ?? 0;
        const rows = (this.items.get(conversationId) ?? []).filter(
            (item) => item.sequence > after,
        );
        return (
            input.limit === undefined ? rows : rows.slice(0, input.limit)
        ).map((row) => structuredClone(row));
    }

    public async getLatestItemSequence(
        conversationId: string,
    ): Promise<number> {
        return this.items.get(conversationId)?.at(-1)?.sequence ?? 0;
    }

    public async createAgentRun(input: {
        id?: string;
        conversationId: string;
        startedThroughItemSequence: number;
        modelConfig: ModelConfig;
    }): Promise<AgentRunRecord> {
        const active = await this.getActiveAgentRun(input.conversationId);
        if (active) {
            throw new Error(
                `Conversation ${input.conversationId} already has active run ${active.id}`,
            );
        }
        const timestamp = nowIso();
        const run = agentRunRecordSchema.parse({
            id: input.id ?? createId("run"),
            conversationId: input.conversationId,
            status: "running",
            startedThroughItemSequence: input.startedThroughItemSequence,
            modelConfig: input.modelConfig,
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        this.runs.set(run.id, run);
        return structuredClone(run);
    }

    public async getAgentRun(id: string): Promise<AgentRunRecord | undefined> {
        const run = this.runs.get(id);
        return run ? structuredClone(run) : undefined;
    }

    public async getActiveAgentRun(
        conversationId: string,
    ): Promise<AgentRunRecord | undefined> {
        const run = [...this.runs.values()].find(
            (item) =>
                item.conversationId === conversationId &&
                item.status === "running",
        );
        return run ? structuredClone(run) : undefined;
    }

    public async listAgentRuns(
        conversationId: string,
    ): Promise<AgentRunRecord[]> {
        return [...this.runs.values()]
            .filter((run) => run.conversationId === conversationId)
            .sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
            )
            .map((row) => structuredClone(row));
    }

    public async updateAgentRun(input: {
        id: string;
        status?: AgentRunStatus;
        completedThroughItemSequence?: number;
        outputItemId?: string;
        providerResponse?: ProviderResponse;
        accounting?: ModelAccounting;
        error?: JSONType;
    }): Promise<AgentRunRecord> {
        const current = this.runs.get(input.id);
        if (!current) {
            throw new Error(`Agent run ${input.id} not found`);
        }
        const updated = agentRunRecordSchema.parse({
            ...current,
            ...(input.status ? { status: input.status } : {}),
            ...(input.completedThroughItemSequence !== undefined
                ? {
                      completedThroughItemSequence:
                          input.completedThroughItemSequence,
                  }
                : {}),
            ...(input.outputItemId ? { outputItemId: input.outputItemId } : {}),
            ...(input.providerResponse
                ? { providerResponse: input.providerResponse }
                : {}),
            ...(input.accounting ? { accounting: input.accounting } : {}),
            ...(input.error !== undefined ? { error: input.error } : {}),
            updatedAt: nowIso(),
        });
        this.runs.set(updated.id, updated);
        return structuredClone(updated);
    }

    public async commitAssistantResponse(
        input: CommitAssistantResponseInput,
    ): Promise<CommitAssistantResponseResult> {
        const itemSnapshot = this.items.has(input.conversationId)
            ? structuredClone(this.items.get(input.conversationId))
            : undefined;
        const payloadSnapshot = this.providerPayloads.has(input.conversationId)
            ? structuredClone(this.providerPayloads.get(input.conversationId))
            : undefined;
        const runSnapshot = this.runs.has(input.runId)
            ? structuredClone(this.runs.get(input.runId))
            : undefined;
        try {
            const currentRun = this.runs.get(input.runId);
            if (
                !currentRun ||
                currentRun.conversationId !== input.conversationId
            ) {
                throw new Error(`Agent run ${input.runId} not found`);
            }
            if (currentRun.status !== "running") {
                throw new Error(
                    `Agent run ${input.runId} is ${currentRun.status}`,
                );
            }
            const assistantItem = await this.appendConversationItem({
                conversationId: input.conversationId,
                type: "message",
                role: "assistant",
                status: "complete",
                runId: input.runId,
                content: input.content,
            });
            const providerPayload = input.providerPayload
                ? await this.createProviderPayload({
                      conversationId: input.conversationId,
                      itemId: assistantItem.id,
                      itemSequence: assistantItem.sequence,
                      provider: input.modelConfig.provider,
                      modelId: input.modelConfig.modelId,
                      type: input.providerPayload.type,
                      version: input.providerPayload.version,
                      payload: input.providerPayload.payload,
                  })
                : undefined;
            const run = await this.updateAgentRun({
                id: input.runId,
                status: "completed",
                completedThroughItemSequence: await this.getLatestItemSequence(
                    input.conversationId,
                ),
                outputItemId: assistantItem.id,
                ...(input.providerResponse
                    ? { providerResponse: input.providerResponse }
                    : {}),
                ...(input.accounting ? { accounting: input.accounting } : {}),
            });
            return {
                assistantItem,
                ...(providerPayload ? { providerPayload } : {}),
                run,
            };
        } catch (error) {
            if (itemSnapshot) {
                this.items.set(input.conversationId, itemSnapshot);
            } else {
                this.items.delete(input.conversationId);
            }
            if (payloadSnapshot) {
                this.providerPayloads.set(input.conversationId, payloadSnapshot);
            } else {
                this.providerPayloads.delete(input.conversationId);
            }
            if (runSnapshot) {
                this.runs.set(input.runId, runSnapshot);
            } else {
                this.runs.delete(input.runId);
            }
            throw error;
        }
    }

    public async createContextBuild(input: {
        id?: string;
        conversationId: string;
        runId: string;
        modelConfig: ModelConfig;
        compactionItemId?: string;
        selectedItemIds: string[];
        selectedItemSequences: number[];
        diagnostics?: Record<string, JSONType>;
    }): Promise<ContextBuild> {
        const build = contextBuildSchema.parse({
            id: input.id ?? createId("ctxbuild"),
            conversationId: input.conversationId,
            runId: input.runId,
            modelConfig: input.modelConfig,
            ...(input.compactionItemId
                ? { compactionItemId: input.compactionItemId }
                : {}),
            selectedItemIds: input.selectedItemIds,
            selectedItemSequences: input.selectedItemSequences,
            diagnostics: input.diagnostics ?? {},
            createdAt: nowIso(),
        });
        const rows = this.builds.get(input.conversationId) ?? [];
        rows.push(build);
        this.builds.set(input.conversationId, rows);
        return structuredClone(build);
    }

    public async listContextBuilds(
        conversationId: string,
    ): Promise<ContextBuild[]> {
        return (this.builds.get(conversationId) ?? [])
            .sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
            )
            .map((row) => structuredClone(row));
    }

    public async createProviderPayload(input: {
        id?: string;
        conversationId: string;
        itemId: string;
        itemSequence: number;
        provider: string;
        modelId: string;
        type: string;
        version: number;
        payload: JSONType;
    }): Promise<ProviderPayload> {
        const rows = this.providerPayloads.get(input.conversationId) ?? [];
        if (
            rows.some(
                (payload) =>
                    payload.itemId === input.itemId &&
                    payload.provider === input.provider &&
                    payload.modelId === input.modelId &&
                    payload.type === input.type &&
                    payload.version === input.version,
            )
        ) {
            throw new Error(
                `Provider payload already exists for item ${input.itemId}`,
            );
        }
        const payload = providerPayloadSchema.parse({
            id: input.id ?? createId("ppay"),
            conversationId: input.conversationId,
            itemId: input.itemId,
            itemSequence: input.itemSequence,
            provider: input.provider,
            modelId: input.modelId,
            type: input.type,
            version: input.version,
            payload: input.payload,
            createdAt: nowIso(),
        });
        rows.push(payload);
        this.providerPayloads.set(input.conversationId, rows);
        return structuredClone(payload);
    }

    public async listProviderPayloadsForItems(input: {
        conversationId: string;
        itemIds: string[];
        provider: string;
        modelId: string;
    }): Promise<ProviderPayload[]> {
        const itemIds = new Set(input.itemIds);
        return (this.providerPayloads.get(input.conversationId) ?? [])
            .filter(
                (payload) =>
                    itemIds.has(payload.itemId) &&
                    payload.provider === input.provider &&
                    payload.modelId === input.modelId,
            )
            .sort(
                (left, right) =>
                    left.itemSequence - right.itemSequence ||
                    right.createdAt.localeCompare(left.createdAt),
            )
            .map((row) => structuredClone(row));
    }
}
