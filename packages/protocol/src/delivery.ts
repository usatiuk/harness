import type { ContentBlock } from "./content.ts";
import { z } from "zod";

/**
 * How a piece of input joins the loop. Outer vocabulary — the engine maps each to
 * concrete behavior (see the in-engine delivery module):
 *   send      — start a turn now if idle, else queue it after the current turn.
 *   steer     — inject into the running turn at the next after-tool-result boundary.
 *   queue     — run strictly after the current turn completes.
 *   interrupt — abort the current step and start a fresh turn with this input.
 */
export type DeliveryIntent = "send" | "steer" | "queue" | "interrupt";

/** Who originated the input. Plugin-sourced delivery powers background activities. */
export const deliverySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("plugin"), pluginId: z.string() }),
]);
export type DeliverySource = z.infer<typeof deliverySourceSchema>;

export const pendingInputSchema = z.strictObject({
  intent: z.enum(["queue", "steer"]),
  text: z.string(),
  source: deliverySourceSchema,
});
export type PendingInput = z.infer<typeof pendingInputSchema>;

export interface DeliveryInput {
  source: DeliverySource;
  content: ContentBlock[];
}
