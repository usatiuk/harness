import type { ChangeFile, ChangeMode, SubagentPage } from "@harness/client-features";
import type { Cell } from "@harness/client-features/transcript-reducer";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { Tooltip } from "radix-ui";
import type { ConversationId, DeliveryIntent, ModelInfo, ImageContent } from "@harness/protocol";
import { emptyState } from "@harness/client-features/transcript-reducer";
import { conversationProjectRoot } from "@harness/protocol";
import { createDesktopRouter } from "../../src/routes.tsx";
import { DesktopSession, ConversationView } from "../../src/session.ts";
import { DesktopTranscript } from "../../src/transcript.ts";
import { WindowShell } from "../../src/window-shell.tsx";
import type { AppSettings } from "@harness/server/client-protocol";

type Delivery = { text: string; intent: DeliveryIntent; images?: ImageContent[] };
let changePaths = ["src/first.ts", "src/nested/second.ts", "last.ts"];
const diffWaiters: Array<() => void> = [];
let holdLargeDiff = false;
const largeDiffWaiters: Array<() => void> = [];

type Deferred = { resolve(): void; reject(error: Error): void };
declare global {
  interface Window {
    composerFixture: {
      calls: Delivery[];
      feedbackCalls: unknown[];
      questionResponses: unknown[];
      failQuestionResponse: boolean;
      showQuestions(owner?: string): void;
      showImages(images: ImageContent[]): void;
      showToolsAndActivities(serverSkew?: number, phase?: string): void;
      showMultipleActivities(): void;
      showSubagents(): void;
      updateChild(id: string, text: string): void;
      openConversation(id: string): void;
      recreateRouter(): void;
      changeModes: string[];
      showManyChanges(): void;
      showLiteralChanges(): void;
      showCombinedChanges(): void;
      showLongLineChanges(): void;
      showDelayedChanges(): void;
      releaseLargeDiff(): void;
      holdDiffs: boolean;
      diffAborts: number;
      releaseDiffs(): void;
      showOwnedActivity(): void;
      finishSubagents(): void;
      activityKills: string[];
      seedSidebar(longTitles?: boolean): void;
      seedWorktreeSidebar(): void;
      seedRecentWorktrees(): void;
      markUnread(id: string): void;
      showMarkdown(): void;
      worktreeSwitches: unknown[];
      worktreeDeletes: unknown[];
      renameWorktree(branch: string): void;
      switchSidebarScope(scope: string): void;
      showEval(): void;
      showLivePreview(reasoningOnly?: boolean, withHistory?: boolean): void;
      showModelRetry(attempt?: number): void;
      clearModelRetry(): void;
      showBlankReasoning(withTool?: boolean): void;
      showLongToolRun(): void;
      showPreviewTools(): void;
      showWorkGroups(followingMessages?: number): void;
      splitWorkGroup(): void;
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
      showBackgroundWork(): void;
      settleStop(): void;
      disconnect(): void;
    };
  }
}
const id = "fixture" as ConversationId;
const view = new ConversationView({
  id,
  workspaceRoot: "D:\\example",
  overrides: {},
  head: null,
  title: null,
  createdAt: 0,
  lastUsedAt: 0,
  config: { instructions: "Fixture", model: { provider: "fixture", model: "test" } },
});
view.state = { ...emptyState, turn: { id: "turn", status: "running", startedAt: 0 } };
const settings: AppSettings = {
  home: "fixture",
  cwd: "D:\\example",
  platform: "win32",
  settings: {
    model: { provider: "fixture", model: "test", preset: null },
    sandbox: "none",
    toolMode: "hybrid",
    showToolNames: true,
    subagents: { maxDepth: 2, maxChildren: 3 },
    compactionThresholdTokens: null,
    worktreeDirectory: null,
    modelRetries: { attempts: 5, backoffMs: 1000 },
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
  for (const attachment of session.views.values()) attachment.publish();
  for (const listener of listeners) listener();
};
const calls: Delivery[] = [];
const feedbackCalls: unknown[] = [];
const settingsWrites: unknown[] = [];
const creations: Array<Parameters<DesktopSession["client"]["create"]>[0]> = [];
const providerCreates: unknown[] = [];
const providerWrites: { provider: string; patch: Record<string, boolean> }[] = [];
let sidebarScope = "composer-fixture";
let worktreeBranch = "harness/one";
let recentWorktrees: Array<{ path: string; branch: string; head: string; locked: boolean }> = [];
const subagentPages = new Map<string, SubagentPage>();
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
      supportsImages: true,
      presets: [{ value: "none" }, { value: "high" }],
    },
    { provider: "fixture", model: "test-latest", label: "Fixture model", supportsImages: false },
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
    const fork = new ConversationView(conversation);
    fork.state = state;
    fork.transcript.update([]);
    session.views.set(conversation.id, fork);
    sidebarRows.push(conversation);
    return { conversation, draft: [{ type: "text" as const, text: user.text }] };
  },
  deliver(_id: ConversationId, text: string, intent: DeliveryIntent, images?: ImageContent[]) {
    calls.push({ text, intent, ...(images?.length ? { images } : {}) });
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
  deliver: (...args: Parameters<typeof domain.deliver>) => domain.deliver(...args),
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
    async listChanges(_id: string, mode: ChangeMode, after: string | null = null) {
      window.composerFixture.changeModes.push(mode);
      const remaining = after === null ? changePaths : changePaths.filter((path) => path > after);
      const paths = remaining.slice(0, 200);
      return {
        repository: "/fixture",
        defaultBranch: "main",
        upstream: "origin/feature",
        unavailable: null,
        files: paths.map((path) => ({
          path,
          previousPath: null,
          status: path === "merge.ts" ? ("U" as const) : ("M" as const),
          additions: path === "binary.dat" ? null : path === "large.ts" ? 4000 : 45,
          deletions: path === "binary.dat" ? null : path === "large.ts" ? 4000 : 45,
        })),
        nextCursor: remaining.length > 200 ? paths.at(-1)! : null,
      };
    },
    async readChangeDiff(_id: string, mode: ChangeMode, file: ChangeFile, signal?: AbortSignal) {
      if (file.path === "large.ts" && holdLargeDiff)
        await new Promise<void>((resolve, reject) => {
          largeDiffWaiters.push(resolve);
          signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        });
      if (window.composerFixture.holdDiffs)
        await new Promise<void>((resolve, reject) => {
          diffWaiters.push(resolve);
          signal?.addEventListener(
            "abort",
            () => {
              window.composerFixture.diffAborts++;
              reject(new Error("Aborted"));
            },
            { once: true },
          );
        });
      if (file.path === "long-line.ts")
        return {
          patch: `diff --git a/long-line.ts b/long-line.ts\n--- a/long-line.ts\n+++ b/long-line.ts\n@@ -10 +10 @@ function ${"long_context_".repeat(80)}\n-${"before ".repeat(80)}\n+${"after ".repeat(80)}\n`,
          unavailable: null,
        };
      if (file.path === "binary.dat") return { patch: "", unavailable: "Binary file" };
      if (file.path === "merge.ts")
        return {
          patch:
            "diff --cc merge.ts\nindex aaa,bbb..ccc\n--- a/merge.ts\n+++ b/merge.ts\n@@@ -1,1 -1,1 +1,1 @@@\n++merged content\n",
          unavailable: null,
        };
      if (file.path.startsWith("odd\n"))
        return {
          patch: `diff --git ${JSON.stringify(`a/${file.path}`)} ${JSON.stringify(`b/${file.path}`)}\n--- /dev/null\n+++ ${JSON.stringify(`b/${file.path}`)}\n@@ -0,0 +1 @@\n+literal content\n\\ No newline at end of file\n`,
          unavailable: null,
        };
      const lines = file.path === "large.ts" ? 4000 : 45;
      return {
        patch:
          `diff --git ${JSON.stringify(`a/${file.path}`)} ${JSON.stringify(`b/${file.path}`)}\n--- a/${file.path}\n+++ b/${file.path}\n@@ -1,${lines} +1,${lines} @@\n` +
          Array.from({ length: lines }, (_, i) => `-before ${file.path} line ${i}`)
            .concat(Array.from({ length: lines }, (_, i) => `+${mode} ${file.path} line ${i}`))
            .join("\n"),
        unavailable: null,
      };
    },
    questions: {
      async respond(requestId: string, response: unknown) {
        if (window.composerFixture.failQuestionResponse)
          throw new Error("Question response rejected");
        window.composerFixture.questionResponses.push(response);
        for (const owner of session.views.values()) {
          if (!owner.questions.has(requestId)) continue;
          const next = new Map(owner.questions);
          next.delete(requestId);
          owner.questions = next;
        }
        changed();
      },
    },
    inspectSubagent: async (conversationId: string) =>
      session.views.get(conversationId as ConversationId)?.subagent ?? null,
    listSubagents: async (parent: string, cursor?: SubagentPage["nextCursor"]) => {
      const data = subagentPages.get(parent) ?? { children: [], nextCursor: null, running: 0 };
      return {
        ...data,
        children: data.children.slice(cursor ? 20 : 0, cursor ? 40 : 20),
        nextCursor:
          !cursor && data.children.length > 20 ? { createdAt: 0, id: "second-page" } : null,
      };
    },
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
          ...(recentWorktrees.length
            ? recentWorktrees
            : [
                {
                  path: "D:\\worktrees\\one",
                  branch: worktreeBranch,
                  head: "initial",
                  locked: false,
                },
              ]),
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
      kill: (activityId: string) => {
        window.composerFixture.activityKills.push(activityId);
        return Promise.resolve("requested");
      },
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
    const rows = sidebarRows.filter((row) => conversationProjectRoot(row) === root);
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
  subscribeSidebar: (listener: () => void) => session.subscribe(listener),
  sidebarSnapshot: () => revision,
  subscribeConnection: (listener: () => void) => session.subscribe(listener),
  connectionSnapshot: () => session.disconnected,
  storageKey: (key: string) => `${sidebarScope}:${key}`,
  readSettings: () => Promise.resolve(settings),
  load: (requested: string) => {
    if (session.views.has(requested as ConversationId))
      return Promise.resolve(session.views.get(requested as ConversationId)!);
    const conversation = sidebarRows.find((row) => row.id === requested);
    if (!conversation) return Promise.resolve(view);
    const selected = new ConversationView(conversation);
    selected.state = view.state;
    session.views.set(conversation.id, selected);
    return Promise.resolve(selected);
  },
};
window.composerFixture = {
  changeModes: [],
  showDelayedChanges() {
    changePaths = ["large.ts", "target.ts", "last.ts"];
    holdLargeDiff = true;
  },
  releaseLargeDiff() {
    holdLargeDiff = false;
    for (const release of largeDiffWaiters.splice(0)) release();
  },
  showLiteralChanges() {
    changePaths = ['odd\n@@bad".ts'];
  },
  showLongLineChanges() {
    changePaths = ["long-line.ts"];
  },
  showCombinedChanges() {
    changePaths = ["merge.ts", "binary.dat"];
  },
  showManyChanges() {
    changePaths = Array.from(
      { length: 205 },
      (_, index) => `files/${String(index).padStart(3, "0")}.ts`,
    );
  },
  holdDiffs: false,
  diffAborts: 0,
  releaseDiffs() {
    window.composerFixture.holdDiffs = false;
    for (const release of diffWaiters.splice(0)) release();
  },
  openConversation(id) {
    void router.navigate(`/conversations/${id}`);
  },
  recreateRouter() {
    const path = router.state.location.pathname;
    root.unmount();
    router.dispose();
    localStorage.setItem(session.storageKey("route"), path);
    router = createFixtureRouter();
    root = createRoot(document.getElementById("root")!);
    renderRouter();
  },
  updateChild(childId, text) {
    const child = session.views.get(childId as ConversationId)!;
    child.state = {
      ...child.state,
      cells: child.state.cells.map((cell) =>
        cell.kind === "assistant" ? { ...cell, text } : cell,
      ),
    };
    child.publish();
  },
  showImages(images) {
    view.state = {
      ...view.state,
      cells: [
        ...view.state.cells,
        {
          kind: "user",
          id: "image-user",
          turnId: "turn",
          createdAt: 0,
          text: "Image message",
          images,
        },
        {
          kind: "tool",
          id: "image-tool",
          turnId: "turn",
          callId: "image-call",
          name: "read_file",
          args: {},
          startedAt: 0,
          output: "Image read",
          status: "ok",
          images,
        },
      ],
    };
    view.transcript.update(view.state.cells, "turn");
    changed();
  },
  showSubagents() {
    view.conversation = { ...view.conversation, title: "Parent conversation" };
    view.state = {
      ...view.state,
      activities: [
        ...view.state.activities,
        { conversationId: id, id: "live-review", kind: "subagent", title: "Live review" },
      ],
    };
    const children: SubagentPage["children"] = [
      {
        id: "review",
        name: "Review authentication",
        slug: "auth-review",
        agent: "explore",
        status: "completed",
        hasChildren: true,
        running: 1,
      },
      {
        id: "live-review",
        name: "Live review",
        slug: "live",
        agent: "general",
        status: "completed",
        hasChildren: false,
        running: 0,
      },
      {
        id: "failed-review",
        name: "Failed review",
        slug: "failed",
        agent: "explore",
        status: "failed",
        hasChildren: false,
        running: 0,
      },
      {
        id: "stopped-review",
        name: "Stopped review",
        slug: "stopped",
        agent: "explore",
        status: "aborted",
        hasChildren: false,
        running: 0,
      },
      ...Array.from({ length: 17 }, (_, index) => ({
        id: `older-${index}`,
        name: `Older review ${index}`,
        slug: `older-${index}`,
        agent: "explore",
        status: "completed" as const,
        hasChildren: false,
        running: 0,
      })),
    ];
    subagentPages.set(id, { children, running: 1, nextCursor: null });
    subagentPages.set("review", {
      children: [
        {
          id: "nested",
          name: "Check tests",
          slug: "tests",
          agent: "explore",
          status: "running",
          hasChildren: false,
          running: 1,
        },
      ],
      running: 1,
      nextCursor: null,
    });
    for (const child of [...children.slice(0, 4), ...subagentPages.get("review")!.children]) {
      const cells: Cell[] = [
        { kind: "user", id: "task", turnId: "child-turn", text: "Delegated task", createdAt: 0 },
        {
          kind: "assistant",
          id: "answer",
          turnId: "child-turn",
          text: "Child transcript",
          streaming: false,
        },
      ];
      const transcript = new DesktopTranscript();
      transcript.update(cells);
      const childView = Object.assign(
        new ConversationView({ ...view.conversation, id: child.id as ConversationId }),
        {
          subagent: {
            name: child.name,
            slug: child.slug,
            agent: child.agent,
            ancestors: [
              { id, name: "Parent conversation" },
              ...(child.id === "nested" ? [{ id: "review", name: "Review authentication" }] : []),
            ],
          },
          transcript,
          state: {
            ...view.state,
            cells,
            turn:
              child.status === "running"
                ? { id: "child-turn", status: "running", startedAt: Date.now() }
                : { id: "child-turn", status: child.status },
          },
        },
      );
      session.views.set(child.id as ConversationId, childView);
    }
    view.subagentRevision++;
    changed();
  },
  showOwnedActivity() {
    view.state = {
      ...view.state,
      activities: [
        { conversationId: "nested", id: "owned-work", kind: "command", title: "Run checks" },
      ],
    };
    changed();
  },
  finishSubagents() {
    const data = subagentPages.get(id)!;
    subagentPages.set(id, {
      ...data,
      running: 0,
      children: data.children.map((child) => ({
        ...child,
        status: child.status === "running" ? "completed" : child.status,
        running: 0,
      })),
    });
    subagentPages.set("review", {
      ...subagentPages.get("review")!,
      running: 0,
      children: subagentPages
        .get("review")!
        .children.map((child) => ({ ...child, running: 0, status: "completed" })),
    });
    view.subagentRevision++;
    changed();
  },
  activityKills: [],
  showMultipleActivities() {
    view.state = {
      ...view.state,
      activities: [
        { conversationId: id, id: "first", kind: "subagent", title: "First activity" },
        { conversationId: id, id: "second", kind: "process", title: "Second activity" },
      ],
    };
    changed();
  },
  worktreeSwitches: [],
  worktreeDeletes: [],
  seedRecentWorktrees() {
    recentWorktrees = Array.from({ length: 8 }, (_, index) => ({
      path: `D:\\worktrees\\tree-${index}`,
      branch: `harness/recent-${index}`,
      head: "initial",
      locked: false,
    }));
    view.conversation = {
      ...view.conversation,
      workspaceRoot: recentWorktrees[6]!.path,
      originalWorkspaceRoot: "D:\\example",
    };
    changed();
  },
  seedWorktreeSidebar() {
    window.composerFixture.seedSidebar();
    sidebarRows = sidebarRows.map((row) =>
      row.workspaceRoot === "/work/a/repo"
        ? { ...row, originalWorkspaceRoot: row.workspaceRoot, workspaceRoot: `/trees/${row.id}` }
        : row,
    );
    session.recents.rows = sidebarRows.slice(0, 20);
    session.projectPages.clear();
    changed();
  },
  renameWorktree(branch) {
    // Change the server-side answer without publishing a client render/event.
    worktreeBranch = branch;
  },
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
  questionResponses: [],
  failQuestionResponse: false,
  showQuestions(owner = id) {
    const target = session.views.get(owner as ConversationId)!;
    target.questions = new Map([
      [
        "question-fixture",
        {
          id: "question-fixture",
          conversationId: owner,
          rootConversationId: id,
          callId: "ask-1",
          createdAt: 0,
          response: null,
          questions: [
            {
              id: "single",
              prompt: "Choose one",
              selection: "single",
              options: [
                { id: "a", label: "Alpha" },
                { id: "b", label: "Beta" },
                { id: "e", label: "Refactor / clean up" },
                { id: "f", label: "Documentation or planning" },
                { id: "g", label: "Just explore / answer questions" },
              ],
            },
            {
              id: "multiple",
              prompt: "Choose several",
              selection: "multiple",
              options: [
                { id: "c", label: "Gamma" },
                { id: "d", label: "Delta" },
              ],
            },
            { id: "freeform", prompt: "Any details?", selection: "single", options: null },
          ],
        },
      ],
    ]);
    changed();
  },
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
  showToolsAndActivities(serverSkew = 0, phase?: string) {
    const startedAt = Date.now() + serverSkew;
    view.state = {
      ...view.state,
      turn: { id: "turn", status: "running", startedAt },
      activities: [
        { conversationId: id, id: "live", kind: "subagent", title: "explore" },
        {
          conversationId: id,
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
          ...(phase ? { phase } : {}),
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
  showBlankReasoning(withTool = false) {
    const cells: Cell[] = [
      {
        kind: "reasoning",
        id: "blank",
        turnId: "turn",
        text: "  ",
        streaming: true,
        startedAt: Date.now(),
      },
    ];
    if (withTool)
      cells.push({
        kind: "tool",
        callId: "after-blank",
        turnId: "turn",
        name: "read_file",
        args: { path: "next.txt" },
        startedAt: Date.now(),
      });
    view.state = { ...view.state, cells };
    view.transcript.update(cells, "turn");
    changed();
  },
  showModelRetry(attempt = 2) {
    view.state = {
      ...view.state,
      modelRetry: {
        purpose: "agent",
        attempt,
        maxAttempts: 5,
        delayMs: 1200,
        reason: "rate_limit",
      },
    };
    changed();
  },
  clearModelRetry() {
    view.state = { ...view.state, modelRetry: undefined };
    changed();
  },
  showLivePreview(reasoningOnly = false, withHistory = false) {
    const startedAt = Date.now();
    const reasoning = {
      kind: "reasoning" as const,
      id: "preview-reasoning",
      turnId: "turn",
      text:
        "Check the shared timeout and preserve early cancellation. ".repeat(4000) +
        "Latest reasoning tail.\n\nNext check.\n\nFinal check.",
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
    const history: Cell[] = withHistory
      ? Array.from({ length: 80 }, (_, index) => ({
          kind: "user",
          id: `preview-history-${index}`,
          turnId: "history",
          text: `Earlier preview history ${index}`,
          createdAt: index,
        }))
      : [];
    view.state = {
      ...view.state,
      turn: { id: "turn", status: "running", startedAt },
      cells: reasoningOnly
        ? [...history, reasoning]
        : [
            ...history,
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
  showPreviewTools() {
    const tool = (
      name: string,
      args: unknown,
      status: "ok" | "error",
      output: string,
    ): Extract<Cell, { kind: "tool" }> => ({
      kind: "tool",
      callId: name + output,
      name,
      args,
      status,
      output,
      startedAt: 0,
      completedAt: 1,
    });
    view.state = {
      ...view.state,
      cells: [
        {
          kind: "reasoning",
          id: "preview-thought",
          turnId: "preview",
          text: "Checking the edits",
          streaming: false,
          startedAt: 0,
          completedAt: 1,
        },
        tool("write", { path: "good.txt", content: "new content" }, "ok", "Wrote good.txt"),
        tool(
          "edit",
          { path: "broken.txt", old_string: "old", new_string: "new" },
          "error",
          "Replacement failed",
        ),
        tool(
          "apply_patch",
          { patch: "*** Begin Patch\n*** Add File: patch.txt\n+patched\n*** End Patch" },
          "ok",
          "Patch applied",
        ),
        tool("read_file", { path: "read.txt" }, "ok", "Read content"),
        tool("write", { path: "malformed.txt" }, "ok", "Historical output"),
        {
          kind: "assistant",
          id: "preview-summary",
          turnId: "preview",
          text: "Preview summary",
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
    view.transcript.update(
      view.state.cells,
      view.state.turn.status === "running" ? view.state.turn.id : undefined,
    );
    changed();
  },
  showWorkGroups(followingMessages = 0) {
    const cells: Cell[] = [];
    for (const [group, count] of [4, 3, 6].entries()) {
      for (let index = 0; index < count; index++)
        cells.push({
          kind: "tool",
          callId: `group-${group}-${index}`,
          turnId: `group-${group}`,
          name: "read_file",
          args: { path: `file-${group}-${index}.txt` },
          startedAt: 0,
          completedAt: 1,
          status: "ok",
          output: `Output ${group}-${index}\n`.repeat(200),
        });
      if (group < 2)
        cells.push({
          kind: "assistant",
          id: `between-${group}`,
          turnId: `group-${group}`,
          text: `Update ${group}`,
          streaming: false,
        });
    }
    for (let index = 0; index < followingMessages; index++)
      cells.push({
        kind: "user",
        id: `following-${index}`,
        turnId: `following-${index}`,
        text: `Following message ${index}`,
        createdAt: index,
      });
    view.state = { ...view.state, turn: { id: "group-2", status: "completed" }, cells };
    view.transcript.update(cells);
    changed();
  },
  splitWorkGroup() {
    const cells: Cell[] = [
      ...view.state.cells,
      {
        kind: "assistant",
        id: "after-split",
        turnId: "after-split",
        text: "Moving on",
        streaming: false,
      },
      {
        kind: "tool",
        callId: "after-split",
        turnId: "after-split",
        name: "read_file",
        args: { path: "next.txt" },
        startedAt: 0,
        completedAt: 1,
        status: "ok",
        output: "Next output",
      },
    ];
    view.state = { ...view.state, cells };
    view.transcript.update(cells);
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
  showBackgroundWork() {
    const source = { kind: "plugin" as const, pluginId: "subagent" };
    view.state = {
      ...view.state,
      pendingInput: [
        { intent: "queue", text: "My follow-up", source: { kind: "user" } },
        ...[1, 2, 3].map((index) => ({
          intent: "steer" as const,
          text: `Background result ${index}`,
          source,
        })),
      ],
      cells: [
        { kind: "user", id: "human", turnId: "turn", text: "Original request", createdAt: 0 },
        {
          kind: "reasoning",
          id: "thought",
          turnId: "turn",
          text: "Thinking about the request",
          streaming: false,
          startedAt: Date.now(),
        },
        { kind: "provider_output", id: "search", turnId: "turn", text: "Searched the web" },
        {
          kind: "plugin_message",
          id: "background",
          turnId: "turn",
          pluginId: "subagent",
          text: "Explorer found the answer",
        },
        {
          kind: "tool",
          turnId: "turn",
          callId: "read",
          name: "read_file",
          args: { path: "answer.ts" },
          startedAt: Date.now(),
        },
      ],
    };
    view.transcript.update(view.state.cells, "turn");
    changed();
  },
  setPendingInput() {
    view.state = {
      ...view.state,
      pendingInput: [{ intent: "queue", text: "Queued follow-up", source: { kind: "user" } }],
    };
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
const createFixtureRouter = () =>
  createDesktopRouter(session as unknown as DesktopSession, {
    controls: h("span", null, "Fixture"),
    local: true,
    label: "Fixture",
    restart: () => Promise.reject(new Error("Restart is outside fixture scope")),
  });
let router = createFixtureRouter();
let root = createRoot(document.getElementById("root")!);
const renderRouter = () =>
  root.render(h(Tooltip.Provider, null, h(WindowShell, null, h(RouterProvider, { router }))));
renderRouter();

export { view, session };
