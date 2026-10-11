import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { Tooltip } from "radix-ui";
import type { ConversationId, DeliveryIntent, ModelInfo } from "@harness/protocol";
import { emptyState } from "@harness/client-features/transcript-reducer";
import { createDesktopRouter } from "../../src/routes.tsx";
import { DesktopSession, type ConversationView } from "../../src/session.ts";
import { DesktopTranscript } from "../../src/transcript.ts";
import { WindowShell } from "../../src/window-shell.tsx";
import type { AppSettings } from "@harness/server/client-protocol";

type Delivery = { text: string; intent: DeliveryIntent };
type Deferred = { resolve(): void; reject(error: Error): void };
declare global {
  interface Window {
    composerFixture: {
      calls: Delivery[];
      showToolsAndActivities(): void;
      showLongToolRun(): void;
      seedHistory(): void;
      seedCollapsedHistory(): void;
      historyCalls: number;
      failHistory: boolean;
      releaseHistory(): void;
      insertReasoning(): void;
      completeSteps(): void;
      finishActivity(): void;
      peekCalls: number;
      peekOutput: string;
      holdPeek: boolean;
      releasePeek(): void;
      settingsWrites: unknown[];
      creations: Array<Parameters<DesktopSession["client"]["create"]>[0]>;
      setDefaultModel(model: string): void;
      setTitle(title: string): void;
      providerWrites: { provider: string; patch: Record<string, boolean> }[];
      failProviderSave: boolean;
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
    title: null,
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
    autoApproval: { enabled: false, model: null, timeoutSeconds: 30 },
    conversationTitleModel: null,
  },
  providers: [
    {
      id: "work",
      label: "Work",
      type: "openai-api",
      settings: [
        { key: "webSearch", title: "Web search", description: null, value: true },
        { key: "provider", title: "Compact output", description: null, value: true },
      ],
    },
    {
      id: "personal",
      label: "Personal",
      type: "openai-api",
      settings: [{ key: "webSearch", title: "Web search", description: null, value: false }],
    },
    { id: "gateway", label: "Gateway", type: "opencode-go", settings: [] },
  ].map((provider) => ({
    ...provider,
    kind: "api-key" as const,
    canStore: false,
    authenticated: false,
    detail: null,
    credentialSource: null,
    registered: false,
    catalog: "missing-credentials" as const,
    modelCount: 0,
    diagnostics: [],
  })),
};
let revision = 0;
const listeners = new Set<() => void>();
const changed = () => {
  revision++;
  for (const listener of listeners) listener();
};
const calls: Delivery[] = [];
const settingsWrites: unknown[] = [];
const creations: Array<Parameters<DesktopSession["client"]["create"]>[0]> = [];
const providerWrites: { provider: string; patch: Record<string, boolean> }[] = [];
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
let releaseHistory: (() => void) | undefined;
let collapsedPages = 0;
let releasePeek: (() => void) | undefined;
const session = {
  async older() {
    window.composerFixture.historyCalls++;
    await new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    if (window.composerFixture.failHistory) throw new Error("History unavailable");
    view.cursor = collapsedPages > 1 ? `page-${collapsedPages - 1}` : null;
    const earlier =
      collapsedPages > 0
        ? [
            {
              kind: "reasoning" as const,
              id: `earlier-thought-${collapsedPages--}`,
              turnId: "old",
              text: "Earlier reasoning",
              streaming: false,
              startedAt: 0,
            },
          ]
        : Array.from({ length: 20 }, (_, index) => ({
            kind: "user" as const,
            id: `earlier-${index}`,
            turnId: "old",
            text: `Earlier history ${index}`,
            createdAt: index,
          }));
    view.state = {
      ...view.state,
      cells: [...earlier, ...view.state.cells],
    };
    view.transcript.update(view.state.cells);
    changed();
  },
  plugins: {
    activities: () => ({
      async peek() {
        window.composerFixture.peekCalls++;
        if (window.composerFixture.holdPeek)
          await new Promise<void>((resolve) => {
            releasePeek = resolve;
          });
        return [{ type: "text", text: window.composerFixture.peekOutput }];
      },
      kill: () => Promise.resolve("requested"),
    }),
  },
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
        if (definition.method === "app.providers.config.update") {
          if (window.composerFixture.failProviderSave) throw new Error("Provider save failed");
          const update = params as { provider: string; patch: Record<string, boolean> };
          providerWrites.push(update);
          for (const setting of settings.providers.find(
            (provider) => provider.id === update.provider,
          )!.settings) {
            if (Object.hasOwn(update.patch, setting.key))
              setting.value = update.patch[setting.key]!;
          }
          return { restartRequired: true };
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
  setTitle(title) {
    view.conversation = { ...view.conversation, title };
    session.conversations = [view.conversation];
    changed();
  },
  calls,
  historyCalls: 0,
  failHistory: false,
  releaseHistory() {
    releaseHistory?.();
    releaseHistory = undefined;
  },
  seedHistory() {
    view.cursor = "older-page";
    view.state = {
      ...view.state,
      cells: Array.from({ length: 60 }, (_, index) => ({
        kind: "user" as const,
        id: `history-${index}`,
        turnId: "old",
        text: `Current history ${index}`,
        createdAt: index,
      })),
    };
    view.transcript.update(view.state.cells);
    changed();
  },
  seedCollapsedHistory() {
    collapsedPages = 3;
    view.cursor = "collapsed-page";
    view.state = {
      ...view.state,
      cells: [
        {
          kind: "reasoning",
          id: "latest-thought",
          turnId: "old",
          text: "Current reasoning",
          streaming: false,
          startedAt: 0,
        },
      ],
    };
    view.transcript.update(view.state.cells);
    changed();
  },
  insertReasoning() {
    const thought = {
      kind: "reasoning" as const,
      id: "thought",
      turnId: "turn",
      text: "Checking credential ownership",
      streaming: false,
      startedAt: 0,
      observedTiming: true as const,
    };
    view.state = {
      ...view.state,
      cells: [view.state.cells[0]!, thought, ...view.state.cells.slice(1)],
    };
    view.transcript.update(view.state.cells);
    changed();
  },
  completeSteps() {
    view.state = {
      ...view.state,
      cells: view.state.cells.map((cell) =>
        cell.kind === "tool"
          ? { ...cell, status: "ok", completedAt: 12_000 }
          : cell.kind === "reasoning"
            ? { ...cell, streaming: false, completedAt: 2_000 }
            : cell,
      ),
    };
    view.transcript.update(view.state.cells);
    changed();
  },
  peekCalls: 0,
  peekOutput: "Checking authentication",
  holdPeek: false,
  releasePeek() {
    releasePeek?.();
    releasePeek = undefined;
  },
  showToolsAndActivities() {
    view.state = {
      ...view.state,
      activities: [
        { id: "live", kind: "subagent", title: "explore" },
        {
          id: "finished",
          kind: "process",
          title: "old command",
          status: "ok",
          summary: "finished",
        },
      ],
      cells: [
        { kind: "user", id: "user", turnId: "turn", text: "Check authentication", createdAt: 0 },
        {
          kind: "tool",
          callId: "read",
          name: "read_file",
          args: { path: "credentials.ts", note: "Long arguments ".repeat(100) },
          startedAt: 0,
          status: "ok",
          output: "Full file output",
        },
        {
          kind: "tool",
          callId: "search",
          name: "glob",
          args: { pattern: "**/*.ts" },
          startedAt: 0,
        },
        {
          kind: "assistant",
          id: "assistant",
          turnId: "turn",
          text: "Checking the stores",
          streaming: false,
        },
      ],
    };
    view.transcript.update(view.state.cells);
    changed();
  },
  showLongToolRun() {
    view.state = {
      ...view.state,
      cells: Array.from({ length: 100 }, (_, index) => ({
        kind: "tool" as const,
        callId: `write-${index}`,
        name: "write",
        args: { path: `file-${index}.txt`, content: "line\n".repeat(1000) },
        startedAt: 0,
        status: "ok" as const,
        output: `Wrote file-${index}.txt`,
      })),
    };
    view.transcript.update(view.state.cells);
    changed();
  },
  finishActivity() {
    view.state = {
      ...view.state,
      activities: view.state.activities.map((activity) => ({
        ...activity,
        status: "ok",
        summary: "finished",
      })),
    };
    changed();
  },
  settingsWrites,
  creations,
  setDefaultModel(model) {
    settings.settings.model = { provider: "fixture", model, preset: null };
  },
  providerWrites,
  failProviderSave: false,
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
  h(Tooltip.Provider, null, h(WindowShell, null, h(RouterProvider, { router }))),
);
