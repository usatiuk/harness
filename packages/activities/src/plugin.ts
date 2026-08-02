import type {
  Conversation,
  ModelMiddleware,
  Plugin,
  ServiceProvider,
  Tool,
  ToolMiddleware,
} from "@harness/protocol";
import { ActivityManager } from "./manager.ts";
import { backgroundInjectMiddleware, consumeMiddleware } from "./consume.ts";
import { ActivityKillTool, ActivityListTool, ActivityPeekTool, ActivityWaitTool } from "./tools.ts";

/** Contributes runtime-owned activity managers, consumption middleware, and `activity_*` tools. */
class ActivitiesPlugin implements Plugin {
  readonly id = "activities";

  services(): ServiceProvider[] {
    return [
      {
        key: "activities",
        for: (conversation: Conversation) => new ActivityManager(conversation.id),
        dispose: (service) => (service as ActivityManager).dispose(),
      },
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
}

export const activitiesPlugin = new ActivitiesPlugin();
