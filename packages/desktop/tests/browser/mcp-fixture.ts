import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { HarnessClient } from "@harness/client";
import { mcpConfigSchema } from "@harness/mcp/client";
import { McpSettings } from "../../src/components/mcp-settings.tsx";
import "../../src/styles.css";

let config = mcpConfigSchema.parse({});
const calls: { method: string; params: unknown }[] = [];
const credentials = new Set<string>();
let attempt: { attemptId: string; url: string; redirectUrl: string } | undefined;
let attemptServer: string | undefined;
let authenticated = false;
const root = createRoot(document.getElementById("root")!);
window.mcpFixture = { calls, opened: [], otherSigningIn: false, unmount: () => root.unmount() };
declare global {
  interface Window {
    mcpFixture: {
      calls: typeof calls;
      opened: string[];
      otherSigningIn: boolean;
      unmount(): void;
    };
  }
}
const client = {
  peer: {
    request: async (definition: { method: string }, params: Record<string, unknown>) => {
      calls.push({ method: definition.method, params });
      switch (definition.method) {
        case "plugin.mcp.settings.get":
          return {
            config,
            restartRequired: true,
            credentialBackend: "file",
            active: Object.keys(config.servers).map((id) => ({
              id,
              status: "disabled",
              detail: null,
              toolCount: 0,
              authenticated,
              signingIn:
                (!!attempt && id === attemptServer) ||
                (id === "other" && window.mcpFixture.otherSigningIn),
              credentials: [...credentials].map((slot) => ({ slot, present: true })),
            })),
          };
        case "plugin.mcp.tools.list":
          return [];
        case "plugin.mcp.settings.set":
          config = mcpConfigSchema.parse(params["config"]);
          return { restartRequired: true };
        case "plugin.mcp.credentials.set":
          credentials.add(String(params["slot"]));
          return null;
        case "plugin.mcp.credentials.delete":
          credentials.delete(String(params["slot"]));
          return null;
        case "plugin.mcp.test":
          return {
            id: params["serverId"],
            status: "ready",
            detail: null,
            toolCount: 2,
            authenticated: true,
            signingIn: false,
            credentials: [],
          };
        case "plugin.mcp.auth.start":
          attemptServer = String(params["serverId"]);
          attempt = {
            attemptId: "fixture-attempt",
            url: "https://example.com/authorize?state=fixture-state",
            redirectUrl: "http://127.0.0.1:4321/auth/callback",
          };
          return attempt;
        case "plugin.mcp.auth.complete":
          authenticated = true;
          attempt = undefined;
          return null;
        case "plugin.mcp.auth.cancel":
          attempt = undefined;
          return null;
        case "plugin.mcp.auth.logout":
          authenticated = false;
          attempt = undefined;
          return null;
        default:
          throw new Error("Unexpected fixture RPC");
      }
    },
  },
} as unknown as HarnessClient;
root.render(
  h(McpSettings, {
    client,
    openUrl: async (url) => {
      window.mcpFixture.opened.push(url);
    },
    restart: async () => {},
  }),
);
