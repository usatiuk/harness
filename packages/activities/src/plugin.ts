import type {
  Conversation,
  ConversationId,
  ModelMiddleware,
  Plugin,
  ServiceProvider,
  Tool,
  ToolMiddleware,
} from "@harness/protocol";
import { ActivityManager } from "./manager.ts";
import { backgroundInjectMiddleware, consumeMiddleware } from "./consume.ts";
import { ActivityKillTool, ActivityListTool, ActivityPeekTool, ActivityWaitTool } from "./tools.ts";

/** Owns the per-conversation `ActivityManager`s, the consumption middleware pair, and the `activity_*` tools. */
class ActivitiesPlugin implements Plugin {
  readonly id = "activities";
  readonly #managers = new Map<ConversationId, ActivityManager>();

  #managerFor(id: ConversationId): ActivityManager {
    let manager = this.#managers.get(id);
    if (!manager) {
      manager = new ActivityManager();
      this.#managers.set(id, manager);
    }
    return manager;
  }

  services(): ServiceProvider[] {
    return [
      { key: "activities", for: (conversation: Conversation) => this.#managerFor(conversation.id) },
    ];
  }

  toolMiddleware(): ToolMiddleware[] {
    return [consumeMiddleware()];
  }

  modelMiddleware(): ModelMiddleware[] {
    return [backgroundInjectMiddleware()];
  }

  tools(): Tool[] {
    return [
      new ActivityWaitTool(),
      new ActivityPeekTool(),
      new ActivityListTool(),
      new ActivityKillTool(),
    ];
  }

  /** Shutdown sweep: SIGTERM every tracked activity across all conversations (CLI exit). */
  shutdownAll(): void {
    for (const manager of this.#managers.values()) manager.killAll();
  }
}

export const activitiesPlugin = new ActivitiesPlugin();
