import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { Tooltip } from "radix-ui";
import type { ConversationId, DeliveryIntent, ModelInfo } from "@harness/protocol";
import { emptyState } from "@harness/client-features/transcript-reducer";
import { createDesktopRouter } from "../../src/routes.tsx";
import { DesktopSession, type ConversationView } from "../../src/session.ts";
import { DesktopTranscript } from "../../src/transcript.ts";
import type { AppSettings } from "@harness/server/client-protocol";

type Delivery = { text: string; intent: DeliveryIntent };
type Deferred = { resolve(): void; reject(error: Error): void };
declare global {
  interface Window {
    composerFixture: {
      calls: Delivery[];
      settingsWrites: unknown[];
      creations: unknown[];
      setDefaultModel(model: string): void;
      settle(reject?: boolean): void;
      settleStop(): void;
      disconnect(): void;
    };
  }
}
const id = "fixture" as ConversationId;
const view: ConversationView = {
  conversation: {
    id,
    workspaceRoot: "D:\\example",
    overrides: {},
    head: null,
    createdAt: 0,
    config: { instructions: "Fixture", model: { provider: "fixture", model: "test" } },
  },
  state: { ...emptyState, turn: { id: "turn", status: "running", startedAt: 0 } },
  transcript: new DesktopTranscript(),
  approvals: new Map(),
  items: [],
  anchor: null,
  cursor: null,
};
const settings: AppSettings = {
  home: "fixture",
  cwd: "D:\\example",
  platform: "win32",
  settings: {
    model: { provider: "fixture", model: "test", preset: null },
    sandbox: "local",
    approval: { inWorkspace: "ask", outOfWorkspace: "ask", humanApprovalTimeoutSeconds: 60 },
    autoApproval: { enabled: false, model: null },
  },
  providers: [],
};
let revision = 0;
const listeners = new Set<() => void>();
const changed = () => {
  revision++;
  for (const listener of listeners) listener();
};
const calls: Delivery[] = [];
const settingsWrites: unknown[] = [];
const creations: unknown[] = [];
let pending: Deferred | undefined;
let stopping: Deferred | undefined;
const domain = {
  availableModels: (): ModelInfo[] => [
    {
      provider: "fixture",
      model: "test",
      label: "Fixture model",
      contextWindow: 262144,
      reasoning: { supported: true },
      presets: [{ value: "none" }, { value: "high" }],
    },
    { provider: "fixture", model: "test-latest", label: "Fixture model" },
  ],
  defaultModel: () => view.conversation.config.model,
  deliver(_id: ConversationId, text: string, intent: DeliveryIntent) {
    calls.push({ text, intent });
    return new Promise<void>((resolve, reject) => {
      if (intent === "interrupt") {
        if (stopping) throw new Error("Duplicate interrupt");
        stopping = { resolve, reject };
      } else {
        if (pending) throw new Error("Duplicate delivery");
        pending = { resolve, reject };
      }
    });
  },
} satisfies Pick<DesktopSession["domain"], "availableModels" | "defaultModel" | "deliver">;
// Substitute only the session/data edge. Production route actions, fetchers,
// Composer, controls, draft storage and preference handling execute unchanged.
// Native cases qualify real RPC and server semantics separately.
const session = {
  domain,
  client: {
    async create(params: Parameters<DesktopSession["client"]["create"]>[0]) {
      creations.push(params);
      return {
        ...view.conversation,
        config: {
          instructions: "Fixture",
          model: { provider: "fixture", model: "test", preset: null },
          tools: null,
          plugins: {},
        },
      };
    },
    peer: {
      ready: true,
      request: async (definition: { method: string }, params: unknown) => {
        if (definition.method === "plugin.mcp.settings.get")
          return { config: {}, active: [], restartRequired: false, credentialBackend: null };
        if (definition.method === "plugin.mcp.tools.list") return [];
        if (definition.method === "app.settings.update") {
          settingsWrites.push(params);
          Object.assign(settings.settings, params);
          return null;
        }
        throw new Error(`Unexpected fixture RPC: ${definition.method}`);
      },
    },
  },
  settings,
  create(...args: Parameters<DesktopSession["create"]>) {
    return DesktopSession.prototype.create.call(this as unknown as DesktopSession, ...args);
  },
  changed,
  disconnected: undefined as string | undefined,
  conversations: [view.conversation],
  views: new Map([[id, view]]),
  listLoaded: true,
  listCursor: null,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: () => revision,
  storageKey: (key: string) => `composer-fixture:${key}`,
  readSettings: () => Promise.resolve(settings),
  load: () => Promise.resolve(view),
};
window.composerFixture = {
  calls,
  settingsWrites,
  creations,
  setDefaultModel(model) {
    settings.settings.model = { provider: "fixture", model, preset: null };
  },
  settle(reject = false) {
    if (!pending) throw new Error("No pending delivery");
    if (reject) pending.reject(new Error("Delivery rejected"));
    else pending.resolve();
    pending = undefined;
  },
  settleStop() {
    if (!stopping) throw new Error("No pending interrupt");
    view.state = { ...view.state, turn: { id: "turn", status: "aborted" } };
    stopping.resolve();
    stopping = undefined;
    changed();
  },
  disconnect() {
    session.disconnected = "Disconnected fixture";
    changed();
  },
};
localStorage.setItem(session.storageKey("route"), `/conversations/${id}`);
const router = createDesktopRouter(session as unknown as DesktopSession, {
  controls: h("span", null, "Fixture"),
  local: true,
  label: "Fixture",
  restart: () => Promise.reject(new Error("Restart is outside fixture scope")),
});
createRoot(document.getElementById("root")!).render(
  h(Tooltip.Provider, null, h(RouterProvider, { router })),
);
