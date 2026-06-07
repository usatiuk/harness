import {
    HarnessKernel,
    createId,
    finalResponseEvents,
    nowIso,
    type HarnessStore,
    type ModelAdapter,
} from "@harness/core";
import { HarnessService } from "@harness/service";
import {
    agentRunRecordSchema,
    contextBuildSchema,
    contextProjectionSchema,
    conversationItemSchema,
    conversationRecordSchema,
    profileRecordSchema,
    providerEncodingSchema,
    type AgentRunRecord,
    type AgentRunStatus,
    type ConversationItem,
    type ConversationItemClass,
    type ConversationItemKind,
    type ConversationItemVisibility,
    type ConversationRecord,
    type ContentBlock,
    type ContextBuild,
    type ContextProjection,
    type MessageRole,
    type ModelCapabilities,
    type ModelConfig,
    type ModelFinalResponseDraft,
    type ModelRequest,
    type ModelStreamEventDraft,
    type ProfileConfig,
    type ProfileRecord,
    type ProviderEncoding,
    type ProviderEventPayload,
    type SourceRef,
} from "@harness/protocol";
import type { JSONType } from "zod";

export class RecordingModelAdapter implements ModelAdapter {
    public readonly id = "recording";
    public readonly provider = "fake";
    public readonly inputs: ModelRequest[] = [];
    private readonly queue: Array<
        | ModelFinalResponseDraft
        | ((
              input: ModelRequest,
          ) => ModelFinalResponseDraft | Promise<ModelFinalResponseDraft>)
    > = [];

    public constructor(
        private readonly options: { defaultText?: string; fail?: Error } = {},
    ) {}

    public capabilities(): ModelCapabilities {
        return { textInput: true, textOutput: true, reasoningMetadata: false };
    }

    public validateModelConfig(config: ModelConfig): void {
        if (config.provider !== this.provider || config.adapter !== this.id) {
            throw new Error(
                `Recording adapter cannot run ${config.provider}/${config.adapter}`,
            );
        }
    }

    public enqueue(
        result:
            | ModelFinalResponseDraft
            | ((
                  input: ModelRequest,
              ) => ModelFinalResponseDraft | Promise<ModelFinalResponseDraft>),
    ): void {
        this.queue.push(result);
    }

    public async *stream(
        input: ModelRequest,
    ): AsyncIterable<ModelStreamEventDraft> {
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
                metadata: { adapter: "recording" },
            },
        });
    }
}

export class BlockingModelAdapter extends RecordingModelAdapter {
    private unblockResolver:
        | ((result: ModelFinalResponseDraft) => void)
        | undefined;
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
        result: ModelFinalResponseDraft = {
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
    ): AsyncIterable<ModelStreamEventDraft> {
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
        const result = await new Promise<ModelFinalResponseDraft>((resolve) => {
            this.unblockResolver = resolve;
        });
        yield* finalResponseEvents(result);
    }
}

export interface TestHarness {
    store: MemoryHarnessStore;
    model: RecordingModelAdapter;
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
    model: RecordingModelAdapter = new RecordingModelAdapter(),
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
    private readonly projections = new Map<string, ContextProjection[]>();
    private readonly builds = new Map<string, ContextBuild[]>();
    private readonly providerEncodings = new Map<string, ProviderEncoding[]>();
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

    public async appendConversationItem(input: {
        id?: string;
        conversationId: string;
        class: ConversationItemClass;
        kind: ConversationItemKind;
        role?: MessageRole;
        visibility: ConversationItemVisibility;
        runId?: string;
        source?: SourceRef;
        content: ContentBlock[];
        data?: JSONType;
    }): Promise<ConversationItem> {
        const rows = this.items.get(input.conversationId);
        if (!rows) {
            throw new Error(`Conversation ${input.conversationId} not found`);
        }
        const item = conversationItemSchema.parse({
            id: input.id ?? createId("item"),
            conversationId: input.conversationId,
            sequence: rows.length + 1,
            class: input.class,
            kind: input.kind,
            ...(input.role ? { role: input.role } : {}),
            visibility: input.visibility,
            ...(input.runId ? { runId: input.runId } : {}),
            ...(input.source ? { source: input.source } : {}),
            content: input.content,
            ...(input.data !== undefined ? { data: input.data } : {}),
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
        const encodingSnapshot = this.providerEncodings.has(
            input.conversationId,
        )
            ? structuredClone(this.providerEncodings.get(input.conversationId))
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
                class: "transcript",
                kind: "assistant_message",
                role: "assistant",
                visibility: "model",
                runId: input.runId,
                content: input.content,
                ...(input.data !== undefined ? { data: input.data } : {}),
            });
            const providerEventItems = [];
            for (const event of input.providerEvents) {
                providerEventItems.push(
                    await this.appendConversationItem({
                        conversationId: input.conversationId,
                        class: "provider",
                        kind: "provider_event",
                        visibility: "audit",
                        runId: input.runId,
                        content: [
                            {
                                type: "data",
                                label: event.kind,
                                data: event.normalized,
                            },
                        ],
                        data: providerEventData(event),
                    }),
                );
            }
            const providerEncoding = input.providerEncoding
                ? await this.createProviderEncoding({
                      conversationId: input.conversationId,
                      itemId: assistantItem.id,
                      itemSequence: assistantItem.sequence,
                      provider: input.modelConfig.provider,
                      adapter: input.modelConfig.adapter,
                      modelId: input.modelConfig.modelId,
                      format: input.providerEncoding.format,
                      formatVersion: input.providerEncoding.formatVersion,
                      payload: input.providerEncoding.payload,
                  })
                : undefined;
            const run = await this.updateAgentRun({
                id: input.runId,
                status: "completed",
                completedThroughItemSequence: await this.getLatestItemSequence(
                    input.conversationId,
                ),
            });
            return {
                assistantItem,
                providerEventItems,
                ...(providerEncoding ? { providerEncoding } : {}),
                run,
            };
        } catch (error) {
            if (itemSnapshot) {
                this.items.set(input.conversationId, itemSnapshot);
            } else {
                this.items.delete(input.conversationId);
            }
            if (encodingSnapshot) {
                this.providerEncodings.set(
                    input.conversationId,
                    encodingSnapshot,
                );
            } else {
                this.providerEncodings.delete(input.conversationId);
            }
            if (runSnapshot) {
                this.runs.set(input.runId, runSnapshot);
            } else {
                this.runs.delete(input.runId);
            }
            throw error;
        }
    }

    public async createContextProjection(input: {
        id?: string;
        conversationId: string;
        itemId: string;
        coversThroughItemSequence: number;
        policyId: string;
        content: ContentBlock[];
        tokenEstimate: number;
        diagnostics?: Record<string, JSONType>;
    }): Promise<ContextProjection> {
        const projection = contextProjectionSchema.parse({
            id: input.id ?? createId("proj"),
            conversationId: input.conversationId,
            itemId: input.itemId,
            coversThroughItemSequence: input.coversThroughItemSequence,
            policyId: input.policyId,
            content: input.content,
            tokenEstimate: input.tokenEstimate,
            diagnostics: input.diagnostics ?? {},
            createdAt: nowIso(),
        });
        const rows = this.projections.get(input.conversationId) ?? [];
        rows.push(projection);
        this.projections.set(input.conversationId, rows);
        return structuredClone(projection);
    }

    public async listContextProjections(
        conversationId: string,
    ): Promise<ContextProjection[]> {
        return (this.projections.get(conversationId) ?? [])
            .sort(
                (left, right) =>
                    left.coversThroughItemSequence -
                        right.coversThroughItemSequence ||
                    left.createdAt.localeCompare(right.createdAt),
            )
            .map((row) => structuredClone(row));
    }

    public async createContextBuild(input: {
        id?: string;
        conversationId: string;
        runId: string;
        modelConfig: ModelConfig;
        projectionId?: string;
        selectedItemIds: string[];
        selectedItemSequences: number[];
        diagnostics?: Record<string, JSONType>;
    }): Promise<ContextBuild> {
        const build = contextBuildSchema.parse({
            id: input.id ?? createId("ctxbuild"),
            conversationId: input.conversationId,
            runId: input.runId,
            modelConfig: input.modelConfig,
            ...(input.projectionId ? { projectionId: input.projectionId } : {}),
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

    public async createProviderEncoding(input: {
        id?: string;
        conversationId: string;
        itemId: string;
        itemSequence: number;
        provider: string;
        adapter: string;
        modelId: string;
        format: string;
        formatVersion: number;
        payload: JSONType;
    }): Promise<ProviderEncoding> {
        const rows = this.providerEncodings.get(input.conversationId) ?? [];
        if (
            rows.some(
                (encoding) =>
                    encoding.itemId === input.itemId &&
                    encoding.provider === input.provider &&
                    encoding.adapter === input.adapter &&
                    encoding.modelId === input.modelId &&
                    encoding.format === input.format &&
                    encoding.formatVersion === input.formatVersion,
            )
        ) {
            throw new Error(
                `Provider encoding already exists for item ${input.itemId}`,
            );
        }
        const encoding = providerEncodingSchema.parse({
            id: input.id ?? createId("penc"),
            conversationId: input.conversationId,
            itemId: input.itemId,
            itemSequence: input.itemSequence,
            provider: input.provider,
            adapter: input.adapter,
            modelId: input.modelId,
            format: input.format,
            formatVersion: input.formatVersion,
            payload: input.payload,
            createdAt: nowIso(),
        });
        rows.push(encoding);
        this.providerEncodings.set(input.conversationId, rows);
        return structuredClone(encoding);
    }

    public async listProviderEncodingsForItems(input: {
        conversationId: string;
        itemIds: string[];
        provider: string;
        adapter: string;
        modelId: string;
    }): Promise<ProviderEncoding[]> {
        const itemIds = new Set(input.itemIds);
        return (this.providerEncodings.get(input.conversationId) ?? [])
            .filter(
                (encoding) =>
                    itemIds.has(encoding.itemId) &&
                    encoding.provider === input.provider &&
                    encoding.adapter === input.adapter &&
                    encoding.modelId === input.modelId,
            )
            .sort(
                (left, right) =>
                    left.itemSequence - right.itemSequence ||
                    right.createdAt.localeCompare(left.createdAt),
            )
            .map((row) => structuredClone(row));
    }
}

function providerEventData(event: ProviderEventPayload): JSONType {
    return {
        provider: event.provider,
        modelId: event.modelId,
        sequence: event.sequence,
        kind: event.kind,
        normalized: event.normalized,
        ...(event.providerRequestId
            ? { providerRequestId: event.providerRequestId }
            : {}),
        ...(event.providerResponseId
            ? { providerResponseId: event.providerResponseId }
            : {}),
        ...(event.providerItemId
            ? { providerItemId: event.providerItemId }
            : {}),
        ...(event.providerOperationId
            ? { providerOperationId: event.providerOperationId }
            : {}),
    } satisfies JSONType;
}
