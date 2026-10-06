import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { Tooltip } from "radix-ui";
import type { ConversationId, DeliveryIntent } from "@harness/protocol";
import { emptyState } from "@harness/client-features/transcript-reducer";
import { createDesktopRouter } from "../../src/routes.tsx";
import type { DesktopSession, ConversationView } from "../../src/session.ts";
import { DesktopTranscript } from "../../src/transcript.ts";
import type { AppSettings } from "@harness/server/client-protocol";

type Delivery = { text: string; intent: DeliveryIntent };
type Deferred = { resolve(): void; reject(error: Error): void };
declare global {
  interface Window {
    composerFixture: {
      calls: Delivery[];
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
    approval: { inWorkspace: "ask", outOfWorkspace: "ask" },
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
let pending: Deferred | undefined;
let stopping: Deferred | undefined;
const domain = {
  availableModels: () => [],
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
  client: { peer: { ready: true } },
  settings,
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
