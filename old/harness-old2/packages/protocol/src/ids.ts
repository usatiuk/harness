import { z } from "zod";

export const idSchema = z.string().min(1);
export type EntityId = z.infer<typeof idSchema>;

export type ConversationId = EntityId;
export type ConversationItemId = EntityId;
export type AgentRunId = EntityId;
export type ContextBuildId = EntityId;
export type ProfileId = EntityId;
export type ProviderPayloadId = EntityId;
