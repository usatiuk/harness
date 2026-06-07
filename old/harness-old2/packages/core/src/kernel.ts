import { modelStreamEventSchema, profileConfigSchema } from "@harness/protocol";
import type {
    AgentRunRecord,
    ConversationInputDelivery,
    ConversationItem,
    ConversationRecord,
    ContentBlock,
    ModelFinalResponse,
    ProfileConfig,
    ProfileRecord,
    ProviderEventPayload,
} from "@harness/protocol";
import { z, type JSONType } from "zod";
import {
    ContextBuilder,
    DEFAULT_CONTEXT_POLICY_ID,
    estimateTokens,
    summarizeItemsForProjection,
} from "./context.ts";
import { EchoModelAdapter, ModelRegistry, type ModelAdapter } from "./model.ts";
import { wasRunInterrupted } from "./run-state.ts";
import type { HarnessStore } from "./store.ts";

export interface HarnessKernelOptions {
    store: HarnessStore;
    models?: ModelAdapter[];
}

export class HarnessKernel {
    public readonly models = new ModelRegistry();
    public readonly contextBuilder: ContextBuilder;
    private readonly pumpQueues = new Map<string, Promise<void>>();
    private readonly activeRunByConversation = new Map<string, string>();
    private readonly cancelledRuns = new Set<string>();

    public constructor(public readonly options: HarnessKernelOptions) {
        this.models.register(new EchoModelAdapter());
        for (const model of options.models ?? []) {
            this.models.register(model);
        }
        this.contextBuilder = new ContextBuilder(options.store);
    }

    public get store(): HarnessStore {
        return this.options.store;
    }

    public async createProfile(input: {
        name: string;
        config: ProfileConfig;
        select?: boolean;
    }): Promise<ProfileRecord> {
        const config = profileConfigSchema.parse(input.config);
        this.models.resolve(config.model);
        const profile = await this.store.createProfile({
            name: input.name,
            config,
        });
        if (input.select ?? false) {
            await this.store.setDefaultProfileName(profile.name);
        }
        return profile;
    }

    public async listProfiles(): Promise<ProfileRecord[]> {
        return this.store.listProfiles();
    }

    public async selectProfile(name: string): Promise<ProfileRecord> {
        const profile = await this.store.getProfileByName(name);
        if (!profile) {
            throw new Error(`Profile ${name} not found`);
        }
        this.models.resolve(profile.config.model);
        await this.store.setDefaultProfileName(profile.name);
        return profile;
    }

    public async createConversation(
        input: {
            profileName?: string;
            profileConfig?: ProfileConfig;
            title?: string;
        } = {},
    ): Promise<ConversationRecord> {
        const profileName =
            input.profileName ?? (await this.store.getDefaultProfileName());
        const profile = profileName
            ? await this.store.getProfileByName(profileName)
            : undefined;
        if (profileName && !profile) {
            throw new Error(`Profile ${profileName} not found`);
        }
        const config = profileConfigSchema.parse(
            input.profileConfig ?? profile?.config ?? {},
        );
        this.models.resolve(config.model);
        const conversation = await this.store.createConversation({
            ...(profile?.name ? { profileName: profile.name } : {}),
            config,
            ...(input.title ? { title: input.title } : {}),
        });
        await this.store.appendConversationItem({
            conversationId: conversation.id,
            class: "audit",
            kind: "audit_note",
            visibility: "audit",
            content: [{ type: "text", text: "Conversation created" }],
            data: { conversationId: conversation.id },
        });
        return conversation;
    }

    public async listConversations(): Promise<ConversationRecord[]> {
        return this.store.listConversations();
    }

    public async getConversation(
        id: string,
    ): Promise<ConversationRecord | undefined> {
        return this.store.getConversation(id);
    }

    public async listItems(
        conversationId: string,
        input?: { after?: number; limit?: number },
    ): Promise<ConversationItem[]> {
        return this.store.listConversationItems(conversationId, input);
    }

    public async listAgentRuns(
        conversationId: string,
    ): Promise<AgentRunRecord[]> {
        return this.store.listAgentRuns(conversationId);
    }

    public async sendConversationInput(input: {
        conversationId: string;
        content: ContentBlock[];
        delivery?: ConversationInputDelivery;
    }): Promise<ConversationItem> {
        const delivery = input.delivery ?? "send";
        const inMemoryActiveRunId =
            delivery === "interrupt"
                ? this.activeRunByConversation.get(input.conversationId)
                : undefined;
        if (inMemoryActiveRunId) {
            this.cancelledRuns.add(inMemoryActiveRunId);
        }
        const conversation = await this.requireConversation(
            input.conversationId,
        );
        const activeBeforeInput = await this.store.getActiveAgentRun(
            conversation.id,
        );
        if (delivery === "interrupt") {
            if (activeBeforeInput) {
                this.cancelledRuns.add(activeBeforeInput.id);
                await this.store.updateAgentRun({
                    id: activeBeforeInput.id,
                    status: "cancelled",
                    completedThroughItemSequence:
                        await this.store.getLatestItemSequence(conversation.id),
                    error: { interrupted: true },
                });
            }
        }
        if (
            (delivery === "send" || delivery === "queue") &&
            activeBeforeInput
        ) {
            const item = await this.store.appendConversationItem({
                conversationId: conversation.id,
                class: "control",
                kind: "user_message",
                role: "user",
                visibility: "ui",
                content: input.content,
                data: {
                    delivery: "queue",
                    requestedDelivery: delivery,
                    afterRunId: activeBeforeInput.id,
                },
            });
            this.schedulePump(conversation.id);
            return item;
        }
        const item = await this.store.appendConversationItem({
            conversationId: conversation.id,
            class: "transcript",
            kind: "user_message",
            role: "user",
            visibility: delivery === "manual" ? "ui" : "model",
            content: input.content,
            data: { delivery },
        });
        if (delivery !== "manual") {
            await this.requestPump(conversation.id, {
                replace:
                    delivery === "interrupt" && activeBeforeInput !== undefined,
            });
        }
        return item;
    }

    public async runCompaction(
        conversationId: string,
    ): Promise<ConversationItem> {
        await this.requireConversation(conversationId);
        if (await this.store.getActiveAgentRun(conversationId)) {
            throw new Error("Cannot compact while a model run is active");
        }
        const items = await this.store.listConversationItems(conversationId);
        const abandonedSequences =
            await this.abandonedInputSequences(conversationId);
        const modelItems = items.filter(
            (item) =>
                item.class === "transcript" &&
                item.visibility === "model" &&
                !abandonedSequences.has(item.sequence),
        );
        if (modelItems.length === 0) {
            throw new Error("No model-visible transcript items to compact");
        }
        const coversThrough = modelItems.at(-1)?.sequence ?? 0;
        const content = summarizeItemsForProjection(
            modelItems.map((item) => ({
                role: item.role,
                content: item.content,
                sequence: item.sequence,
            })),
        );
        const item = await this.store.appendConversationItem({
            conversationId,
            class: "projection",
            kind: "context_projection",
            role: "system",
            visibility: "model",
            content,
            data: {
                coversThroughItemSequence: coversThrough,
                policyId: DEFAULT_CONTEXT_POLICY_ID,
            },
        });
        await this.store.createContextProjection({
            conversationId,
            itemId: item.id,
            coversThroughItemSequence: coversThrough,
            policyId: DEFAULT_CONTEXT_POLICY_ID,
            content,
            tokenEstimate: estimateTokens(content),
            diagnostics: { compactedItemCount: modelItems.length },
        });
        return item;
    }

    public async listContextBuilds(conversationId: string) {
        return this.store.listContextBuilds(conversationId);
    }

    public async listContextProjections(conversationId: string) {
        return this.store.listContextProjections(conversationId);
    }

    private async requestPump(
        conversationId: string,
        options: { replace?: boolean } = {},
    ): Promise<void> {
        const previous = options.replace
            ? Promise.resolve()
            : (this.pumpQueues.get(conversationId) ?? Promise.resolve());
        const next = previous
            .catch(() => undefined)
            .then(() => this.pumpConversation(conversationId));
        this.pumpQueues.set(conversationId, next);
        try {
            await next;
        } finally {
            if (this.pumpQueues.get(conversationId) === next) {
                this.pumpQueues.delete(conversationId);
            }
        }
    }

    private schedulePump(conversationId: string): void {
        void this.requestPump(conversationId).catch(() => undefined);
    }

    private async pumpConversation(conversationId: string): Promise<void> {
        for (;;) {
            if (await this.store.getActiveAgentRun(conversationId)) {
                return;
            }
            await this.promoteQueuedInputs(conversationId);
            if (!(await this.needsModelRun(conversationId))) {
                break;
            }
            const conversation = await this.requireConversation(conversationId);
            const modelConfig = conversation.config.model;
            const startedThroughItemSequence =
                await this.store.getLatestItemSequence(conversationId);
            const run = await this.store.createAgentRun({
                conversationId,
                startedThroughItemSequence,
                modelConfig,
            });
            await this.store.updateConversation({
                id: conversationId,
                status: "running",
            });
            await this.store.appendConversationItem({
                conversationId,
                class: "audit",
                kind: "run_event",
                visibility: "audit",
                runId: run.id,
                content: [{ type: "text", text: `Run ${run.id} started` }],
                data: { runId: run.id, status: "running" },
            });
            try {
                this.activeRunByConversation.set(conversationId, run.id);
                await this.runModelStream(conversation, run);
            } catch (error) {
                if (
                    error instanceof InactiveRunError &&
                    error.status === "cancelled"
                ) {
                    await this.store.appendConversationItem({
                        conversationId,
                        class: "audit",
                        kind: "run_event",
                        visibility: "audit",
                        runId: run.id,
                        content: [
                            { type: "text", text: `Run ${run.id} cancelled` },
                        ],
                        data: { runId: run.id, status: "cancelled" },
                    });
                    return;
                }
                const payload = errorPayload(error);
                await this.store.appendConversationItem({
                    conversationId,
                    class: "audit",
                    kind: "model_error",
                    visibility: "ui",
                    runId: run.id,
                    content: [{ type: "text", text: payload.message }],
                    data: payload,
                });
                await this.store.updateAgentRun({
                    id: run.id,
                    status: "failed",
                    completedThroughItemSequence:
                        await this.store.getLatestItemSequence(conversationId),
                    error: payload,
                });
                await this.store.updateConversation({
                    id: conversationId,
                    status: "failed",
                });
                throw error;
            } finally {
                if (
                    this.activeRunByConversation.get(conversationId) === run.id
                ) {
                    this.activeRunByConversation.delete(conversationId);
                }
                this.cancelledRuns.delete(run.id);
            }
        }
        const active = await this.store.getActiveAgentRun(conversationId);
        if (!active) {
            const conversation =
                await this.store.getConversation(conversationId);
            if (
                conversation &&
                conversation.status !== "failed" &&
                conversation.status !== "cancelled"
            ) {
                await this.store.updateConversation({
                    id: conversationId,
                    status: "idle",
                });
            }
        }
    }

    private async runModelStream(
        conversation: ConversationRecord,
        run: AgentRunRecord,
    ): Promise<void> {
        const adapter = this.models.resolve(conversation.config.model);
        const modelRequest = await this.contextBuilder.build({
            conversationId: conversation.id,
            runId: run.id,
            modelConfig: conversation.config.model,
            promptFragments: conversation.config.promptFragments,
        });
        const { response, providerEvents } = await this.collectModelStream(
            adapter.stream(modelRequest),
            run.id,
        );
        await this.assertRunStillActive(run.id);
        const assistantData = z.json().parse({
            metadata: response.assistant.metadata,
            accounting: response.accounting ?? null,
        });
        await this.store.commitAssistantResponse({
            conversationId: conversation.id,
            runId: run.id,
            modelConfig: conversation.config.model,
            content: response.assistant.content,
            data: assistantData,
            providerEvents,
            ...(response.assistant.providerEncoding
                ? { providerEncoding: response.assistant.providerEncoding }
                : {}),
        });
    }

    private async collectModelStream(
        stream: AsyncIterable<unknown>,
        runId: string,
    ): Promise<{
        response: ModelFinalResponse;
        providerEvents: ProviderEventPayload[];
    }> {
        const providerEvents: ProviderEventPayload[] = [];
        let response: ModelFinalResponse | undefined;
        for await (const draft of stream) {
            await this.assertRunStillActive(runId);
            if (response) {
                throw new Error(
                    "Model stream emitted an event after completion",
                );
            }
            const event = modelStreamEventSchema.parse(draft);
            switch (event.type) {
                case "text_delta":
                    break;
                case "provider_event":
                    providerEvents.push(event.event);
                    break;
                case "completed":
                    response = event.response;
                    break;
            }
        }
        if (!response) {
            throw new Error("Model stream ended without a completed response");
        }
        return { response, providerEvents };
    }

    private async needsModelRun(conversationId: string): Promise<boolean> {
        const items = await this.store.listConversationItems(conversationId);
        const transcriptInputs = items.filter(
            (item) =>
                item.class === "transcript" &&
                item.visibility === "model" &&
                (item.role === "user" || item.role === "system"),
        );
        const projections =
            await this.store.listContextProjections(conversationId);
        const coveredThroughProjection =
            projections.at(-1)?.coversThroughItemSequence ?? 0;
        const coveredSequences = new Set(
            transcriptInputs
                .filter((item) => item.sequence <= coveredThroughProjection)
                .map((item) => item.sequence),
        );
        const runs = await this.store.listAgentRuns(conversationId);
        const completedRunIds = new Set(
            runs
                .filter((run) => run.status === "completed")
                .map((run) => run.id),
        );
        const abandonedRunIds = new Set(
            runs
                .filter(
                    (run) =>
                        run.status === "cancelled" &&
                        wasRunInterrupted(run.error),
                )
                .map((run) => run.id),
        );
        for (const build of await this.store.listContextBuilds(
            conversationId,
        )) {
            if (
                !completedRunIds.has(build.runId) &&
                !abandonedRunIds.has(build.runId)
            ) {
                continue;
            }
            for (const sequence of build.selectedItemSequences) {
                coveredSequences.add(sequence);
            }
        }
        return transcriptInputs.some(
            (item) => !coveredSequences.has(item.sequence),
        );
    }

    private async promoteQueuedInputs(conversationId: string): Promise<void> {
        const items = await this.store.listConversationItems(conversationId);
        const promotedSourceIds = new Set(
            items
                .filter(
                    (item) =>
                        item.class === "transcript" &&
                        item.source?.type === "queued_input" &&
                        item.source.id,
                )
                .map((item) => item.source?.id),
        );
        const queued = items.filter(
            (item) =>
                item.class === "control" &&
                item.kind === "user_message" &&
                item.visibility === "ui" &&
                item.role === "user" &&
                item.data !== undefined &&
                dataDelivery(item.data) === "queue" &&
                !promotedSourceIds.has(item.id),
        );
        for (const item of queued) {
            await this.store.appendConversationItem({
                conversationId,
                class: "transcript",
                kind: "user_message",
                role: "user",
                visibility: "model",
                source: { type: "queued_input", id: item.id },
                content: item.content,
                data: { delivery: "queue", queuedItemId: item.id },
            });
        }
    }

    private async abandonedInputSequences(
        conversationId: string,
    ): Promise<Set<number>> {
        const runs = await this.store.listAgentRuns(conversationId);
        const abandonedRunIds = new Set(
            runs
                .filter(
                    (run) =>
                        run.status === "cancelled" &&
                        wasRunInterrupted(run.error),
                )
                .map((run) => run.id),
        );
        if (abandonedRunIds.size === 0) {
            return new Set();
        }
        const sequences = new Set<number>();
        for (const build of await this.store.listContextBuilds(
            conversationId,
        )) {
            if (!abandonedRunIds.has(build.runId)) {
                continue;
            }
            for (const sequence of build.selectedItemSequences) {
                sequences.add(sequence);
            }
        }
        return sequences;
    }

    private async requireConversation(
        conversationId: string,
    ): Promise<ConversationRecord> {
        const conversation = await this.store.getConversation(conversationId);
        if (!conversation) {
            throw new Error(`Conversation ${conversationId} not found`);
        }
        return conversation;
    }

    private async assertRunStillActive(runId: string): Promise<void> {
        const run = await this.store.getAgentRun(runId);
        if (!run) {
            throw new Error(`Run ${runId} not found`);
        }
        if (this.cancelledRuns.has(runId)) {
            throw new InactiveRunError(runId, "cancelled");
        }
        if (run.status !== "running") {
            throw new InactiveRunError(runId, run.status);
        }
    }
}

class InactiveRunError extends Error {
    public constructor(
        public readonly runId: string,
        public readonly status: AgentRunRecord["status"],
    ) {
        super(`Run ${runId} is ${status}`);
        this.name = "InactiveRunError";
    }
}

type ErrorPayload = { [key: string]: JSONType; message: string; name: string };

function errorPayload(error: unknown): ErrorPayload {
    return {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "Error",
    };
}

function dataDelivery(value: JSONType): string | undefined {
    return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.delivery === "string"
        ? value.delivery
        : undefined;
}
