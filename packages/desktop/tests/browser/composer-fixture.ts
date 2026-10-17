import type { Cell } from "@harness/client-features/transcript-reducer";
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
      feedbackCalls: unknown[];
      showToolsAndActivities(serverSkew?: number): void;
      seedSidebar(longTitles?: boolean): void;
      markUnread(id: string): void;
      showMarkdown(): void;
      worktreeSwitches: unknown[];
      worktreeDeletes: unknown[];
      switchSidebarScope(scope: string): void;
      showEval(): void;
      showLivePreview(reasoningOnly?: boolean): void;
      showLongToolRun(): void;
      seedHistory(): void;
      seedCollapsedHistory(): void;
      historyCalls: number;
      failHistory: boolean;
      releaseHistory(): void;
      insertReasoning(): void;
      completeSteps(finishTurn?: false | "completed" | "failed" | "aborted"): void;
      appendPreviewReasoning(text: string): void;
      finishActivity(): void;
      peekCalls: number;
      peekOutput: string;
      holdPeek: boolean;
      releasePeek(): void;
      settingsWrites: unknown[];
      creations: Array<Parameters<DesktopSession["client"]["create"]>[0]>;
      setDefaultModel(model: string): void;
      setTitle(title: string): void;
      providerCreates: unknown[];
      providerWrites: { provider: string; patch: Record<string, boolean> }[];
      failProviderSave: boolean;
      settle(reject?: boolean): void;
      setPendingInput(): void;
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
    lastUsedAt: 0,
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
    toolMode: "hybrid",
    compactionThresholdTokens: null,
    worktreeDirectory: null,
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
const feedbackCalls: unknown[] = [];
const settingsWrites: unknown[] = [];
const creations: Array<Parameters<DesktopSession["client"]["create"]>[0]> = [];
const providerCreates: unknown[] = [];
const providerWrites: { provider: string; patch: Record<string, boolean> }[] = [];
let sidebarScope = "composer-fixture";
let sidebarRows: (typeof view.conversation)[] = [];
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
  async forkBefore(_source: ConversationId, itemId: import("@harness/protocol").ItemId) {
    const user = view.state.cells.find((cell) => cell.kind === "user" && cell.id === itemId);
    if (user?.kind !== "user") throw new Error("fork target must be a user message");
    const conversation = {
      ...view.conversation,
      id: "fixture-fork" as ConversationId,
      title: "Forked conversation",
    };
    const state = {
      ...view.state,
      cells: [],
      turn: { status: "idle" as const },
    };
    const fork = { ...view, conversation, state, transcript: new DesktopTranscript() };
    fork.transcript.update([]);
    session.views.set(conversation.id, fork);
    sidebarRows.push(conversation);
    return { conversation, draft: [{ type: "text" as const, text: user.text }] };
  },
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
} satisfies Pick<
  DesktopSession["domain"],
  "availableModels" | "defaultModel" | "deliver" | "forkBefore"
>;
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
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
    changed();
  },
  plugins: {
    async createWorktreeConversation(
      cwd: string,
      overrides: Record<string, import("@harness/protocol").JsonValue>,
    ) {
      window.composerFixture.worktreeSwitches.push({ kind: "create", cwd });
      view.conversation = {
        ...view.conversation,
        workspaceRoot: "D:\\worktrees\\one",
        originalWorkspaceRoot: cwd,
      };
      return session.client.create({ cwd: "D:\\worktrees\\one", overrides });
    },
    async worktreeRepository(cwd: string) {
      return cwd.includes("not-git") ? null : cwd;
    },
    async workspaceOptions() {
      return {
        original: "D:\\example",
        current: view.conversation.workspaceRoot,
        worktrees: [
          { path: "D:\\example", branch: "main", head: "initial", locked: false },
          { path: "D:\\worktrees\\one", branch: "harness/one", head: "initial", locked: false },
        ],
      };
    },
    async switchWorkspace(_id: string, selection: { kind: string; path?: string }) {
      window.composerFixture.worktreeSwitches.push(selection);
      view.conversation = {
        ...view.conversation,
        workspaceRoot:
          selection.kind === "original" ? "D:\\example" : (selection.path ?? "D:\\worktrees\\one"),
        originalWorkspaceRoot: "D:\\example",
      };
      changed();
    },
    async managedWorktrees() {
      return [{ path: "D:\\worktrees\\one", repository: "D:\\example", createdAt: 1 }];
    },
    async removeWorktree(path: string, force: boolean) {
      window.composerFixture.worktreeDeletes.push({ path, force });
    },
    async dockerEnvironments() {
      return [];
    },
    async controlDockerEnvironment() {},
    runningActivities: () =>
      view.state.activities.filter((activity) => activity.status === undefined).length,
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
    async setTitle(_id: string, title: string) {
      if (!title.trim()) throw new Error("Title is empty");
      window.composerFixture.setTitle(title.trim());
    },
    async create(params: Parameters<DesktopSession["client"]["create"]>[0]) {
      creations.push(params);
      if (sidebarRows.length) {
        const row = {
          ...view.conversation,
          id: "sidebar-created" as ConversationId,
          workspaceRoot: params?.cwd ?? null,
          lastUsedAt: 2000,
          title: "New chat",
        };
        sidebarRows.unshift(row);
        session.recents.rows.unshift(row);
        return {
          ...row,
          config: {
            instructions: "Fixture",
            model: { provider: "fixture", model: "test", preset: null },
            tools: null,
            plugins: {},
            compaction: null,
          },
        };
      }
      return {
        ...view.conversation,
        config: {
          instructions: "Fixture",
          model: { provider: "fixture", model: "test", preset: null },
          tools: null,
          compaction: null,
          plugins: {},
        },
      };
    },
    peer: {
      ready: true,
      request: async (definition: { method: string }, params: unknown) => {
        if (definition.method === "plugin.feedback.status")
          return {
            enabled: true,
            configured: true,
            endpoint: "http://127.0.0.1:7331",
            pending: 0,
            failed: 0,
          };
        if (definition.method === "plugin.feedback.vote") {
          feedbackCalls.push(params);
          return {
            id: (params as { id: string }).id,
            status: "queued",
            url: "http://127.0.0.1:7331/#/feedback/fixture",
          };
        }
        if (definition.method === "plugin.mcp.settings.get")
          return { config: {}, active: [], restartRequired: false, credentialBackend: null };
        if (definition.method === "plugin.mcp.tools.list") return [];
        if (definition.method === "app.settings.update") {
          settingsWrites.push(params);
          Object.assign(settings.settings, params);
          return null;
        }
        if (definition.method === "app.providers.create") {
          providerCreates.push(params);
          const value = params as { id: string; label: string; type: string };
          settings.providers.push({
            id: value.id,
            label: value.label,
            type: value.type,
            kind: "api-key",
            canStore: true,
            authenticated: false,
            detail: null,
            credentialSource: null,
            registered: false,
            catalog: "missing-credentials",
            modelCount: 0,
            diagnostics: [],
            settings: [],
          });
          return { restartRequired: true };
        }
        if (definition.method === "app.auth.login") return { restartRequired: true };
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
  login(input: unknown, signal?: AbortSignal) {
    return session.client.peer.request({ method: "app.auth.login" }, input).then(() => {
      signal?.throwIfAborted();
    });
  },
  settings,
  create(...args: Parameters<DesktopSession["create"]>) {
    return DesktopSession.prototype.create.call(this as unknown as DesktopSession, ...args);
  },
  changed,
  disconnected: undefined as string | undefined,
  recents: {
    rows: [view.conversation],
    cursor: null as { lastUsedAt: number; id: string } | null,
    loading: false,
    loaded: true,
    error: null,
  },
  projects: {
    rows: [],
    cursor: null,
    loading: false,
    loaded: true,
    error: null,
  } as DesktopSession["projects"],
  projectPages: new Map<
    string,
    {
      rows: (typeof view.conversation)[];
      cursor: { lastUsedAt: number; id: string } | null;
      loading: boolean;
      loaded: boolean;
      error: string | null;
    }
  >(),
  async loadProjects() {},
  async loadProject(root: string, more = false) {
    const rows = sidebarRows.filter((row) => row.workspaceRoot === root);
    const previous = session.projectPages.get(root);
    const count = more ? (previous?.rows.length ?? 0) + 5 : 5;
    session.projectPages.set(root, {
      rows: rows.slice(0, count),
      cursor:
        count < rows.length
          ? { lastUsedAt: rows[count - 1]!.lastUsedAt, id: rows[count - 1]!.id }
          : null,
      loading: false,
      loaded: true,
      error: null,
    });
    changed();
  },
  async list(more = false) {
    if (!sidebarRows.length) return;
    const count = more ? session.recents.rows.length + 20 : 20;
    session.recents = {
      rows: sidebarRows.slice(0, count),
      cursor:
        count < sidebarRows.length
          ? { lastUsedAt: sidebarRows[count - 1]!.lastUsedAt, id: sidebarRows[count - 1]!.id }
          : null,
      loading: false,
      loaded: true,
      error: null,
    };
    changed();
  },
  async refreshSidebar() {},
  unread: new Set<ConversationId>(),
  setActiveConversation(active: ConversationId | null) {
    if (active && session.unread.delete(active)) changed();
  },
  views: new Map([[id, view]]),

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: () => revision,
  storageKey: (key: string) => `${sidebarScope}:${key}`,
  readSettings: () => Promise.resolve(settings),
  load: (requested: string) => {
    if (requested === "fixture-fork")
      return Promise.resolve(session.views.get(requested as ConversationId)!);
    const conversation = sidebarRows.find((row) => row.id === requested);
    if (!conversation) return Promise.resolve(view);
    const selected = { ...view, conversation };
    session.views.set(conversation.id, selected);
    return Promise.resolve(selected);
  },
};
window.composerFixture = {
  worktreeSwitches: [],
  worktreeDeletes: [],
  switchSidebarScope(scope) {
    sidebarScope = scope;
    changed();
  },
  seedSidebar(longTitles = false) {
    sidebarRows = ["/work/a/repo", "/work/b/repo", "/work/older"]
      .flatMap((workspaceRoot, folder) =>
        Array.from({ length: 25 }, (_, index) => ({
          ...view.conversation,
          id: `sidebar-${folder}-${index}` as ConversationId,
          workspaceRoot,
          title: longTitles
            ? `A very long conversation title in folder ${folder} — ${index}`
            : `Chat ${folder}-${index}`,
          createdAt: index,
          lastUsedAt: 1000 - index * 3 - folder,
        })),
      )
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    session.recents = {
      rows: sidebarRows.slice(0, 20),
      cursor: { lastUsedAt: sidebarRows[19]!.lastUsedAt, id: sidebarRows[19]!.id },
      loading: false,
      loaded: true,
      error: null,
    };
    session.projects = {
      rows: ["/work/a/repo", "/work/b/repo", "/work/older"].map((workspaceRoot, index) => ({
        workspaceRoot,
        lastUsedAt: 1000 - index,
      })),
      cursor: null,
      loading: false,
      loaded: true,
      error: null,
    };
    session.projectPages.clear();
    changed();
  },
  markUnread(id) {
    session.unread.add(id as ConversationId);
    changed();
  },
  showMarkdown() {
    view.state = {
      ...view.state,
      turn: { id: "turn", status: "completed" },
      cells: [
        {
          kind: "assistant",
          id: "markdown",
          turnId: "turn",
          streaming: false,
          text: "# Representation review\n\n## Value wrapper\n\nThe wrapper resolves the alias conflict.\n\n- Ptr breaks the recursive cycle.\n- Values remain inspectable.\n\n---\n\n### Record needs a deep copy\n\nCopying the pointers shares their values. Copy the fields instead.\n\n```cpp\nr = { x: 1 };\ns = r;\n```",
        },
      ],
    };
    view.transcript.update(view.state.cells);
    changed();
  },
  setTitle(title) {
    view.conversation = { ...view.conversation, title };
    session.recents.rows = [view.conversation];
    changed();
  },
  calls,
  feedbackCalls,
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
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
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
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
    changed();
  },
  insertReasoning() {
    const thought = {
      kind: "reasoning" as const,
      id: "thought",
      turnId: "turn",
      text: "Checking credential ownership",
      streaming: false,
      startedAt: Date.now(),
      observedTiming: true as const,
    };
    view.state = {
      ...view.state,
      cells: [view.state.cells[0]!, thought, ...view.state.cells.slice(1)],
    };
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
    changed();
  },
  completeSteps(finishTurn: false | "completed" | "failed" | "aborted" = "completed") {
    view.state = {
      ...view.state,
      ...(finishTurn ? { turn: { id: "turn", status: finishTurn } } : {}),
      cells: view.state.cells.map((cell) =>
        cell.kind === "tool"
          ? { ...cell, status: "ok", completedAt: cell.startedAt + 12_000 }
          : cell.kind === "reasoning"
            ? { ...cell, streaming: false, completedAt: cell.startedAt + 2_000 }
            : cell,
      ),
    };
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
    changed();
  },
  peekCalls: 0,
  peekOutput: "Checking authentication",
  holdPeek: false,
  releasePeek() {
    releasePeek?.();
    releasePeek = undefined;
  },
  showToolsAndActivities(serverSkew = 0) {
    const startedAt = Date.now() + serverSkew;
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
          turnId: "turn",
          callId: "read",
          name: "read_file",
          args: { path: "credentials.ts", note: "Long arguments ".repeat(100) },
          startedAt,
          status: "ok",
          output: "Full file output",
        },
        {
          kind: "tool",
          turnId: "turn",
          callId: "search",
          name: "glob",
          args: { pattern: "**/*.ts" },
          startedAt,
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
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
    changed();
  },
  appendPreviewReasoning(text: string) {
    const last = view.state.cells.at(-1);
    view.state = {
      ...view.state,
      cells:
        last?.kind === "reasoning" && last.streaming
          ? [...view.state.cells.slice(0, -1), { ...last, text }]
          : [
              ...view.state.cells,
              { kind: "reasoning", turnId: "turn", text, streaming: true, startedAt: Date.now() },
            ],
    };
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
    changed();
  },
  showLivePreview(reasoningOnly = false) {
    const startedAt = Date.now();
    const reasoning = {
      kind: "reasoning" as const,
      id: "preview-reasoning",
      turnId: "turn",
      text:
        "Check the shared timeout and preserve early cancellation. ".repeat(4000) +
        "Latest reasoning tail.",
      streaming: true,
      startedAt,
      observedTiming: true as const,
    };
    const call = (
      callId: string,
      name: string,
      args: unknown,
      running = false,
    ): Extract<Cell, { kind: "tool" }> => ({
      kind: "tool",
      turnId: "turn",
      callId,
      name,
      args,
      startedAt,
      ...(running ? {} : { status: "ok" as const, completedAt: startedAt }),
    });
    view.state = {
      ...view.state,
      turn: { id: "turn", status: "running", startedAt },
      cells: reasoningOnly
        ? [reasoning]
        : [
            call("preview-old", "read_file", { path: "old.ts" }),
            call("preview-glob", "glob", { pattern: "**/auth*" }),
            call("preview-read", "read_file", { path: "auth.ts" }),
            reasoning,
            call("preview-edit", "edit", {
              path: "auth.ts",
              old_string: "1000",
              new_string: "5000",
            }),
            call("preview-exec", "exec", { command: "npm test -- auth" }, true),
          ],
    };
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
    changed();
  },
  showEval() {
    const startedAt = Date.now() - 12_000;
    view.state = {
      ...view.state,
      turn: { id: "turn", status: "completed" },
      cells: [
        {
          kind: "tool",
          turnId: "turn",
          callId: "eval",
          name: "eval",
          args: { code: "await tools.read_file({path: 'auth.ts'})" },
          startedAt,
          status: "ok",
          completedAt: startedAt + 12_000,
          output: '{"updated":true}',
        },
        {
          kind: "tool",
          turnId: "turn",
          callId: "read",
          parentCallId: "eval",
          name: "read_file",
          args: { path: "auth.ts" },
          startedAt,
          status: "error",
          completedAt: startedAt + 1000,
          output: "File not found",
        },
        {
          kind: "tool",
          turnId: "turn",
          callId: "exec",
          parentCallId: "eval",
          name: "exec",
          args: { command: "npm test" },
          startedAt,
          status: "ok",
          completedAt: startedAt + 10_000,
          output: "6 tests passed",
        },
      ],
    };
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
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
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
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
  providerCreates,
  providerWrites,
  failProviderSave: false,
  setPendingInput() {
    view.state = { ...view.state, pendingInput: [{ intent: "queue", text: "Queued follow-up" }] };
    changed();
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
  h(Tooltip.Provider, null, h(WindowShell, null, h(RouterProvider, { router }))),
);
