import type { HarnessPlugin } from "@harness/core";

export const SOURCE_FIRST_MARKER = "plugin-control:src";
export const CONTROL_PLUGIN_ID = "plugin.control";

export function createControlPlugin(): HarnessPlugin {
  return {
    id: CONTROL_PLUGIN_ID,
    async contextFragments() {
      return [
        {
          type: "text",
          text: "Control plugin demo: keep tool results compact and preserve asset references."
        }
      ];
    },
    async beforeToolCall(input) {
      if (input.call.name === "blocked_demo") {
        return { blocked: true, reason: "blocked_demo is disabled by the control plugin" };
      }
      return input.call;
    }
  };
}
