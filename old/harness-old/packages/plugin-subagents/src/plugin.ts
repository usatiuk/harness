import type { HarnessPlugin, ActivityDriver, HarnessKernel } from "@harness/core";

export const SUBAGENTS_PLUGIN_ID = "plugin.subagents";

export interface SubagentsPlugin extends HarnessPlugin {
  setKernel(kernel: HarnessKernel): void;
}

export function createSubagentsPlugin(): SubagentsPlugin {
  let kernelRef: HarnessKernel | undefined;

  const subagentDriver: ActivityDriver = {
    async status(activity) {
      if (!kernelRef) {
        return { status: activity.status };
      }
      const state = activity.activityState as { childConversationId?: string } | undefined;
      if (!state?.childConversationId) {
        return { status: activity.status };
      }
      const childConv = await kernelRef.store.getConversation(state.childConversationId);
      if (!childConv) {
        return { status: activity.status };
      }
      return {
        status: activity.status,
        childConversation: {
          id: childConv.id,
          status: childConv.status
        }
      };
    },
    async cancel(activity) {
      if (!kernelRef) {
        return;
      }
      const state = activity.activityState as { childConversationId?: string } | undefined;
      if (!state?.childConversationId) {
        return;
      }
      const activeTurn = await kernelRef.store.getActiveTurn(state.childConversationId);
      if (activeTurn) {
        await kernelRef.interruptTurn(activeTurn.id, "Subagent activity cancelled by parent.");
      } else {
        await kernelRef.store.updateConversation({ id: state.childConversationId, status: "cancelled" });
      }
    },
    async summarizeCompletion(activity) {
      if (!kernelRef) {
        return undefined;
      }
      const state = activity.activityState as { childConversationId?: string } | undefined;
      if (!state?.childConversationId) {
        return undefined;
      }
      const child = await kernelRef.store.getConversation(state.childConversationId);
      const messages = await kernelRef.store.listMessages(state.childConversationId, { limit: 1 });
      const lastMessageText = messages[0]?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (lastMessageText && activity.status === "completed") {
        return [{ type: "text", text: lastMessageText }];
      }
      return [{ type: "text", text: `Subagent ${state.childConversationId} finished with status ${child?.status ?? activity.status}.` }];
    }
  };

  return {
    id: SUBAGENTS_PLUGIN_ID,
    setKernel(kernel: HarnessKernel) {
      kernelRef = kernel;
    },
    activityDrivers: {
      "plugin.subagents.run": subagentDriver
    }
  };
}
