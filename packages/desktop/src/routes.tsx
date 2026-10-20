import { TranscriptDisclosure } from "./components/transcript-disclosure.tsx";
import { ActionFeedback, type ActionResult } from "./components/action-feedback.tsx";
import {
  InstructionsSettings,
  type InstructionsReadResult,
} from "./components/instructions-settings.tsx";
import TextareaAutosize from "react-textarea-autosize";
import { ImagePreviews } from "./components/image-previews.tsx";
import { RetryStatusLine } from "./components/retry-status.tsx";
import {
  readImageFiles,
  readImagePaths,
  readClipboardImages,
  needsClipboardRead,
} from "./image-files.ts";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { QuestionRequestForm } from "./components/question-request.tsx";
import { questionResponseSchema } from "@harness/protocol";
import { FeedbackControls, FeedbackSettings } from "./components/feedback-controls.tsx";
import { APP_NAME } from "./app-name.ts";
import {
  NewWorktreeOption,
  WorktreeControl,
  ManagedWorktrees,
  ManagedDockerEnvironments,
} from "./components/worktree-controls.tsx";
import { ActivityOwner, SubagentHeading } from "./components/subagent-control.tsx";
import { RightSidebarLayout } from "./components/right-sidebar.tsx";
import { SidebarLayout } from "./components/sidebar.tsx";
import { McpSettings } from "./components/mcp-settings.tsx";
import { DesktopUpdates } from "./components/desktop-updates.tsx";
import { ModelSelect, modelKey } from "./components/model-select.tsx";
import {
  memo,
  useCallback,
  useMemo,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  createMemoryRouter,
  Form,
  Link,
  NavLink,
  Outlet,
  redirect,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRouteError,
  useRouteLoaderData,
  useRevalidator,
  useSearchParams,
  useLocation,
  useParams,
  type ActionFunctionArgs,
} from "react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { editPresentation } from "@harness/client-features/edit-presentation";
import type { Cell, State } from "@harness/client-features/transcript-reducer";
import { toolPermissionSchema, type ClientApproval } from "@harness/approval/client";
import {
  textOf,
  imageContentsSchema,
  type ImageContent,
  compactionThresholdSchema,
  type Conversation,
  type ConversationId,
} from "@harness/protocol";
import {
  appAuthLogoutRequest,
  appSettingsUpdateRequest,
  appInstructionsRequest,
  appInstructionsUpdateRequest,
  appProviderConfigUpdateRequest,
  appProviderCreateRequest,
  modelRetriesSettingsSchema,
  type AppSettings,
} from "@harness/server/client-protocol";
import type { TranscriptRow, TranscriptStep } from "./transcript.ts";
import { DesktopSession, type ConversationView, type ConversationSnapshot } from "./session.ts";
import {
  Button,
  Checkbox,
  Input,
  Select,
  SelectItem,
  IconButton,
  PopoverControl,
  Confirmation,
  Disclosure,
  Tabs,
  useScrollShadows,
} from "./ui.tsx";
import { useComposerPreferences } from "./appearance.ts";
import { composerKey } from "./preferences.ts";
import { ContextUsage, LastTurnStats } from "./components/usage-inspector.tsx";
import { ConversationCanvas } from "./components/conversation-canvas.tsx";
import { AppearanceControls, ComposerSettings } from "./components/appearance-controls.tsx";
import {
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Send,
  Square,
  ChevronDown,
  Settings2,
  Paperclip,
  BookOpen,
  PenLine,
  Code,
  Search,
  Terminal,
  Wrench,
  GitFork,
  Copy,
  Check,
  X,
} from "lucide-react";

const composerFields = [
  "turn",
  "pendingInput",
  "agentContext",
  "usage",
  "cost",
  "costIncomplete",
  "usageIncomplete",
  "lastTurn",
] as const satisfies readonly (keyof State)[];
type RootData = { settings: AppSettings };
const basename = (path: string | null): string =>
  path === null ? "Conversation" : (path.split(/[/\\]/u).filter(Boolean).at(-1) ?? path);
const field = (data: FormData, name: string): string => {
  const value = data.get(name);
  if (typeof value !== "string") throw new Error(`Missing ${name}`);
  return value;
};
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const conversationLabel = (conversation: Conversation, view?: ConversationSnapshot): string => {
  const title = view?.conversation.title ?? conversation.title;
  if (title) return title;
  const user = view?.state.cells.findLast((cell) => cell.kind === "user");
  return user?.kind === "user"
    ? user.text.split("\n")[0]!.slice(0, 64)
    : `${basename(conversation.workspaceRoot)} · ${new Date(conversation.createdAt).toLocaleString()}`;
};

export function createDesktopRouter(
  session: DesktopSession,
  connections: { controls: ReactNode; local: boolean; label: string; restart(): Promise<void> },
) {
  const emptyImageDraft = { images: [] as ImageContent[], reading: 0, error: "" };
  type ImageDraft = typeof emptyImageDraft;
  const imageDrafts = new Map<string, ImageDraft>();
  const imageDraftListeners = new Set<() => void>();
  const subscribeImageDrafts = (listener: () => void) => {
    imageDraftListeners.add(listener);
    return () => {
      imageDraftListeners.delete(listener);
    };
  };
  const getImageDraft = (id: string): ImageDraft => imageDrafts.get(id) ?? emptyImageDraft;
  const updateImageDraft = (id: string, update: (draft: ImageDraft) => ImageDraft) => {
    imageDrafts.set(id, update(getImageDraft(id)));
    for (const listener of imageDraftListeners) listener();
  };
  const useLive = (): void => {
    useSyncExternalStore(session.subscribe, session.snapshot);
  };

  async function action({ request }: ActionFunctionArgs): Promise<ActionResult | Response> {
    try {
      const data = await request.formData();
      const intent = field(data, "intent");
      switch (intent) {
        case "fork": {
          const result = await session.domain.forkBefore(
            field(data, "conversationId") as ConversationId,
            field(data, "itemId") as import("@harness/protocol").ItemId,
          );
          updateImageDraft(result.conversation.id, (draft) => ({
            ...draft,
            images: result.draft.filter((block): block is ImageContent => block.type === "image"),
          }));
          localStorage.setItem(
            session.storageKey(`draft:${result.conversation.id}`),
            textOf(result.draft),
          );
          await session.refreshSidebar();
          return redirect(`/conversations/${result.conversation.id}`);
        }
        case "rename":
          await session.client.setTitle(field(data, "conversationId"), field(data, "title"));
          return { ok: true };
        case "approval": {
          const decision = field(data, "decision");
          if (decision !== "allow" && decision !== "deny")
            throw new Error("Invalid approval decision");
          await session.plugins.approvals.respond(field(data, "requestId"), decision);
          return { ok: true };
        }
        case "question": {
          const response =
            data.get("dismiss") === "true"
              ? { status: "dismissed" as const }
              : questionResponseSchema.parse(JSON.parse(field(data, "response")));
          await session.plugins.questions.respond(field(data, "requestId"), response);
          return { ok: true };
        }
        case "older":
          await session.older(field(data, "conversationId"));
          return { ok: true };
        case "send": {
          const id = field(data, "conversationId") as ConversationId;
          const delivery = field(data, "delivery");
          if (delivery !== "send" && delivery !== "queue" && delivery !== "steer")
            throw new Error("Invalid input delivery");
          const text = field(data, "text").trim();
          const images = imageContentsSchema.parse(JSON.parse(field(data, "images")));
          const capturedImages = getImageDraft(id).images;
          if (!text && images.length === 0) throw new Error("Enter a message");
          try {
            await session.deliver(id, text, delivery, images);
          } catch (error) {
            if (!session.client.peer.ready)
              throw new Error(
                "Connection lost. Delivery outcome is unknown; reconnect and check the conversation before sending again.",
                { cause: error },
              );
            throw error;
          }
          updateImageDraft(id, (draft) => ({
            ...draft,
            images: draft.images.filter((image) => !capturedImages.includes(image)),
          }));
          if (localStorage.getItem(session.storageKey(`draft:${id}`)) === field(data, "text"))
            localStorage.removeItem(session.storageKey(`draft:${id}`));
          return { ok: true };
        }
        case "stop":
          await session.domain.deliver(
            field(data, "conversationId") as ConversationId,
            "",
            "interrupt",
          );
          return { ok: true };
        case "model": {
          const [provider, model] = field(data, "model").split("\u0000");
          if (!provider || !model) throw new Error("Select a model");
          await session.domain.setModel(field(data, "conversationId") as ConversationId, {
            provider,
            model,
          });
          return { ok: true };
        }
        case "preset": {
          const id = field(data, "conversationId") as ConversationId;
          const view = await session.load(id);
          await session.domain.setPreset(
            id,
            view.conversation.config.model,
            field(data, "preset") || undefined,
          );
          return { ok: true };
        }
        case "sandbox": {
          const id = field(data, "conversationId") as ConversationId;
          const view = await session.load(id);
          if (view.state.turn.status === "running")
            throw new Error("Stop the running turn before changing sandbox");
          await session.domain.setPluginConfig(
            id,
            "sandbox",
            { backend: field(data, "sandbox") },
            { saveGlobal: true },
          );
          const result = await session.client.reload(id, true);
          if (result.status === "busy")
            throw new Error("Conversation became busy; stop it and apply the sandbox again");
          return { ok: true };
        }
        case "rebuild":
          await session.plugins.rebuildSandbox(field(data, "conversationId") as ConversationId);
          return { ok: true };
        case "sandbox-stop":
          await session.plugins.stopSandbox(field(data, "conversationId") as ConversationId);
          return { ok: true };
        case "activity-kill":
          await session.plugins
            .activities(field(data, "conversationId") as ConversationId)
            .kill(field(data, "activityId"));
          return { ok: true };
        case "login": {
          await session.login(
            {
              provider: field(data, "provider"),
              key: data.has("key") ? field(data, "key") : null,
              flow: field(data, "flow"),
            },
            request.signal,
          );
          return {
            ok: true,
            restartRequired: true,
            message: "Signed in. Restart Harness to apply the provider.",
          };
        }
        case "logout":
          await session.client.peer.request(appAuthLogoutRequest, {
            provider: field(data, "provider"),
          });
          return {
            ok: true,
            restartRequired: true,
            message: "Stored credentials removed. Restart Harness to apply the change.",
          };
        case "add-litellm": {
          const id = field(data, "id").trim();
          await session.client.peer.request(appProviderCreateRequest, {
            id,
            type: "litellm",
            label: field(data, "label").trim() || id,
            config: { baseUrl: field(data, "baseUrl").trim(), apiKey: { stored: true } },
          });
          const key = field(data, "key");
          if (key) {
            try {
              await session.login({ provider: id, key, flow: "browser" }, request.signal);
            } catch (error) {
              throw new Error(
                `Provider saved, but the API key was not stored: ${errorMessage(error)}. Use its sign-in field to try again.`,
                { cause: error },
              );
            }
          }
          return {
            ok: true,
            restartRequired: true,
            message: "LiteLLM saved. Restart the server to load its models.",
          };
        }
        case "provider-settings": {
          const provider = session.settings?.providers.find(
            (entry) => entry.id === field(data, "provider"),
          );
          if (!provider) throw new Error("Unknown provider connection");
          const patch: Record<string, boolean> = {};
          for (const setting of provider.settings) {
            const value = field(data, `setting:${setting.key}`);
            if (value !== "true" && value !== "false")
              throw new Error(`Invalid ${setting.title} setting`);
            if ((value === "true") !== setting.value) patch[setting.key] = value === "true";
          }
          if (!Object.keys(patch).length)
            return { ok: true, message: "Provider settings unchanged." };
          await session.client.peer.request(appProviderConfigUpdateRequest, {
            provider: provider.id,
            patch,
          });
          return {
            ok: true,
            restartRequired: true,
            message: "Provider settings saved. Restart the server to apply the change.",
          };
        }
        case "server-settings":
          await session.client.peer.request(appSettingsUpdateRequest, {
            keepServerRunning: data.get("keepServerRunning") === "on",
          });
          return { ok: true, message: "Server settings saved." };
        case "instructions":
          await session.client.peer.request(appInstructionsUpdateRequest, {
            content: field(data, "content"),
          });
          return {
            ok: true,
            message: "Instructions saved. Applies to new or reloaded conversations.",
          };
        case "settings": {
          const compactionInput = field(data, "compactionThresholdTokens");
          const compactionThresholdTokens =
            compactionInput === ""
              ? null
              : compactionThresholdSchema.parse(Number(compactionInput));
          const modelRetries = modelRetriesSettingsSchema.parse({
            attempts: Number(field(data, "modelRetriesAttempts")),
            backoffMs: Number(field(data, "modelRetriesBackoffMs")),
          });
          const [provider, model] = field(data, "model").split("\u0000");
          const inWorkspace = field(data, "inWorkspace");
          const outOfWorkspace = field(data, "outOfWorkspace");
          const sandbox = field(data, "sandbox");
          const autoApproval = field(data, "autoApproval");
          const [reviewerProvider, reviewerModel] = field(data, "reviewerModel").split("\u0000");
          const reviewerPreset = reviewerModel ? field(data, "reviewerPreset") : "";
          const [titleProvider, titleModel] = field(data, "titleModel").split("\u0000");
          const titlePreset = titleModel ? field(data, "titlePreset") : "";
          if (
            ![inWorkspace, outOfWorkspace].every(
              (value) => toolPermissionSchema.safeParse(value).success,
            )
          )
            throw new Error("Invalid approval policy");
          if (sandbox !== "none" && sandbox !== "native" && sandbox !== "docker")
            throw new Error("Invalid sandbox");
          if (autoApproval !== "true" && autoApproval !== "false")
            throw new Error("Invalid auto approver setting");
          await session.client.peer.request(appSettingsUpdateRequest, {
            model:
              provider && model
                ? {
                    provider,
                    model,
                    preset:
                      session.settings?.settings.model?.provider === provider &&
                      session.settings.settings.model.model === model
                        ? session.settings.settings.model.preset
                        : null,
                  }
                : null,
            approval: {
              inWorkspace: toolPermissionSchema.parse(inWorkspace),
              outOfWorkspace: toolPermissionSchema.parse(outOfWorkspace),
              humanApprovalTimeoutSeconds: Number(field(data, "humanApprovalTimeoutSeconds")),
            },
            autoApproval: {
              enabled: autoApproval === "true",
              timeoutSeconds: Number(field(data, "autoApprovalTimeoutSeconds")),
              model:
                reviewerProvider && reviewerModel
                  ? {
                      provider: reviewerProvider,
                      model: reviewerModel,
                      preset: reviewerPreset || null,
                    }
                  : null,
            },
            conversationTitleModel:
              titleProvider && titleModel
                ? { provider: titleProvider, model: titleModel, preset: titlePreset || null }
                : null,
            sandbox,
            showToolNames: data.get("showToolNames") === "on",
            subagents: {
              maxDepth: Number(field(data, "subagentMaxDepth")),
              maxChildren: Number(field(data, "subagentMaxChildren")),
            },
            compactionThresholdTokens,
            modelRetries,
            worktreeDirectory: field(data, "worktreeDirectory").trim() || null,
          });
          return {
            ok: true,
            message:
              "Settings saved. New or reloaded conversations use these defaults. Restart the server to apply compaction changes to already-loaded conversations.",
          };
        }
        default:
          throw new Error(`Unknown action: ${String(intent)}`);
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  function RestartButton() {
    const returnFocus = useRef<HTMLDivElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [confirmRestart, setConfirmRestart] = useState(false);
    return (
      <div className="restart" ref={returnFocus} tabIndex={-1}>
        <p className="muted">
          Restart saves history and stops all conversations, commands and pending approvals.
        </p>
        <Button
          disabled={busy}
          onClick={() => {
            const running = [...session.views.values()].some(
              (view) =>
                view.state.turn.status === "running" ||
                session.plugins.runningActivities(view.conversation.id) > 0,
            );
            if (running) {
              setConfirmRestart(true);
              return;
            }
            setBusy(true);
            void connections.restart().catch((cause: unknown) => {
              setError(errorMessage(cause));
              setBusy(false);
            });
          }}
        >
          {busy ? "Restarting…" : "Restart Harness"}
        </Button>
        <Confirmation
          acceptedFocusRef={returnFocus}
          open={confirmRestart}
          onOpenChange={setConfirmRestart}
          title="Restart Harness?"
          description="Restart saves history and stops all conversations, commands and pending approvals."
          confirmLabel="Restart Harness"
          onConfirm={() => {
            setBusy(true);
            void connections.restart().catch((cause: unknown) => {
              setError(errorMessage(cause));
              setBusy(false);
            });
          }}
        />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    );
  }
  function Approval({ approval }: { approval: ClientApproval }) {
    const fetcher = useFetcher<ActionResult>();
    return (
      <section className="approval" aria-label="Approval request">
        <strong>Allow {approval.call.name}?</strong>
        {approval.relationship && <span className="muted">{approval.relationship}</span>}
        <pre>
          {typeof approval.call.args === "string"
            ? approval.call.args
            : JSON.stringify(approval.call.args, null, 2)}
        </pre>
        <fetcher.Form method="post" action="/actions" className="button-row">
          <Input type="hidden" name="intent" value="approval" />
          <Input type="hidden" name="requestId" value={approval.requestId} />
          <Button type="submit" name="decision" value="deny" disabled={fetcher.state !== "idle"}>
            Deny
          </Button>
          <Button
            type="submit"
            variant="accent"
            name="decision"
            value="allow"
            disabled={fetcher.state !== "idle"}
          >
            Allow
          </Button>
        </fetcher.Form>
        <ActionFeedback data={fetcher.data} />
      </section>
    );
  }
  function Layout() {
    useSyncExternalStore(session.subscribeSidebar, session.sidebarSnapshot);
    useSyncExternalStore(session.subscribeConnection, session.connectionSnapshot);
    const navigation = useNavigation();
    const renderConversation = (conversation: Conversation) => {
      const view = session.views.get(conversation.id);
      const status = view?.approvals.size
        ? "Approval needed"
        : view?.state.turn.status === "running"
          ? "Running"
          : view?.state.turn.status === "failed"
            ? "Failed"
            : "";
      return (
        <NavLink
          key={conversation.id}
          to={`/conversations/${conversation.id}`}
          title={conversation.workspaceRoot ?? undefined}
        >
          <span className="conversation-title">{conversationLabel(conversation, view)}</span>
          {conversation.originalWorkspaceRoot &&
            conversation.workspaceRoot !== conversation.originalWorkspaceRoot && (
              <GitBranch size={12} aria-label="Worktree" />
            )}
          {status === "Running" ? (
            <LoaderCircle
              size={12}
              className="conversation-running loading-icon"
              role="img"
              aria-label="Running"
            />
          ) : (
            status && (
              <span
                className={`conversation-status-mark ${view?.approvals.size ? "approval-status" : view?.state.turn.status === "failed" ? "failed-status" : ""}`}
                aria-label={status}
                title={status}
              />
            )
          )}
          {session.unread.has(conversation.id) && (
            <span className="conversation-status-mark" aria-label="Unread" title="Unread" />
          )}
        </NavLink>
      );
    };
    return (
      <SidebarLayout
        key={session.storageKey("sidebar-groups")}
        session={session}
        controls={connections.controls}
        renderConversation={renderConversation}
      >
        <main>
          {session.disconnected && (
            <div className="connection-error" role="alert">
              <strong>{session.disconnected}</strong>
              <RestartButton />
            </div>
          )}
          {navigation.state === "loading" && (
            <div className="navigation-status" role="status">
              Loading conversation…
            </div>
          )}
          {navigation.state === "loading" &&
            [...session.views.values()].flatMap((view) =>
              [...view.approvals.values()].map((approval) => (
                <Approval key={approval.requestId} approval={approval} />
              )),
            )}
          <Outlet />
        </main>
      </SidebarLayout>
    );
  }
  function Welcome() {
    return (
      <div className="welcome">
        <h1>Start a conversation</h1>
        <p>
          Select a folder and a model to begin. Your conversations stay available in the sidebar.
        </p>
        <Link to="/new" className="new-conversation">
          New conversation
        </Link>
        <Link to="/settings">Connect a provider</Link>
      </div>
    );
  }
  function SandboxOptions({ selected }: { selected?: string }) {
    return (
      <>
        <SelectItem value="none">None</SelectItem>
        {session.settings?.platform === "linux" && <SelectItem value="native">Native</SelectItem>}
        {session.settings?.platform !== "linux" && selected === "native" && (
          <SelectItem value="native">Native (Linux only)</SelectItem>
        )}
        <SelectItem value="docker">Docker / devcontainer</SelectItem>
      </>
    );
  }
  function NewConversation() {
    const { settings } = useRouteLoaderData<RootData>("app")!;
    const [search] = useSearchParams();
    const location = useLocation();
    const projectDirectory = search.get("cwd");
    const [cwd, setCwd] = useState(
      projectDirectory ??
        localStorage.getItem(session.storageKey("last-directory")) ??
        settings.cwd,
    );
    useEffect(() => {
      if (projectDirectory !== null) setCwd(projectDirectory);
    }, [projectDirectory, location.key]);
    const navigation = useNavigation();
    const defaultModel = settings.settings.model ?? session.domain.defaultModel();
    const [selection, setSelection] = useState(modelKey(defaultModel.provider, defaultModel.model));
    const [preset, setPreset] = useState(defaultModel.preset ?? "");
    const catalog = session.domain
      .availableModels()
      .find((model) => modelKey(model.provider, model.model) === selection);
    const presets = catalog?.presets ?? [];
    const [backend, setBackend] = useState<string>(settings.settings.sandbox);
    const [toolMode, setToolMode] = useState<string>(settings.settings.toolMode);
    const backendAvailable = backend !== "native" || settings.platform === "linux";
    const available = session.domain
      .availableModels()
      .some((model) => modelKey(model.provider, model.model) === selection);
    const [error, setError] = useState<string>();
    return (
      <section className="page new-page">
        <div className="page-heading">
          <h1>New conversation</h1>
        </div>
        <p className="page-lead">
          Choose a project folder to give your conversation a place to work.
        </p>
        <Form method="post" className="creation-form">
          <div className="folder-field">
            <label>
              Project folder
              <Input
                name="cwd"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                required
              />
            </label>
            {connections.local && (
              <Button
                type="button"
                onClick={() => {
                  void open({ directory: true, multiple: false, title: "Choose project folder" })
                    .then((path) => {
                      if (typeof path === "string") setCwd(path);
                    })
                    .catch((cause: unknown) => setError(errorMessage(cause)));
                }}
              >
                <FolderOpen size={15} aria-hidden="true" /> Choose folder…
              </Button>
            )}
            {!connections.local && (
              <p className="muted">Enter a project path on {connections.label}.</p>
            )}
          </div>
          <NewWorktreeOption session={session} cwd={cwd} />
          <Input type="hidden" name="model" value={selection} />
          <Input type="hidden" name="preset" value={preset} />
          <Input type="hidden" name="sandbox" value={backend} />
          <Input type="hidden" name="toolMode" value={toolMode} />
          <div className="creation-footer">
            <div className="creation-options">
              <PopoverControl
                label="New conversation model"
                align="start"
                trigger={
                  <Button variant="ghost" size="sm" aria-label="Choose model">
                    <span>
                      {session.domain
                        .availableModels()
                        .find((model) => modelKey(model.provider, model.model) === selection)
                        ?.label ?? selection.split("\u0000")[1]}
                    </span>
                    <ChevronDown size={12} aria-hidden="true" />
                  </Button>
                }
              >
                <label>
                  Model
                  <ModelSelect
                    label="New conversation model"
                    models={session.domain.availableModels()}
                    providers={session.settings?.providers ?? []}
                    value={selection}
                    onValueChange={(next) => {
                      setSelection(next);
                      setPreset("");
                    }}
                  />
                </label>
                {(presets.length > 0 || preset) && (
                  <label>
                    Preset
                    <Select
                      aria-label="New conversation preset"
                      value={preset}
                      onValueChange={(next) => setPreset(next)}
                    >
                      <SelectItem value="">Default</SelectItem>
                      {preset && !presets.some((entry) => entry.value === preset) && (
                        <SelectItem value={preset}>{preset} — unavailable</SelectItem>
                      )}
                      {presets.map((entry) => (
                        <SelectItem key={entry.value} value={entry.value}>
                          {entry.label ?? entry.value}
                        </SelectItem>
                      ))}
                    </Select>
                  </label>
                )}
              </PopoverControl>
              <PopoverControl
                label="New conversation execution"
                align="start"
                trigger={
                  <Button variant="ghost" size="sm" aria-label="Choose execution options">
                    {backend === "docker" ? "Docker" : backend === "native" ? "Native" : "None"}
                    <ChevronDown size={12} aria-hidden="true" />
                  </Button>
                }
              >
                <div className="form-grid">
                  <label>
                    Sandbox
                    <Select value={backend} onValueChange={(next) => setBackend(next)}>
                      <SandboxOptions selected={backend} />
                    </Select>
                  </label>
                  <label>
                    Tool interface
                    <Select value={toolMode} onValueChange={(next) => setToolMode(next)}>
                      <SelectItem value="hybrid">Hybrid</SelectItem>
                      <SelectItem value="code-only">Code only</SelectItem>
                    </Select>
                  </label>
                </div>
              </PopoverControl>
            </div>
            <Button
              type="submit"
              variant="accent"
              disabled={
                !available ||
                !backendAvailable ||
                navigation.state !== "idle" ||
                Boolean(session.disconnected)
              }
            >
              {navigation.state !== "idle" ? "Creating…" : "Create conversation"}
            </Button>
          </div>
        </Form>
        {!available && (
          <p role="status" className="muted">
            The selected model is unavailable in this server. Restart after connecting its provider,
            or select an available model.
          </p>
        )}
        {!backendAvailable && (
          <p role="status" className="muted">
            Native sandbox requires Linux. Select None or Docker to continue.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {backend === "docker" && (
          <p className="muted">Docker uses this folder’s devcontainer configuration.</p>
        )}
      </section>
    );
  }

  function ConversationControls({ view }: { view: ConversationSnapshot }) {
    const model = useFetcher<ActionResult>();
    const preset = useFetcher<ActionResult>();
    const sandbox = useFetcher<ActionResult>();
    const control = useFetcher<ActionResult>();
    const [pendingSandbox, setPendingSandbox] = useState<FormData>();
    const sandboxTrigger = useRef<HTMLButtonElement>(null);
    const id = view.conversation.id;
    const selected = view.conversation.config.model;
    const catalog = session.domain
      .availableModels()
      .find((entry) => entry.provider === selected.provider && entry.model === selected.model);
    const presets = catalog?.presets ?? [];
    const backend =
      (view.conversation.config.plugins?.["sandbox"] as { backend?: string } | undefined)
        ?.backend ?? "none";
    const running = view.state.turn.status === "running";
    const disabled = Boolean(session.disconnected);
    return (
      <>
        <div className="conversation-controls">
          <PopoverControl
            label="Model and preset"
            align="start"
            trigger={
              <Button
                variant="ghost"
                className="composer-chip"
                aria-label={`Model and preset: ${catalog?.label ?? selected.model}${selected.preset ? ` · ${selected.preset}` : ""}`}
              >
                <span>
                  {catalog?.label ?? selected.model}
                  {selected.preset
                    ? ` · ${presets.find((entry) => entry.value === selected.preset)?.label ?? selected.preset}`
                    : ""}
                </span>
                <ChevronDown size={12} aria-hidden="true" />
              </Button>
            }
          >
            <model.Form method="post" action="/actions" className="picker-form">
              <Input type="hidden" name="intent" value="model" />
              <Input type="hidden" name="conversationId" value={id} />
              <label>
                Model
                <ModelSelect
                  label="Conversation model"
                  models={session.domain.availableModels()}
                  providers={session.settings?.providers ?? []}
                  name="model"
                  value={modelKey(selected.provider, selected.model)}
                  disabled={disabled || model.state !== "idle"}
                  onValueChange={(next) => {
                    void model.submit(
                      { intent: "model", conversationId: id, model: next },
                      { method: "post", action: "/actions" },
                    );
                  }}
                />
              </label>
            </model.Form>
            {(presets.length > 0 || selected.preset) && (
              <preset.Form method="post" action="/actions" className="picker-form">
                <Input type="hidden" name="intent" value="preset" />
                <Input type="hidden" name="conversationId" value={id} />
                <label>
                  Preset
                  <Select
                    aria-label="Conversation preset"
                    name="preset"
                    value={selected.preset ?? ""}
                    disabled={disabled || preset.state !== "idle"}
                    onValueChange={(next) => {
                      void preset.submit(
                        { intent: "preset", conversationId: id, preset: next },
                        { method: "post", action: "/actions" },
                      );
                    }}
                  >
                    <SelectItem value="">Default</SelectItem>
                    {selected.preset &&
                      !presets.some((entry) => entry.value === selected.preset) && (
                        <SelectItem value={selected.preset}>
                          {selected.preset} — unavailable
                        </SelectItem>
                      )}
                    {presets.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label ?? entry.value}
                      </SelectItem>
                    ))}
                  </Select>
                </label>
              </preset.Form>
            )}
            <p className="muted">
              {catalog?.contextWindow
                ? `${catalog.contextWindow.toLocaleString()} context`
                : "Context capacity unknown"}
              {catalog?.reasoning?.supported ? " · Reasoning supported" : ""}
            </p>
            <ActionFeedback data={model.data} />
            <ActionFeedback data={preset.data} />
          </PopoverControl>
          <PopoverControl
            label="Sandbox controls"
            align="start"
            trigger={
              <Button
                ref={sandboxTrigger}
                variant="ghost"
                className="composer-chip"
                aria-label={`Sandbox: ${backend}`}
              >
                {backend === "docker" ? "Docker" : backend === "native" ? "Native" : "None"}
                <ChevronDown size={12} aria-hidden="true" />
              </Button>
            }
          >
            <sandbox.Form method="post" action="/actions" className="picker-form">
              <Input type="hidden" name="intent" value="sandbox" />
              <Input type="hidden" name="conversationId" value={id} />
              <label>
                Sandbox
                <Select
                  aria-label="Conversation sandbox"
                  name="sandbox"
                  value={backend}
                  disabled={running || disabled || sandbox.state !== "idle"}
                  onValueChange={(next) => {
                    const data = new FormData();
                    data.set("intent", "sandbox");
                    data.set("conversationId", id);
                    data.set("sandbox", next);
                    if (session.plugins.runningActivities(id) > 0) setPendingSandbox(data);
                    else void sandbox.submit(data, { method: "post", action: "/actions" });
                  }}
                >
                  <SandboxOptions selected={backend} />
                </Select>
              </label>
            </sandbox.Form>
            {running && <p className="muted">Stop the running turn before changing sandbox.</p>}
            {backend === "docker" && (
              <control.Form method="post" action="/actions" className="picker-form">
                <Input type="hidden" name="conversationId" value={id} />
                <div className="button-row">
                  <Button
                    type="submit"
                    name="intent"
                    value="rebuild"
                    disabled={disabled || control.state !== "idle"}
                  >
                    Rebuild
                  </Button>
                  <Button
                    type="submit"
                    variant="danger"
                    name="intent"
                    value="sandbox-stop"
                    disabled={disabled || control.state !== "idle"}
                  >
                    Stop container
                  </Button>
                </div>
                <p className="muted">Affects conversations sharing this container.</p>
              </control.Form>
            )}
            <ActionFeedback data={sandbox.data} />
            <ActionFeedback data={control.data} />
          </PopoverControl>
        </div>
        <Confirmation
          returnFocusRef={sandboxTrigger}
          open={Boolean(pendingSandbox)}
          onOpenChange={(open) => {
            if (!open) setPendingSandbox(undefined);
          }}
          title="Change sandbox?"
          description="Changing sandbox stops this conversation’s background work."
          confirmLabel="Change sandbox"
          onConfirm={() => {
            if (!pendingSandbox) throw new Error("Missing sandbox confirmation intent");
            void sandbox.submit(pendingSandbox, { method: "post", action: "/actions" });
          }}
        />
        <div className="control-feedback">
          <ActionFeedback data={model.data?.ok === false ? model.data : undefined} />
          <ActionFeedback data={preset.data?.ok === false ? preset.data : undefined} />
          <ActionFeedback data={sandbox.data?.ok === false ? sandbox.data : undefined} />
          <ActionFeedback data={control.data?.ok === false ? control.data : undefined} />
        </div>
      </>
    );
  }

  function toolIcon(name: string) {
    if (["write", "edit", "apply_patch"].includes(name)) return PenLine;
    if (name === "read" || name === "read_file") return BookOpen;
    if (name === "glob" || name === "grep" || name === "tool_search") return Search;
    if (name === "eval") return Code;
    if (name === "bash" || name === "powershell" || name === "exec") return Terminal;
    return Wrench;
  }

  function argumentPreview(cell: Extract<Cell, { kind: "tool" }>, boundary?: "begin" | "result") {
    return (
      boundary === "result"
        ? (cell.output ?? "")
        : typeof cell.args === "string"
          ? cell.args
          : JSON.stringify(cell.args)
    )
      .slice(0, 300)
      .replace(/\s+/g, " ");
  }

  const ToolCall = memo(function ToolCall({
    cell,
    boundary,
  }: {
    cell: Extract<Cell, { kind: "tool" }>;
    boundary?: "begin" | "result" | undefined;
  }) {
    const ToolIcon = toolIcon(cell.name);
    return (
      <TranscriptDisclosure
        className={`cell tool ${boundary ? `eval-${boundary}` : ""} ${cell.status === "error" && boundary !== "begin" ? "failed" : ""}`}
        data-testid="tool-call"
        unmountOnExit
        title={
          <>
            <ToolIcon size={13} aria-hidden="true" className="tool-icon muted" />
            {cell.status === "error" && boundary !== "begin" && (
              <span className="tool-failure">Failed</span>
            )}
            <strong>{boundary ? `eval ${boundary}` : cell.name}</strong>
            <span className="tool-argument-preview">{argumentPreview(cell, boundary)}</span>
            {cell.approvalProgress?.status === "reviewing" && (
              <span className="tool-status muted">awaiting approval</span>
            )}
          </>
        }
      >
        <ToolBody cell={cell} boundary={boundary} />
      </TranscriptDisclosure>
    );
  });

  function ToolBody({
    cell,
    boundary,
  }: {
    cell: Extract<Cell, { kind: "tool" }>;
    boundary?: "begin" | "result" | undefined;
  }) {
    const edit = editPresentation(cell);
    const showDetails = !edit || cell.status !== "ok";
    return (
      <>
        {cell.parentCallId && <p className="muted">Invoked by {cell.parentCallId}</p>}
        {edit &&
          edit.files.map((file, index) => (
            <section className="edit-diff" key={`${file.path}:${index}`}>
              <strong>{file.path}</strong>
              <pre>
                {file.lines.map((line, lineIndex) => (
                  <span key={lineIndex} className={`diff-${line.kind}`}>
                    {line.text}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </section>
          ))}
        {showDetails && boundary !== "result" && (
          <>
            <h3>Arguments</h3>
            <pre>
              {typeof cell.args === "string" ? cell.args : JSON.stringify(cell.args, null, 2)}
            </pre>
          </>
        )}
        {showDetails && boundary !== "begin" && (
          <>
            <h3>Output</h3>
            <pre data-testid="tool-output">{cell.output ?? "Waiting for output…"}</pre>
            {cell.images && <ImagePreviews images={cell.images} />}
          </>
        )}
        {cell.approval && (
          <p className="muted">
            {cell.approval.decision === "allow" ? "Allowed" : "Denied"} by {cell.approval.responder}
          </p>
        )}
      </>
    );
  }

  function ActiveDuration({
    startedAt,
    label,
  }: {
    startedAt: number;
    label: "Thinking" | "Working";
  }) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }, []);
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    return (
      <>
        {label} for {seconds} s
      </>
    );
  }

  function hasWorkContent({ cell }: TranscriptStep) {
    if (cell.kind === "worked") return false;
    if (cell.kind === "tool") return true;
    if (cell.kind === "shell")
      return cell.streaming || cell.command.trim() !== "" || cell.text.trim() !== "";
    if (cell.kind === "plugin_message" && cell.images?.length) return true;
    return cell.text.trim() !== "";
  }

  function WorkItems({
    steps,
    label,
    onIntent,
  }: {
    steps: TranscriptStep[];
    label: string;
    onIntent?: (key: string, retained: boolean) => void;
  }) {
    const visible = steps.filter(hasWorkContent);
    const retain = (
      owner: HTMLElement,
      target: EventTarget,
      disclosure = false,
      focus: EventTarget | null = document.activeElement,
    ) => {
      if (!(target instanceof HTMLElement)) return;
      let entry = target;
      while (entry.parentElement && entry.parentElement !== owner) entry = entry.parentElement;
      if (entry.parentElement !== owner || (disclosure && entry !== target)) return;
      const key = visible[Array.prototype.indexOf.call(owner.children, entry)]?.key;
      if (key)
        onIntent?.(
          key,
          (entry instanceof HTMLDetailsElement && entry.open) ||
            (focus instanceof Node && entry.contains(focus)),
        );
    };
    return (
      <div
        className="work-items"
        aria-label={label}
        ref={(owner) => {
          if (!owner) return;
          // Native capture observes the step's own toggle, not nested details.
          const toggle = (event: Event) => {
            if (event.target) retain(owner, event.target, true);
          };
          owner.addEventListener("toggle", toggle, true);
          return () => owner.removeEventListener("toggle", toggle, true);
        }}
        onFocusCapture={(event) => retain(event.currentTarget, event.target)}
        onBlurCapture={(event) =>
          retain(event.currentTarget, event.target, false, event.relatedTarget)
        }
      >
        {visible.map((step) =>
          step.cell.kind === "tool" ? (
            <ToolCall
              key={step.key}
              cell={step.cell}
              boundary={"boundary" in step ? step.boundary : undefined}
            />
          ) : step.cell.kind === "reasoning" ? (
            <Reasoning key={step.key} cell={step.cell} />
          ) : (
            <TranscriptCell key={step.key} cell={step.cell} />
          ),
        )}
      </div>
    );
  }

  const StepGroup = memo(function StepGroup({
    row,
    latest,
  }: {
    row: Extract<TranscriptRow, { kind: "steps" }>;
    latest: boolean;
  }) {
    const scrollShadows = useScrollShadows();
    const [open, setOpen] = useState(false);
    const [asLatest, setAsLatest] = useState(false);
    const [tailStartKey, setTailStartKey] = useState<string | undefined>();
    const [retained, setRetained] = useState<Set<string>>(() => new Set());
    const retain = useCallback((key: string, keep: boolean) => {
      setRetained((previous) => {
        if (previous.has(key) === keep) return previous;
        const next = new Set(previous);
        if (keep) next.add(key);
        else next.delete(key);
        return next;
      });
    }, []);
    useEffect(() => {
      const keys = new Set(row.steps.map((step) => step.key));
      setRetained((previous) =>
        [...previous].every((key) => keys.has(key))
          ? previous
          : new Set([...previous].filter((key) => keys.has(key))),
      );
    }, [row.steps]);
    // Outer expansion is explicit; preview exceptions retain only intentional
    // reading. `asLatest` remembers whether the group was opened as latest so
    // losing `latest` mid-expansion keeps the
    // same containers instead of remounting. Keep that shape through the exit
    // animation; the next expansion captures whether the group is latest again.
    const calls = row.steps.filter(
      (step) => step.cell.kind === "tool" && !("boundary" in step && step.boundary === "result"),
    ).length;
    const working =
      row.observedTiming !== undefined && row.observedTiming.completedAt === undefined;
    // Completed tool-only history has comparable server timestamps. Historical
    // reasoning starts do not; live groups use desktop-observed timing instead.
    const historicalTools = row.steps.every(({ cell }) => cell.kind === "tool");
    const start =
      row.observedTiming?.startedAt ??
      (historicalTools
        ? row.steps.reduce(
            (time, { cell }) => (cell.kind === "tool" ? Math.min(time, cell.startedAt) : time),
            Infinity,
          )
        : undefined);
    const end =
      row.observedTiming?.completedAt ??
      (historicalTools
        ? row.steps.reduce<number | undefined>(
            (time, { cell }) =>
              time === undefined || cell.kind !== "tool" || cell.completedAt === undefined
                ? undefined
                : Math.max(time, cell.completedAt),
            0,
          )
        : undefined);
    const terminal = row.steps.findLast(({ cell }) => cell.kind === "worked")?.cell;
    const duration =
      terminal?.kind === "worked"
        ? Math.round(terminal.duration / 1000)
        : start === undefined || end === undefined
          ? undefined
          : Math.round((end - start) / 1000);
    const label = working ? (
      row.observedTiming ? (
        <ActiveDuration startedAt={row.observedTiming.startedAt} label="Working" />
      ) : (
        "Working"
      )
    ) : duration === undefined ? (
      "Worked"
    ) : (
      `Worked for ${duration} s`
    );
    const title = (
      <span>
        {label}
        {calls ? ` · ${calls} tool ${calls === 1 ? "call" : "calls"}` : ""}
      </span>
    );
    const recent = row.steps.filter(hasWorkContent).slice(-5);
    const recentStart = recent[0] ? row.steps.indexOf(recent[0]) : row.steps.length;
    // Pin the head/tail boundary while an opened latest group grows, so
    // streaming steps cannot migrate rows between parents and reset an open
    // tool or reasoning disclosure. Historical groups never stream; a single
    // list needs no pinning.
    const capturedStart =
      tailStartKey === undefined
        ? row.steps.length
        : row.steps.findIndex((step) => step.key === tailStartKey);
    // History or canonical regrouping can remove the captured entry. Reconcile
    // that presentation boundary to the current tail when it no longer exists.
    const tailStart = open && asLatest && capturedStart >= 0 ? capturedStart : recentStart;
    const tail = row.steps.filter(
      (step, index) =>
        retained.has(step.key) || (index >= tailStart && (latest || (open && asLatest))),
    );
    const tailKeys = new Set(tail.map((step) => step.key));
    const head = row.steps.filter((step) => !tailKeys.has(step.key));
    const hasHead = head.some(hasWorkContent);
    // The ordinary preview belongs to the latest group; intentional exceptions
    // keep this same owner even after supersession. It never animates. Only the
    // head disclosure animates, including on collapse: its retained exit body
    // must not acquire a second copy of the preview rows.
    const split = latest || asLatest || retained.size > 0;
    const showTail =
      (open && asLatest) || (latest && !open) || tail.some((step) => retained.has(step.key));
    return (
      <div className="cell work-scroll-frame">
        <div className="tool-group-container scroll-shadows" ref={scrollShadows}>
          {hasHead || open || (!latest && recent.length > 0) ? (
            <Disclosure
              className="tool-group"
              unmountOnExit
              name="conversation-work"
              open={open}
              onToggle={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.currentTarget.open) {
                  if (latest) setTailStartKey(tail[0]?.key);
                  setAsLatest(latest);
                } else {
                  setTailStartKey(undefined);
                }
                setOpen(event.currentTarget.open);
              }}
              title={title}
            >
              {split ? (
                hasHead && <WorkItems steps={head} label="Work details" />
              ) : (
                <WorkItems steps={row.steps} label="Work details" />
              )}
            </Disclosure>
          ) : (
            <div className="work-group-title">{title}</div>
          )}
          {showTail && (
            <div className="collapse-grid work-tail" data-state="open">
              <div className="collapse-body">
                <WorkItems steps={tail} label="Recent work" onIntent={retain} />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  });

  function ReasoningSummary({ label, text }: { label: ReactNode; text: string }) {
    const position = useRef({ text: "", start: 0, width: 0 });
    const observe = useCallback(
      (element: HTMLSpanElement | null) => {
        if (!element || text.trim() === "") return;
        const labelElement = element.querySelector<HTMLElement>(".reasoning-label")!;
        // React leaves this span empty; the ref owns its measured text.
        const excerpt = element.querySelector<HTMLElement>(".reasoning-excerpt > span")!;
        const content = text.replace(/\s+/gu, " ");
        const probe = document.createElement("span");
        probe.className = "reasoning-measure";
        probe.setAttribute("aria-hidden", "true");
        probe.inert = true;
        const probeLabel = labelElement.cloneNode(true) as HTMLElement;
        probeLabel.removeAttribute("class");
        probeLabel.style.display = "inline-block";
        probeLabel.style.whiteSpace = "nowrap";
        const probeText = document.createTextNode("");
        probe.append(probeLabel, probeText);
        document.body.append(probe);
        let measuredWidth = -1;
        let measuredLabelWidth = -1;
        const measure = () => {
          const style = getComputedStyle(element);
          // clientWidth rounding can otherwise fit a spurious third line.
          const width = parseFloat(style.width);
          const labelWidth = labelElement.getBoundingClientRect().width;
          if (!width || (width === measuredWidth && labelWidth === measuredLabelWidth)) return;
          measuredWidth = width;
          measuredLabelWidth = labelWidth;
          Object.assign(probe.style, {
            width: `${width}px`,
            font: style.font,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
          });
          probeLabel.textContent = labelElement.textContent;
          const maxHeight = Math.ceil(parseFloat(style.lineHeight) * 2);
          const previous = position.current;
          let start =
            text.startsWith(previous.text) && width === previous.width ? previous.start : 0;
          start = Math.max(start, content.length - 2000);
          probeText.data = ` · ${content.slice(start)}`;
          // Keep the first visible line fixed while the second fills. Only a
          // third line advances the window, always to a browser-wrapped line.
          while (probe.clientHeight > maxHeight) {
            const range = document.createRange();
            range.setStart(probeText, 3);
            range.setEnd(probeText, 4);
            const firstTop = range.getBoundingClientRect().top;
            range.setStart(probeText, probeText.length - 1);
            range.setEnd(probeText, probeText.length);
            const lastTop = range.getBoundingClientRect().top;
            // Text can start below the label (for example, a long word).
            // Compare glyph positions, and always move past its first line.
            const lineHeight = parseFloat(style.lineHeight);
            const lineTop = Math.max(firstTop + lineHeight, lastTop - lineHeight) - lineHeight / 2;
            let low = 3;
            let high = probeText.length;
            while (low < high) {
              const middle = Math.floor((low + high) / 2);
              range.setStart(probeText, middle);
              range.setEnd(probeText, middle + 1);
              if (range.getBoundingClientRect().top < lineTop) low = middle + 1;
              else high = middle;
            }
            start += low - 3;
            probeText.data = ` · ${content.slice(start)}`;
          }
          position.current = { text, start, width };
          excerpt.textContent = content.slice(start);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        observer.observe(labelElement);
        return () => {
          observer.disconnect();
          probe.remove();
        };
      },
      [text],
    );
    return (
      <span className="reasoning-summary" ref={observe}>
        <span className="reasoning-label">{label}</span>
        {text.trim() !== "" && (
          <span className="preview-reasoning">
            <span className="reasoning-excerpt">
              <span />
            </span>
          </span>
        )}
      </span>
    );
  }

  const Reasoning = memo(function Reasoning({
    cell,
  }: {
    cell: Extract<Cell, { kind: "reasoning" }>;
  }) {
    const duration =
      cell.observedTiming && cell.completedAt !== undefined
        ? Math.round((cell.completedAt - cell.startedAt) / 1000)
        : undefined;
    const label = cell.streaming ? (
      cell.observedTiming ? (
        <ActiveDuration startedAt={cell.startedAt} label="Thinking" />
      ) : (
        "Thinking"
      )
    ) : duration === undefined ? (
      "Thought"
    ) : (
      `Thought for ${duration} s`
    );
    return (
      <TranscriptDisclosure
        className="cell reasoning"
        unmountOnExit
        title={<ReasoningSummary label={label} text={cell.text} />}
      >
        <Markdown remarkPlugins={[remarkGfm]} components={{ a: TranscriptLink }}>
          {cell.text}
        </Markdown>
      </TranscriptDisclosure>
    );
  });

  const TranscriptCell = memo(function TranscriptCell({
    cell,
    intermediate = false,
    readOnly = false,
  }: {
    cell: Cell;
    intermediate?: boolean;
    readOnly?: boolean;
  }) {
    if (cell.kind === "tool") return <ToolCall cell={cell} />;
    if (cell.kind === "reasoning") return <Reasoning cell={cell} />;
    if (cell.kind === "plugin_message")
      return (
        <TranscriptDisclosure title={<>Message from {cell.pluginId}</>}>
          <pre>{cell.text}</pre>
          {cell.images && <ImagePreviews images={cell.images} />}
        </TranscriptDisclosure>
      );
    if (cell.kind === "compaction" || cell.kind === "context")
      return (
        <TranscriptDisclosure
          className="cell"
          title={<>{cell.kind === "compaction" ? "Compacted context" : "Context"}</>}
        >
          <pre>{cell.text}</pre>
        </TranscriptDisclosure>
      );
    if (cell.kind === "worked")
      return <div className="cell muted">Worked for {Math.round(cell.duration / 1000)}s</div>;
    if (cell.kind === "user")
      return (
        <article className="cell user">
          <div className="user-text">
            <span>{cell.text}</span>
            {cell.images && <ImagePreviews images={cell.images} />}
          </div>
          {!readOnly && <ForkBefore itemId={cell.id} />}
        </article>
      );
    if (cell.kind === "assistant")
      return (
        <article
          className={`cell assistant ${intermediate ? "assistant-intermediate" : ""}`}
          data-testid="assistant-message"
          aria-busy={cell.streaming}
        >
          <div className="message-content">
            <Markdown remarkPlugins={[remarkGfm]} components={{ a: TranscriptLink }}>
              {cell.text}
            </Markdown>
          </div>
          {!cell.streaming && (
            <div className="message-actions">
              <CopyMessage text={cell.text} />
              <FeedbackControls session={session} itemId={cell.id} />
            </div>
          )}
        </article>
      );
    if (cell.kind === "error")
      return (
        <div className="cell error" role="alert">
          {cell.text}
        </div>
      );
    if (cell.kind === "shell")
      return (
        <TranscriptDisclosure className="cell" title={<>{cell.command}</>}>
          <pre>{cell.text}</pre>
        </TranscriptDisclosure>
      );
    return <div className="cell muted">{cell.text}</div>;
  });
  function TranscriptLink({
    href,
    children,
  }: {
    href?: string | undefined;
    children?: React.ReactNode;
  }) {
    const [error, setError] = useState<string>();
    const browserUrl = href && /^https?:\/\//u.test(href) ? href : undefined;
    return (
      <>
        <a
          className="content-link"
          aria-disabled={browserUrl ? undefined : true}
          href={browserUrl}
          onClick={(event) => {
            event.preventDefault();
            if (browserUrl)
              void openUrl(browserUrl).catch((cause: unknown) => setError(errorMessage(cause)));
          }}
        >
          {children}
        </a>
        {error && (
          <span role="alert" className="error">
            {error}
          </span>
        )}
      </>
    );
  }
  function Activity({
    view,
    id,
    title,
    owner,
  }: {
    view: ConversationSnapshot;
    id: string;
    title: string;
    owner: string;
  }) {
    const [output, setOutput] = useState("");
    const [error, setError] = useState<string>();
    const disconnected = Boolean(session.disconnected);
    useEffect(() => {
      if (disconnected) return;
      let disposed = false;
      let pending = false;
      const refresh = async () => {
        if (pending) return;
        pending = true;
        try {
          const content = await session.plugins.activities(view.conversation.id).peek(id);
          if (!disposed) {
            setOutput(textOf(content));
            setError(undefined);
          }
        } catch (cause) {
          if (!disposed) setError(errorMessage(cause));
        } finally {
          pending = false;
        }
      };
      void refresh();
      const timer = setInterval(() => void refresh(), 1000);
      return () => {
        disposed = true;
        clearInterval(timer);
      };
    }, [view.conversation.id, id, disconnected]);
    const kill = useFetcher<ActionResult>();
    return (
      <Disclosure
        className="activity"
        name="conversation-activity"
        title={
          <>
            <span className="activity-title">{title}</span>
            <ActivityOwner session={session} id={owner} />
            <span className="activity-preview muted">
              {output.replace(/\s+/g, " ").slice(-300)}
            </span>
            <span className="muted">running</span>
            <IconButton
              icon={Square}
              label="Stop activity"
              className="activity-stop"
              size="sm"
              disabled={kill.state !== "idle" || disconnected}
              onClick={() =>
                void kill.submit(
                  { intent: "activity-kill", conversationId: view.conversation.id, activityId: id },
                  { method: "post", action: "/actions" },
                )
              }
            />
          </>
        }
      >
        <pre>{output || "Waiting for output…"}</pre>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </Disclosure>
    );
  }
  const Composer = memo(
    function Composer({ view }: { view: ConversationSnapshot }) {
      useSyncExternalStore(session.subscribeConnection, session.connectionSnapshot);
      const send = useFetcher<ActionResult>();
      const stop = useFetcher<ActionResult>();
      const id = view.conversation.id;
      const [text, setText] = useState(
        () => localStorage.getItem(session.storageKey(`draft:${id}`)) ?? "",
      );
      const {
        images,
        reading: readingImages,
        error: attachmentError,
      } = useSyncExternalStore(subscribeImageDrafts, () => getImageDraft(id));
      const setAttachmentError = (error: string) =>
        updateImageDraft(id, (draft) => ({ ...draft, error }));
      const updateImages = (update: (images: ImageContent[]) => ImageContent[]) => {
        updateImageDraft(id, (draft) => ({ ...draft, images: update(draft.images) }));
      };
      const readAndAddImages = async (read: () => Promise<ImageContent[]>) => {
        updateImageDraft(id, (draft) => ({ ...draft, reading: draft.reading + 1 }));
        try {
          const added = await read();
          updateImageDraft(id, (draft) => {
            const images = [...draft.images, ...added];
            imageContentsSchema.parse(images);
            return { ...draft, images, error: "" };
          });
        } catch (error) {
          setAttachmentError(errorMessage(error));
        } finally {
          updateImageDraft(id, (draft) => ({ ...draft, reading: draft.reading - 1 }));
        }
      };
      const addImages = (files: File[]) => readAndAddImages(() => readImageFiles(files));
      const onNativeDrop = useEffectEvent((paths: string[]) => {
        void readAndAddImages(() => readImagePaths(paths));
      });
      useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void getCurrentWebview()
          .onDragDropEvent((event) => {
            if (!disposed && event.payload.type === "drop") onNativeDrop(event.payload.paths);
          })
          .then((cleanup) => {
            if (disposed) cleanup();
            else unlisten = cleanup;
          })
          .catch((error) => {
            if (!disposed)
              updateImageDraft(id, (draft) => ({ ...draft, error: errorMessage(error) }));
          });
        return () => {
          disposed = true;
          unlisten?.();
        };
      }, [id]);
      const imagePicker = useRef<HTMLInputElement>(null);
      const textarea = useRef<HTMLTextAreaElement>(null);
      const [, setComposerWidth] = useState(0);
      useEffect(() => {
        // Autosize handles window resize, but sidebars can change only this width.
        const observer = new ResizeObserver(([entry]) => {
          if (entry) setComposerWidth(entry.contentRect.width);
        });
        observer.observe(textarea.current!);
        return () => observer.disconnect();
      }, []);
      const handled = useRef<ActionResult | undefined>(undefined);
      const submitting = useRef(false);
      const running = view.state.turn.status === "running";
      const preferences = useComposerPreferences();
      const defaultDelivery = running ? "steer" : "send";
      const busy = send.state !== "idle" || stop.state !== "idle";
      const disabled =
        (!text.trim() && images.length === 0) ||
        busy ||
        readingImages > 0 ||
        Boolean(session.disconnected);
      const stopping = running && !text.trim() && images.length === 0;
      const hasPendingInput = view.state.pendingInput.length > 0;
      const backgroundInput = view.state.pendingInput.filter(
        (input) => input.source.kind === "plugin",
      );
      useEffect(() => {
        if (send.state === "idle" && send.data?.ok && handled.current !== send.data) {
          handled.current = send.data;
          setText(localStorage.getItem(session.storageKey(`draft:${id}`)) ?? "");
          textarea.current?.focus();
        }
      }, [send.state, send.data, id]);
      const submit = (delivery: "send" | "queue" | "steer") => {
        if (disabled || submitting.current) return;
        const data = new FormData();
        data.set("intent", "send");
        data.set("conversationId", id);
        data.set("text", text);
        data.set("delivery", delivery);
        data.set("images", JSON.stringify(images));
        // React can batch repeated input events before the fetcher renders busy.
        submitting.current = true;
        void send.submit(data, { method: "post", action: "/actions" }).finally(() => {
          submitting.current = false;
        });
      };
      const interrupt = () => {
        if (!running || stop.state !== "idle" || session.disconnected) return;
        const data = new FormData();
        data.set("intent", "stop");
        data.set("conversationId", id);
        void stop.submit(data, { method: "post", action: "/actions" });
      };
      return (
        <div className="composer-wrap">
          <div
            className="composer"
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              void addImages(Array.from(event.dataTransfer.files));
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length > 0) {
                event.preventDefault();
                void addImages(files);
              } else if (
                typeof navigator.clipboard?.read === "function" &&
                needsClipboardRead(
                  event.clipboardData.types,
                  event.clipboardData.getData("text/uri-list"),
                )
              ) {
                event.preventDefault();
                void readAndAddImages(readClipboardImages);
              }
            }}
          >
            {images.length > 0 && (
              <ImagePreviews
                images={images}
                onRemove={(index) =>
                  updateImages((current) => current.filter((_, position) => position !== index))
                }
              />
            )}
            {attachmentError && <p role="alert">{attachmentError}</p>}
            {view.state.pendingInput.length > 0 && (
              <div className="pending-input">
                {view.state.pendingInput
                  .filter((input) => input.source.kind === "user")
                  .map((input, index) => (
                    <div key={index}>
                      {input.intent}: {input.text}
                    </div>
                  ))}
                {backgroundInput.length > 0 && (
                  <Disclosure
                    title={
                      <>
                        {backgroundInput.length} background{" "}
                        {backgroundInput.length === 1 ? "message" : "messages"} queued
                      </>
                    }
                  >
                    {backgroundInput.map((input, index) => (
                      <div key={index}>
                        {input.source.kind === "plugin" && (
                          <strong>{input.source.pluginId}: </strong>
                        )}
                        {input.text}
                      </div>
                    ))}
                  </Disclosure>
                )}
              </div>
            )}
            <send.Form
              method="post"
              action="/actions"
              onSubmit={(event) => {
                event.preventDefault();
                submit(defaultDelivery);
              }}
            >
              <Input type="hidden" name="intent" value="send" />
              <Input type="hidden" name="conversationId" value={id} />
              <Input type="hidden" name="delivery" value={defaultDelivery} />
              <TextareaAutosize
                className="input"
                ref={textarea}
                name="text"
                aria-label="Message"
                placeholder="Ask a follow-up…"
                value={text}
                rows={2}
                onChange={(event) => {
                  setText(event.target.value);
                  localStorage.setItem(session.storageKey(`draft:${id}`), event.target.value);
                }}
                onKeyDown={(event) => {
                  const action = composerKey(
                    {
                      ...event,
                      isComposing:
                        event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229,
                    },
                    preferences,
                    running,
                  );
                  if (!action || action === "newline") return;
                  event.preventDefault();
                  if (action === "interrupt") interrupt();
                  else submit(action);
                }}
              />
            </send.Form>
            <div className="composer-actions">
              <input
                ref={imagePicker}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  void addImages(files);
                }}
              />
              <IconButton
                label="Attach images"
                icon={Paperclip}
                onClick={() => imagePicker.current?.click()}
              />
              <ConversationControls view={view} />
              <PopoverControl
                label="Composer settings"
                trigger={<IconButton label="Composer settings" icon={Settings2} />}
              >
                <h3>Composer settings</h3>
                <ComposerSettings />
              </PopoverControl>
              <div className="composer-send">
                <ContextUsage state={view.state} models={session.domain.availableModels()} />
                <Button
                  variant="accent"
                  size="sm"
                  className="composer-primary"
                  title={
                    stopping
                      ? hasPendingInput
                        ? "Interrupt current turn; pending messages run next (Esc)"
                        : "Stop current turn (Esc)"
                      : undefined
                  }
                  disabled={
                    stopping ? stop.state !== "idle" || Boolean(session.disconnected) : disabled
                  }
                  onClick={() => (stopping ? interrupt() : submit(defaultDelivery))}
                >
                  {stopping || stop.state !== "idle" ? (
                    <Square size={12} aria-hidden="true" />
                  ) : (
                    <Send size={14} aria-hidden="true" />
                  )}
                  {stop.state !== "idle"
                    ? hasPendingInput
                      ? "Interrupting…"
                      : "Stopping…"
                    : send.state !== "idle" && !stopping
                      ? "Sending…"
                      : stopping
                        ? hasPendingInput
                          ? "Interrupt"
                          : "Stop"
                        : running
                          ? "Steer"
                          : "Send"}
                </Button>
              </div>
            </div>
            <ActionFeedback data={send.data} />
            <ActionFeedback data={stop.data} />
          </div>
          {preferences.showStats && (
            <div className="composer-footer">
              <LastTurnStats state={view.state} />
            </div>
          )}
        </div>
      );
    },
    (previous, next) =>
      previous.view.conversation === next.view.conversation &&
      composerFields.every((field) =>
        Object.is(previous.view.state[field], next.view.state[field]),
      ),
  );

  const EarlierHistory = memo(function EarlierHistory({
    conversationId,
    cursor,
  }: {
    conversationId: string;
    cursor: string | null;
  }) {
    useSyncExternalStore(session.subscribeConnection, session.connectionSnapshot);
    const older = useFetcher<ActionResult>();
    const marker = useRef<HTMLDivElement>(null);
    const pending = useRef(false);
    const disconnected = Boolean(session.disconnected);
    const failed = older.data?.ok === false;
    const hasEarlier = Boolean(cursor);
    useEffect(() => {
      if (older.state === "idle") pending.current = false;
    }, [older.state]);
    const load = () => {
      if (pending.current || older.state !== "idle" || !cursor || disconnected) return;
      pending.current = true;
      void older.submit(
        { intent: "older", conversationId: conversationId },
        { method: "post", action: "/actions" },
      );
    };
    const loadAutomatically = useEffectEvent(() => {
      if (!failed) load();
    });
    useEffect(() => {
      const element = marker.current;
      if (!element || !hasEarlier || disconnected) return;
      const root = element.closest(".conversation-scroll");
      if (!root) throw new Error("History marker requires a conversation scroller");
      let visible = false;
      const observer = new IntersectionObserver(
        (entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          if (visible) loadAutomatically();
        },
        { root, rootMargin: "200px 0px" },
      );
      // Collapsed steps may add no height. A new upward scroll can request the
      // next page, but completing a request must not drain history on its own.
      const onWheel = (event: Event) => {
        if (visible && (event as WheelEvent).deltaY < 0) loadAutomatically();
      };
      observer.observe(element);
      root.addEventListener("wheel", onWheel, { passive: true });
      return () => {
        observer.disconnect();
        root.removeEventListener("wheel", onWheel);
      };
    }, [hasEarlier, disconnected]);
    if (!cursor) return <span className="muted">Start of conversation</span>;
    return (
      <div ref={marker} className="earlier-history">
        {older.state !== "idle" ? (
          <span className="muted" role="status">
            Loading earlier messages…
          </span>
        ) : (
          <button className="history-continuation muted" onClick={load} disabled={disconnected}>
            Earlier messages
          </button>
        )}
        {failed && (
          <>
            <ActionFeedback data={older.data} />
            <Button size="sm" onClick={load} disabled={older.state !== "idle" || disconnected}>
              Retry loading earlier messages
            </Button>
          </>
        )}
      </div>
    );
  });

  function CopyMessage({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string>();
    useEffect(() => {
      if (!copied) return;
      const timer = setTimeout(() => setCopied(false), 750);
      return () => clearTimeout(timer);
    }, [copied]);
    return (
      <>
        <IconButton
          icon={copied ? Check : Copy}
          label={copied ? "Copied" : "Copy message"}
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => {
                setCopied(true);
                setError(undefined);
              },
              (cause: unknown) => setError(`Copy failed: ${errorMessage(cause)}`),
            );
          }}
        />
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </>
    );
  }

  function ForkBefore({ itemId }: { itemId: string }) {
    useSyncExternalStore(session.subscribeConnection, session.connectionSnapshot);
    const view = useLoaderData<ConversationView>();
    const fork = useFetcher<ActionResult>();
    return (
      <div className="message-actions">
        <fork.Form method="post" action="/actions">
          <Input type="hidden" name="intent" value="fork" />
          <Input type="hidden" name="conversationId" value={view.conversation.id} />
          <Input type="hidden" name="itemId" value={itemId} />
          <IconButton
            icon={GitFork}
            label="Fork before this message"
            type="submit"
            size="sm"
            disabled={
              fork.state !== "idle" || !session.client.peer.ready || Boolean(session.disconnected)
            }
          />
        </fork.Form>
        <ActionFeedback data={fork.data} />
      </div>
    );
  }

  const ConversationHeading = memo(function ConversationHeading({
    conversation,
    label,
    running,
  }: {
    conversation: Conversation;
    label: string;
    running: boolean;
  }) {
    useSyncExternalStore(session.subscribeConnection, session.connectionSnapshot);
    const rename = useFetcher<ActionResult>();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const pencil = useRef<HTMLButtonElement>(null);
    const busy = rename.state !== "idle";
    const close = () => {
      setEditing(false);
      requestAnimationFrame(() => pencil.current?.focus());
    };
    useEffect(() => {
      if (rename.state === "idle" && rename.data?.ok) {
        setEditing(false);
        requestAnimationFrame(() => pencil.current?.focus());
      }
    }, [rename.state, rename.data]);
    return (
      <div className="conversation-heading">
        <div className="conversation-title-display" hidden={editing}>
          <h1>{label}</h1>
          <IconButton
            ref={pencil}
            icon={PenLine}
            label="Rename conversation"
            className="conversation-rename"
            size="sm"
            disabled={!session.client.peer.ready || Boolean(session.disconnected)}
            onClick={() => {
              setDraft(label);
              setEditing(true);
            }}
          />
          <WorktreeControl session={session} conversation={conversation} running={running} />
        </div>
        {editing && (
          <>
            <rename.Form method="post" action="/actions" className="conversation-title-form">
              <Input type="hidden" name="intent" value="rename" />
              <Input type="hidden" name="conversationId" value={conversation.id} />
              <Input
                autoFocus
                aria-label="Conversation title"
                name="title"
                value={draft}
                maxLength={200}
                required
                disabled={busy}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !busy) {
                    event.preventDefault();
                    close();
                  }
                }}
              />
              <IconButton
                icon={Check}
                label="Save title"
                type="submit"
                size="sm"
                disabled={busy || !draft.trim()}
              />
              <IconButton
                icon={X}
                label="Cancel rename"
                size="sm"
                disabled={busy}
                onClick={close}
              />
            </rename.Form>
            <ActionFeedback data={rename.data?.ok === false ? rename.data : undefined} />
          </>
        )}
      </div>
    );
  });

  function ConversationPage() {
    const attachment = useLoaderData<ConversationView>();
    const view = useSyncExternalStore(attachment.subscribe, attachment.snapshot);
    useSyncExternalStore(session.subscribeConnection, session.connectionSnapshot);
    useEffect(() => {
      session.setActiveConversation(view.conversation.id);
      return () => session.setActiveConversation(null);
    }, [view.conversation.id]);
    return (
      <RightSidebarLayout
        key={view.subagent?.ancestors[0]?.id ?? view.conversation.id}
        session={session}
        view={view}
        label={conversationLabel(view.conversation, view)}
        renderConversation={(child) => <ConversationContent attachment={child} side />}
      >
        {(toggle) => <ConversationContent attachment={attachment} toggle={toggle} />}
      </RightSidebarLayout>
    );
  }

  function ConversationContent({
    attachment,
    side = false,
    toggle,
  }: {
    attachment: ConversationView;
    side?: boolean;
    toggle?: ReactNode;
  }) {
    const view = useSyncExternalStore(attachment.subscribe, attachment.snapshot);
    useSyncExternalStore(session.subscribeConnection, session.connectionSnapshot);
    const questionRequests = [...view.questions.values()].map((request) => (
      <QuestionRequestForm key={request.id} request={request} />
    ));
    const latestWork = useMemo(
      () => view.transcript.rows.findLast((row) => row.kind === "steps")?.key,
      [view.transcript.rows],
    );
    const lastByTurn = useMemo(() => {
      const last = new Map<string, Cell>();
      for (const cell of view.state.cells)
        if ("turnId" in cell && cell.turnId) last.set(cell.turnId, cell);
      return last;
    }, [view.state.cells]);
    const renderRow = useCallback(
      (row: TranscriptRow) =>
        row.kind === "steps" ? (
          <StepGroup row={row} latest={row.key === latestWork} />
        ) : (
          <TranscriptCell
            cell={row.cell}
            readOnly={side || Boolean(view.subagent)}
            intermediate={
              row.cell.kind === "assistant" &&
              (lastByTurn.get(row.cell.turnId) !== row.cell ||
                (view.state.turn.status === "running" && view.state.turn.id === row.cell.turnId))
            }
          />
        ),
      [latestWork, lastByTurn, view.state.turn, view.subagent, side],
    );
    return (
      <ConversationCanvas
        key={view.conversation.id}
        rows={view.transcript.rows}
        running={view.state.turn.status === "running"}
        pendingWork={
          view.state.turn.status === "running" &&
          (view.state.modelRetry ? (
            <RetryStatusLine retry={view.state.modelRetry} />
          ) : (
            !view.transcript.rows.some(
              (row) =>
                row.kind === "steps" &&
                row.observedTiming?.completedAt === undefined &&
                row.observedTiming !== undefined,
            ) &&
            !view.state.cells.some(
              (cell) =>
                cell.kind !== "user" && "turnId" in cell && cell.turnId === view.state.turn.id,
            ) && (
              <div className="cell" role="status">
                <div className="work-group-title">Working</div>
              </div>
            )
          ))
        }
        header={
          side ? null : (
            <header className="conversation-header">
              {view.subagent ? (
                <SubagentHeading subagent={view.subagent} />
              ) : (
                <ConversationHeading
                  key={view.conversation.id}
                  conversation={view.conversation}
                  label={conversationLabel(view.conversation, view)}
                  running={view.state.turn.status === "running"}
                />
              )}
              {toggle}
            </header>
          )
        }
        history={
          <EarlierHistory
            key={view.conversation.id}
            conversationId={view.conversation.id}
            cursor={view.cursor}
          />
        }
        renderRow={renderRow}
        dock={
          side || view.subagent ? (
            <div className="conversation-support approvals">{questionRequests}</div>
          ) : (
            <>
              <div className="conversation-support">
                {view.state.sandbox?.message && (
                  <p
                    role="status"
                    className={
                      view.state.sandbox.phase === "error"
                        ? "error sandbox-status"
                        : "sandbox-status muted"
                    }
                  >
                    {view.state.sandbox.message}
                  </p>
                )}
                {view.state.activities.some((activity) => activity.status === undefined) && (
                  <Disclosure
                    className="activities"
                    title={
                      <>
                        Activities (
                        {
                          view.state.activities.filter((activity) => activity.status === undefined)
                            .length
                        }{" "}
                        running)
                      </>
                    }
                  >
                    {view.state.activities
                      .filter((activity) => activity.status === undefined)
                      .map((activity) => (
                        <Activity
                          key={activity.id}
                          view={view}
                          id={activity.id}
                          title={activity.title}
                          owner={activity.conversationId}
                        />
                      ))}
                  </Disclosure>
                )}
                <div className="approvals">
                  {questionRequests}
                  {[...view.approvals.values()].map((approval) => (
                    <Approval key={approval.requestId} approval={approval} />
                  ))}
                </div>
              </div>
              <Composer key={view.conversation.id} view={view} />
            </>
          )
        }
      />
    );
  }

  function Provider({ provider }: { provider: AppSettings["providers"][number] }) {
    const fetcher = useFetcher<ActionResult>();
    const configuration = useFetcher<ActionResult>();
    const submitKey = (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void fetcher.submit(data, { method: "post", action: "/actions" });
      event.currentTarget.reset();
    };
    return (
      <section className="provider">
        <div className="provider-summary">
          <h3>{provider.label}</h3>
          <p className="muted">
            {provider.authenticated
              ? `Credentials available${provider.detail ? ` · ${provider.detail}` : ""}`
              : "No credentials"}
          </p>
        </div>
        <Disclosure title="Connection details" className="provider-details">
          <p className="muted">
            {provider.id} · {provider.type} · {provider.catalog} · {provider.modelCount} models
          </p>
          {provider.diagnostics.map((diagnostic, index) => (
            <p className="muted" key={index}>
              {diagnostic}
            </p>
          ))}
        </Disclosure>
        {provider.settings.length > 0 && (
          <configuration.Form
            method="post"
            action="/actions"
            className="form-grid"
            key={JSON.stringify(provider.settings)}
          >
            <Input type="hidden" name="intent" value="provider-settings" />
            <Input type="hidden" name="provider" value={provider.id} />
            {provider.settings.map((setting) => (
              <div key={setting.key}>
                <label>
                  {setting.title}
                  <Select
                    name={`setting:${setting.key}`}
                    aria-label={`${provider.label} ${setting.title}`}
                    defaultValue={String(setting.value)}
                  >
                    <SelectItem value="true">On</SelectItem>
                    <SelectItem value="false">Off</SelectItem>
                  </Select>
                </label>
                {setting.description && <p className="muted">{setting.description}</p>}
              </div>
            ))}
            <Button
              type="submit"
              disabled={configuration.state !== "idle" || Boolean(session.disconnected)}
            >
              Save provider settings
            </Button>
          </configuration.Form>
        )}
        <ActionFeedback data={configuration.data} />
        {configuration.data?.ok && configuration.data.restartRequired && <RestartButton />}
        {provider.canStore && (
          <fetcher.Form
            method="post"
            action="/actions"
            {...(provider.kind === "api-key" ? { onSubmit: submitKey } : {})}
            className="button-row"
          >
            <Input type="hidden" name="intent" value="login" />
            <Input type="hidden" name="provider" value={provider.id} />
            {provider.kind === "oauth" && connections.local ? (
              <label>
                Sign-in method
                <Select name="flow" defaultValue="browser">
                  <SelectItem value="browser">Browser sign-in</SelectItem>
                  <SelectItem value="device">Device code</SelectItem>
                </Select>
              </label>
            ) : (
              <Input
                type="hidden"
                name="flow"
                value={provider.kind === "oauth" ? "device" : "browser"}
              />
            )}

            {provider.kind === "api-key" && (
              <label>
                API key
                <Input
                  name="key"
                  type="password"
                  autoComplete="off"
                  required
                  aria-label={`${provider.label} API key`}
                />
              </label>
            )}
            <Button type="submit" disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle"
                ? "Connecting…"
                : provider.kind === "oauth"
                  ? connections.local
                    ? "Sign in"
                    : "Sign in with device code"
                  : "Save key"}
            </Button>
          </fetcher.Form>
        )}
        {!provider.canStore && provider.kind === "api-key" && (
          <p className="muted">
            Manage this connection through its configured environment variable and restart Harness.
          </p>
        )}
        {provider.authenticated && provider.canStore && (
          <fetcher.Form method="post" action="/actions">
            <Input type="hidden" name="intent" value="logout" />
            <Input type="hidden" name="provider" value={provider.id} />
            <Button type="submit" disabled={fetcher.state !== "idle"}>
              Disconnect stored credentials
            </Button>
          </fetcher.Form>
        )}
        <ActionFeedback data={fetcher.data} />
        {fetcher.data?.ok && fetcher.data.restartRequired && <RestartButton />}
      </section>
    );
  }
  function Settings() {
    useLive();
    const { settings } = useRouteLoaderData<RootData>("app")!;
    const save = useFetcher<ActionResult>();
    const hostSave = useFetcher<ActionResult>();
    const [search, setSearch] = useSearchParams();
    const sections = [
      "Appearance",
      "Composer",
      "Instructions",
      "Defaults",
      "Providers",
      "Feedback",
      "MCP",
      "Worktrees",
      "Application",
    ] as const;
    const requested = search.get("section");
    const section =
      sections.find((label) => label.toLowerCase() === requested)?.toLowerCase() ?? "appearance";
    const selected = settings.settings.model ?? session.domain.defaultModel();
    const savedSelection = modelKey(selected.provider, selected.model);
    const [defaultSelection, setDefaultSelection] = useState({
      saved: savedSelection,
      value: savedSelection,
    });
    if (defaultSelection.saved !== savedSelection)
      setDefaultSelection({ saved: savedSelection, value: savedSelection });
    return (
      <section className="page settings-page">
        <div className="page-heading">
          <h1>Settings</h1>
        </div>
        <Tabs.Root
          value={section}
          onValueChange={(section) => {
            void setSearch({ section }, { replace: true });
          }}
          className="settings-sections"
        >
          <Tabs.List aria-label="Settings sections" className="settings-section-nav">
            {sections.map((label) => (
              <Tabs.Trigger key={label} value={label.toLowerCase()} className="settings-tab">
                {label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tabs.Content value="appearance" forceMount className="settings-panel">
            <div className="section-heading">
              <h2>Appearance</h2>
              <p className="muted">Make this app feel like yours.</p>
            </div>
            <AppearanceControls />
          </Tabs.Content>
          <Tabs.Content value="composer" forceMount className="settings-panel">
            <div className="section-heading">
              <h2>Composer</h2>
              <p className="muted">Keyboard shortcuts and optional turn statistics.</p>
            </div>
            <ComposerSettings />
          </Tabs.Content>
          <Tabs.Content value="instructions" forceMount className="settings-panel">
            <InstructionsSettings
              key={session.storageKey("instructions")}
              active={section === "instructions"}
              disconnected={Boolean(session.disconnected)}
            />
          </Tabs.Content>
          <Tabs.Content value="defaults" forceMount className="settings-panel">
            <div className="section-heading">
              <h2>Conversation defaults</h2>
              <p className="muted">Used for new conversations on {connections.label}.</p>
            </div>
            <save.Form method="post" action="/actions" className="form-grid">
              <Input type="hidden" name="intent" value="settings" />
              <label>
                Model for new conversations
                <ModelSelect
                  label="Model for new conversations"
                  models={session.domain.availableModels()}
                  providers={session.settings?.providers ?? []}
                  name="model"
                  value={defaultSelection.value}
                  onValueChange={(value) => setDefaultSelection({ saved: savedSelection, value })}
                />
              </label>
              <label>
                Sandbox for new conversations
                <Select name="sandbox" defaultValue={settings.settings.sandbox}>
                  <SandboxOptions selected={settings.settings.sandbox} />
                </Select>
              </label>
              <div>
                <label className="check-label">
                  <Checkbox name="showToolNames" defaultChecked={settings.settings.showToolNames} />
                  Show deferred tool names
                </label>
                <small className="muted">
                  Include available tool names for the model. Applies to new or reloaded
                  conversations.
                </small>
              </div>
              <label>
                Subagent depth
                <Input
                  name="subagentMaxDepth"
                  type="number"
                  min={1}
                  step={1}
                  required
                  defaultValue={settings.settings.subagents.maxDepth}
                />
                <small className="muted">2 allows children and grandchildren.</small>
              </label>
              <label>
                Active children per agent
                <Input
                  name="subagentMaxChildren"
                  type="number"
                  min={1}
                  step={1}
                  required
                  defaultValue={settings.settings.subagents.maxChildren}
                />
                <small className="muted">Finished children count until dismissed.</small>
              </label>
              <label>
                Worktree directory
                <Input
                  name="worktreeDirectory"
                  defaultValue={settings.settings.worktreeDirectory ?? ""}
                  placeholder="~/.harness/worktrees"
                />
                <span className="muted">
                  On the selected server. Used for new worktrees; existing ones stay in place.
                </span>
              </label>
              <label>
                Compaction threshold (input tokens)
                <Input
                  name="compactionThresholdTokens"
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={settings.settings.compactionThresholdTokens ?? ""}
                  placeholder="Automatic"
                />
                <small className="muted">
                  Blank uses known model input/output limits. Restart the server to apply changes to
                  already-loaded conversations.
                </small>
              </label>
              <label>
                Model call retries
                <Select
                  name="modelRetriesAttempts"
                  defaultValue={String(settings.settings.modelRetries.attempts)}
                >
                  {[0, 3, 5, 10, settings.settings.modelRetries.attempts]
                    .filter((value, index, all) => all.indexOf(value) === index)
                    .map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value === 0 ? "Off" : value === 1 ? "1 attempt" : `${value} attempts`}
                      </SelectItem>
                    ))}
                </Select>
                <small className="muted">
                  Total model invocations per call, including the first (Off or 1 disables retries).
                  Retries cover transient failures (rate limits, overload, network) in every model
                  call.
                </small>
              </label>
              <label>
                Retry backoff base (ms)
                <Input
                  name="modelRetriesBackoffMs"
                  type="number"
                  min={50}
                  max={60000}
                  step={1}
                  defaultValue={settings.settings.modelRetries.backoffMs}
                />
                <small className="muted">
                  Doubles per attempt with jitter; a provider Retry-After is honored up to 60s.
                </small>
              </label>
              <label>
                Tools inside the workspace
                <Select name="inWorkspace" defaultValue={settings.settings.approval.inWorkspace}>
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="ask">Ask</SelectItem>
                  <SelectItem value="ask-human">Ask human</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
                </Select>
              </label>
              <label>
                Tools outside or with unknown scope
                <Select
                  name="outOfWorkspace"
                  defaultValue={settings.settings.approval.outOfWorkspace}
                >
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="ask">Ask</SelectItem>
                  <SelectItem value="ask-human">Ask human</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
                </Select>
              </label>
              <label>
                Human approval timeout (seconds)
                <Input
                  name="humanApprovalTimeoutSeconds"
                  type="number"
                  min="0.001"
                  max="2147483"
                  step="any"
                  defaultValue={settings.settings.approval.humanApprovalTimeoutSeconds}
                  required
                />
              </label>
              <label>
                Auto approver
                <Select
                  name="autoApproval"
                  defaultValue={String(settings.settings.autoApproval.enabled)}
                >
                  <SelectItem value="false">Off</SelectItem>
                  <SelectItem value="true">On</SelectItem>
                </Select>
              </label>
              <AuxiliaryModelFields
                prefix="reviewer"
                label="Auto approver"
                key={JSON.stringify(settings.settings.autoApproval.model)}
                model={settings.settings.autoApproval.model}
              />
              <label>
                Auto approver timeout (seconds)
                <Input
                  name="autoApprovalTimeoutSeconds"
                  type="number"
                  min="0.001"
                  max="2147483"
                  step="any"
                  defaultValue={settings.settings.autoApproval.timeoutSeconds}
                  required
                />
              </label>
              <AuxiliaryModelFields
                prefix="title"
                label="Conversation naming"
                key={JSON.stringify(settings.settings.conversationTitleModel)}
                model={settings.settings.conversationTitleModel}
              />
              <Button
                type="submit"
                variant="accent"
                disabled={save.state !== "idle" || Boolean(session.disconnected)}
              >
                Save defaults
              </Button>
            </save.Form>
            <p className="muted">
              Auto-review settings apply to open and new conversations. If no reviewer model is
              selected, each review uses the conversation’s model. Conversation naming uses its
              selected model or the conversation’s model when unset, once after the first message.
            </p>
            <ActionFeedback data={save.data} />
          </Tabs.Content>
          <Tabs.Content value="feedback" className="settings-panel">
            <FeedbackSettings session={session} />
          </Tabs.Content>
          <Tabs.Content value="mcp" forceMount className="settings-panel">
            <h2>MCP servers</h2>
            <McpSettings
              client={session.client}
              openUrl={openUrl}
              restart={() => connections.restart()}
            />
          </Tabs.Content>
          <Tabs.Content value="providers" forceMount className="settings-panel">
            <div className="section-heading">
              <h2>Providers</h2>
              <p className="muted">
                Credentials use Harness’s existing credential store. Provider changes take effect
                after a restart.
              </p>
            </div>
            <AddLiteLLM />
            {settings.providers.map((provider) => (
              <Provider key={provider.id} provider={provider} />
            ))}
            {session.authUrl && (
              <div className="auth-url">
                <p>
                  {session.authCode
                    ? "Open this URL in your browser and enter the one-time code:"
                    : "Complete sign-in in your browser. If it did not open, copy this URL:"}
                </p>
                <Input
                  readOnly
                  value={session.authUrl}
                  aria-label="Sign-in URL"
                  onFocus={(event) => event.currentTarget.select()}
                />
                {session.authCode && (
                  <Input
                    readOnly
                    value={session.authCode}
                    aria-label="Sign-in code"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                )}
                <div className="button-row">
                  <Button onClick={() => void openUrl(session.authUrl!)}>Open sign-in page</Button>
                  <Button onClick={() => session.cancelLogin()}>Cancel sign-in</Button>
                </div>
              </div>
            )}
          </Tabs.Content>
          <Tabs.Content value="worktrees" className="settings-panel">
            <div className="section-heading">
              <h2>Worktrees</h2>
            </div>
            <ManagedWorktrees session={session} />
            <ManagedDockerEnvironments session={session} />
          </Tabs.Content>
          <Tabs.Content value="application" forceMount className="settings-panel">
            <div className="section-heading">
              <h2>Application</h2>
              <p className="muted">Server lifecycle and local storage.</p>
            </div>
            <hostSave.Form
              key={String(settings.settings.keepServerRunning)}
              method="post"
              action="/actions"
              className="form-grid form-single-column"
            >
              <Input type="hidden" name="intent" value="server-settings" />
              <label className="check-label">
                <Checkbox
                  name="keepServerRunning"
                  defaultChecked={settings.settings.keepServerRunning}
                  disabled={hostSave.state !== "idle" || Boolean(session.disconnected)}
                />
                Keep this server running after desktop exit
              </label>
              <p className="muted">
                Saved on {connections.label}. When off, exit stops this server unless another client
                is connected.
              </p>
              <Button
                type="submit"
                disabled={hostSave.state !== "idle" || Boolean(session.disconnected)}
              >
                {hostSave.state === "idle" ? "Save server settings" : "Saving…"}
              </Button>
              <ActionFeedback data={hostSave.data} />
            </hostSave.Form>
            <DesktopUpdates />
            <div className="storage-location">
              <h3>Harness home</h3>
              <p className="muted">{settings.home}</p>
            </div>
            <RestartButton />
          </Tabs.Content>
        </Tabs.Root>
      </section>
    );
  }
  function AddLiteLLM() {
    const save = useFetcher<ActionResult>();
    return (
      <details className="provider-add">
        <summary>Add LiteLLM gateway</summary>
        <save.Form
          method="post"
          action="/actions"
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void save.submit(data, { method: "post", action: "/actions" });
            const key = event.currentTarget.elements.namedItem("key");
            if (key instanceof HTMLInputElement) key.value = "";
          }}
        >
          <Input type="hidden" name="intent" value="add-litellm" />
          <label>
            Provider ID
            <Input
              name="id"
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
              placeholder="work-gateway"
            />
          </label>
          <label>
            Label
            <Input name="label" placeholder="Work LiteLLM" maxLength={200} />
          </label>
          <label>
            Gateway URL
            <Input name="baseUrl" type="url" required placeholder="https://litellm.example.com" />
          </label>
          <label>
            API key
            <Input name="key" type="password" autoComplete="off" />
          </label>
          <Button type="submit" disabled={save.state !== "idle" || Boolean(session.disconnected)}>
            Add gateway
          </Button>
        </save.Form>
        <ActionFeedback data={save.data} />
      </details>
    );
  }

  function AuxiliaryModelFields({
    model,
    prefix,
    label,
  }: {
    model: AppSettings["settings"]["autoApproval"]["model"];
    prefix: "reviewer" | "title";
    label: string;
  }) {
    const [selection, setSelection] = useState(model ? modelKey(model.provider, model.model) : "");
    const presets =
      session.domain
        .availableModels()
        .find((entry) => modelKey(entry.provider, entry.model) === selection)?.presets ?? [];
    const initialPreset =
      model && selection === modelKey(model.provider, model.model) ? (model.preset ?? "") : "";
    return (
      <>
        <label>
          {label} model
          <ModelSelect
            label={`${label} model`}
            models={session.domain.availableModels()}
            providers={session.settings?.providers ?? []}
            name={`${prefix}Model`}
            value={selection}
            onValueChange={setSelection}
            emptyLabel="Use conversation model"
          />
        </label>
        <label>
          {label} preset
          <Select
            name={`${prefix}Preset`}
            key={selection}
            defaultValue={initialPreset}
            disabled={!selection}
          >
            <SelectItem value="">Model default</SelectItem>
            {initialPreset && !presets.some((entry) => entry.value === initialPreset) && (
              <SelectItem value={initialPreset}>{initialPreset} — unavailable</SelectItem>
            )}
            {presets.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label ?? entry.value}
              </SelectItem>
            ))}
          </Select>
        </label>
      </>
    );
  }
  function RouteError() {
    const error = useRouteError();
    const revalidator = useRevalidator();
    const { conversationId } = useParams();
    const [conversation, setConversation] = useState<Conversation>();
    useEffect(() => {
      let current = true;
      if (conversationId)
        void session.domain
          .getConversation(conversationId as ConversationId)
          .then((value) => {
            if (current) setConversation(value);
          })
          .catch(() => undefined);
      return () => {
        current = false;
      };
    }, [conversationId]);
    return (
      <section className="page">
        <h1>Could not open this view</h1>
        {conversation?.originalWorkspaceRoot && (
          <WorktreeControl
            session={session}
            conversation={conversation}
            running={false}
            onSwitched={() => void revalidator.revalidate()}
          />
        )}
        <p className="error" role="alert">
          {errorMessage(error)}
        </p>
        <Button
          type="button"
          disabled={revalidator.state !== "idle"}
          onClick={() => {
            void revalidator.revalidate();
          }}
        >
          Retry conversation
        </Button>
        <Link to="/new">New conversation</Link>
        <RestartButton />
      </section>
    );
  }
  return createMemoryRouter(
    [
      {
        id: "app",
        path: "/",
        Component: Layout,
        shouldRevalidate: ({ formAction, formData, defaultShouldRevalidate }) => {
          const intent = formData?.get("intent");
          // These actions do not change the settings/provider snapshot.
          if (
            formAction === "/actions" &&
            (intent === "send" || intent === "stop" || intent === "instructions")
          )
            return false;
          return defaultShouldRevalidate;
        },
        loader: async (): Promise<RootData> => {
          const [settings] = await Promise.all([
            session.readSettings(),
            session.recents.loaded || session.recents.loading || session.recents.error
              ? undefined
              : session.refreshSidebar(),
          ]);
          return { settings };
        },
        ErrorBoundary: RouteError,
        HydrateFallback: () => <div className="startup">Loading {APP_NAME}…</div>,
        children: [
          { index: true, Component: Welcome },
          {
            path: "new",
            Component: NewConversation,
            action: async ({ request }) => {
              const data = await request.formData();
              const cwd = field(data, "cwd");
              const [provider, model] = field(data, "model").split("\u0000");
              if (
                !session.domain
                  .availableModels()
                  .some((entry) => entry.provider === provider && entry.model === model)
              )
                throw new Error("Select an available model");
              const id = await session.create(
                cwd,
                field(data, "model"),
                field(data, "sandbox"),
                field(data, "toolMode"),
                field(data, "preset"),
                data.get("newWorktree") === "on",
              );
              await session.client.peer.request(
                appSettingsUpdateRequest,
                appSettingsUpdateRequest.params.parse({
                  model: { provider, model, preset: field(data, "preset") || null },
                  sandbox: field(data, "sandbox"),
                  toolMode: field(data, "toolMode"),
                }),
              );
              localStorage.setItem(session.storageKey("last-directory"), cwd);
              return redirect(`/conversations/${id}`);
            },
          },
          {
            path: "conversations/:conversationId",
            Component: ConversationPage,
            loader: ({ params }) => session.load(params.conversationId!),
            ErrorBoundary: RouteError,
          },
          { path: "settings", Component: Settings },
          {
            path: "instructions",
            loader: async (): Promise<InstructionsReadResult> => {
              try {
                return {
                  ok: true,
                  document: await session.client.peer.request(appInstructionsRequest, {}),
                };
              } catch (error) {
                return { ok: false, message: errorMessage(error) };
              }
            },
          },
          { path: "actions", action },
        ],
      },
    ],
    { initialEntries: [localStorage.getItem(session.storageKey("route")) ?? "/"] },
  );
}
