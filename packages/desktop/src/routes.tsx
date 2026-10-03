import {
  useEffect,
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
  type ActionFunctionArgs,
} from "react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { editPresentation } from "@harness/client-features/edit-presentation";
import type { Cell } from "@harness/client-features/transcript-reducer";
import type { ClientApproval } from "@harness/approval/client";
import { textOf, type Conversation, type ConversationId } from "@harness/protocol";
import {
  appAuthLoginRequest,
  appAuthLogoutRequest,
  appSettingsUpdateRequest,
  type AppSettings,
} from "@harness/server/client-protocol";
import { DesktopSession, type ConversationView } from "./session.ts";
import { Button } from "./ui.tsx";
import { applyTheme } from "./appearance.ts";
import {
  ArrowDown,
  FolderOpen,
  Plus,
  Settings as SettingsIcon,
  Terminal,
  Send,
  Square,
} from "lucide-react";

type ActionResult =
  | { ok: true; message?: string; restartRequired?: boolean }
  | { ok: false; message: string };
type RootData = { settings: AppSettings };
const modelKey = (provider: string, model: string): string => `${provider}\u0000${model}`;
const basename = (path: string | null): string =>
  path === null ? "Conversation" : (path.split(/[/\\]/u).filter(Boolean).at(-1) ?? path);
const field = (data: FormData, name: string): string => {
  const value = data.get(name);
  if (typeof value !== "string") throw new Error(`Missing ${name}`);
  return value;
};
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const conversationLabel = (conversation: Conversation, view?: ConversationView): string => {
  const user = view?.state.cells.findLast((cell) => cell.kind === "user");
  return user?.kind === "user"
    ? user.text.split("\n")[0]!.slice(0, 64)
    : `${basename(conversation.workspaceRoot)} · ${new Date(conversation.createdAt).toLocaleString()}`;
};

export function createDesktopRouter(
  session: DesktopSession,
  connections: { controls: ReactNode; local: boolean; label: string; restart(): Promise<void> },
) {
  const useLive = (): void => {
    useSyncExternalStore(session.subscribe, session.snapshot);
  };

  async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
    try {
      const data = await request.formData();
      const intent = field(data, "intent");
      switch (intent) {
        case "approval": {
          const decision = field(data, "decision");
          if (decision !== "allow" && decision !== "deny")
            throw new Error("Invalid approval decision");
          await session.plugins.approvals.respond(field(data, "requestId"), decision);
          return { ok: true };
        }
        case "list-more":
          await session.list(true);
          return { ok: true };
        case "older":
          await session.older(field(data, "conversationId"));
          return { ok: true };
        case "send": {
          const id = field(data, "conversationId") as ConversationId;
          const delivery = field(data, "delivery");
          if (delivery !== "send" && delivery !== "queue" && delivery !== "steer")
            throw new Error("Invalid input delivery");
          const text = field(data, "text").trim();
          if (!text) throw new Error("Enter a message");
          try {
            await session.domain.deliver(id, text, delivery);
          } catch (error) {
            if (!session.client.peer.ready)
              throw new Error(
                "Connection lost. Delivery outcome is unknown; reconnect and check the conversation before sending again.",
                { cause: error },
              );
            throw error;
          }
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
        case "activity-output": {
          const view = session.plugins.activities(field(data, "conversationId") as ConversationId);
          const content = await view.peek(field(data, "activityId"));
          return {
            ok: true,
            message: textOf(content),
          };
        }
        case "activity-kill":
          await session.plugins
            .activities(field(data, "conversationId") as ConversationId)
            .kill(field(data, "activityId"));
          return { ok: true };
        case "login": {
          await session.client.peer.request(
            appAuthLoginRequest,
            {
              provider: field(data, "provider"),
              key: data.has("key") ? field(data, "key") : null,
            },
            { signal: request.signal },
          );
          session.authUrl = undefined;
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
        case "settings": {
          const [provider, model] = field(data, "model").split("\u0000");
          const inWorkspace = field(data, "inWorkspace");
          const outOfWorkspace = field(data, "outOfWorkspace");
          const sandbox = field(data, "sandbox");
          const autoApproval = field(data, "autoApproval");
          const [reviewerProvider, reviewerModel] = field(data, "reviewerModel").split("\u0000");
          const reviewerPreset = reviewerModel ? field(data, "reviewerPreset") : "";
          if (
            ![inWorkspace, outOfWorkspace].every(
              (value) => value === "allow" || value === "ask" || value === "deny",
            )
          )
            throw new Error("Invalid approval policy");
          if (sandbox !== "local" && sandbox !== "native" && sandbox !== "docker")
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
              inWorkspace: inWorkspace as "allow" | "ask" | "deny",
              outOfWorkspace: outOfWorkspace as "allow" | "ask" | "deny",
            },
            autoApproval: {
              enabled: autoApproval === "true",
              model:
                reviewerProvider && reviewerModel
                  ? {
                      provider: reviewerProvider,
                      model: reviewerModel,
                      preset: reviewerPreset || null,
                    }
                  : null,
            },
            sandbox,
          });
          return {
            ok: true,
            message: "Settings saved. The model and sandbox defaults apply to new conversations.",
          };
        }
        default:
          throw new Error(`Unknown action: ${String(intent)}`);
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  function ActionFeedback({ data }: { data: ActionResult | undefined }) {
    return data && "message" in data ? (
      <p role={data.ok ? "status" : "alert"} className={data.ok ? "muted" : "error"}>
        {data.message}
      </p>
    ) : null;
  }
  function RestartButton() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const running = [...session.views.values()].some(
      (view) =>
        view.state.turn.status === "running" ||
        session.plugins.runningActivities(view.conversation.id) > 0,
    );
    return (
      <div className="restart">
        <p className="muted">
          Restart saves history and stops all conversations, commands and pending approvals.
        </p>
        <Button
          disabled={busy}
          onClick={() => {
            if (
              running &&
              !window.confirm(
                "Restart Harness and stop all running work? Conversation history is saved.",
              )
            )
              return;
            setBusy(true);
            void connections.restart().catch((cause: unknown) => {
              setError(errorMessage(cause));
              setBusy(false);
            });
          }}
        >
          {busy ? "Restarting…" : "Restart Harness"}
        </Button>
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
        <span className="muted">{approval.relationship}</span>
        <pre>
          {typeof approval.call.args === "string"
            ? approval.call.args
            : JSON.stringify(approval.call.args, null, 2)}
        </pre>
        <fetcher.Form method="post" action="/actions" className="button-row">
          <input type="hidden" name="intent" value="approval" />
          <input type="hidden" name="requestId" value={approval.requestId} />
          <Button name="decision" value="deny" disabled={fetcher.state !== "idle"}>
            Deny
          </Button>
          <Button
            className="primary"
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
    useLive();
    const navigation = useNavigation();
    const more = useFetcher<ActionResult>();
    return (
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <Terminal size={19} aria-hidden="true" />
            <span>Harness</span>
          </div>
          {connections.controls}
          <Link to="/new" className="new-conversation">
            <Plus size={15} aria-hidden="true" /> New conversation
          </Link>
          <nav aria-label="Conversations" className="conversation-list">
            {session.conversations.map((conversation) => {
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
                  <span className="conversation-title">
                    {conversationLabel(conversation, view)}
                  </span>
                  <small className={view?.approvals.size ? "approval-status" : "muted"}>
                    {status || basename(conversation.workspaceRoot)}
                  </small>
                </NavLink>
              );
            })}
            {session.listCursor && (
              <more.Form method="post" action="/actions">
                <input type="hidden" name="intent" value="list-more" />
                <Button disabled={more.state !== "idle"}>Load more</Button>
              </more.Form>
            )}
            <ActionFeedback data={more.data} />
          </nav>
          <NavLink to="/settings" className="settings-link">
            <SettingsIcon size={15} aria-hidden="true" /> Settings
          </NavLink>
        </aside>
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
      </div>
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
  function ModelOptions({ selected }: { selected?: { provider: string; model: string } }) {
    const models = session.domain.availableModels();
    const unavailable =
      selected &&
      !models.some(
        (model) => model.provider === selected.provider && model.model === selected.model,
      );
    return (
      <>
        {unavailable && (
          <option value={modelKey(selected.provider, selected.model)}>
            {session.settings?.providers.find((provider) => provider.id === selected.provider)
              ?.label ?? selected.provider}{" "}
            / {selected.model} — unavailable;{" "}
            {session.settings?.providers.find((provider) => provider.id === selected.provider)
              ?.catalog ?? "check provider configuration"}
          </option>
        )}
        {models.map((model) => (
          <option
            key={modelKey(model.provider, model.model)}
            value={modelKey(model.provider, model.model)}
          >
            {session.settings?.providers.find((provider) => provider.id === model.provider)
              ?.label ?? model.provider}{" "}
            / {model.label ?? model.model}
            {[
              ...(model.contextWindow ? [`${model.contextWindow.toLocaleString()} context`] : []),
              ...(model.maxInputTokens ? [`${model.maxInputTokens.toLocaleString()} input`] : []),
              ...(model.maxOutputTokens
                ? [`${model.maxOutputTokens.toLocaleString()} output`]
                : []),
              ...(model.reasoning?.supported === true ? ["reasoning"] : []),
            ]
              .map((detail) => ` · ${detail}`)
              .join("")}
          </option>
        ))}
      </>
    );
  }
  function SandboxOptions({ selected }: { selected?: string }) {
    return (
      <>
        <option value="local">Local</option>
        {session.settings?.platform === "linux" && <option value="native">Native</option>}
        {session.settings?.platform !== "linux" && selected === "native" && (
          <option value="native">Native (Linux only)</option>
        )}
        <option value="docker">Docker / devcontainer</option>
      </>
    );
  }
  function NewConversation() {
    const { settings } = useRouteLoaderData<RootData>("app")!;
    const [cwd, setCwd] = useState(
      localStorage.getItem(session.storageKey("last-directory")) ?? settings.cwd,
    );
    const navigation = useNavigation();
    const defaultModel = settings.settings.model ?? session.domain.defaultModel();
    const [selection, setSelection] = useState(modelKey(defaultModel.provider, defaultModel.model));
    const [backend, setBackend] = useState<string>(settings.settings.sandbox);
    const backendAvailable = backend !== "native" || settings.platform === "linux";
    const available = session.domain
      .availableModels()
      .some((model) => modelKey(model.provider, model.model) === selection);
    const [error, setError] = useState<string>();
    return (
      <section className="page new-page">
        <h1>New conversation</h1>
        <Form method="post" className="form-grid">
          <label>
            Project folder
            <input
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
          <label>
            Model
            <select
              name="model"
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
            >
              <ModelOptions selected={defaultModel} />
            </select>
          </label>
          <label>
            Sandbox
            <select
              name="sandbox"
              value={backend}
              onChange={(event) => setBackend(event.target.value)}
            >
              <SandboxOptions selected={backend} />
            </select>
          </label>
          <label>
            Tool interface
            <select name="toolMode" defaultValue="direct">
              <option value="direct">Direct</option>
              <option value="hybrid">Direct and code</option>
              <option value="code-only">Code only</option>
            </select>
          </label>
          <Button
            className="primary"
            disabled={
              !available ||
              !backendAvailable ||
              navigation.state !== "idle" ||
              Boolean(session.disconnected)
            }
          >
            {navigation.state !== "idle" ? "Creating…" : "Create conversation"}
          </Button>
        </Form>
        {!available && (
          <p role="status" className="muted">
            The selected model is unavailable in this server. Restart after connecting its provider,
            or select an available model.
          </p>
        )}
        {!backendAvailable && (
          <p role="status" className="muted">
            Native sandbox requires Linux. Select Local or Docker to continue.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <p className="muted">Docker uses this folder’s devcontainer configuration.</p>
      </section>
    );
  }

  function ConversationControls({ view }: { view: ConversationView }) {
    const model = useFetcher<ActionResult>();
    const preset = useFetcher<ActionResult>();
    const sandbox = useFetcher<ActionResult>();
    const control = useFetcher<ActionResult>();
    const id = view.conversation.id;
    const selected = view.conversation.config.model;
    const presets =
      session.domain
        .availableModels()
        .find((entry) => entry.provider === selected.provider && entry.model === selected.model)
        ?.presets ?? [];
    const backend =
      (view.conversation.config.plugins?.["sandbox"] as { backend?: string } | undefined)
        ?.backend ?? "local";
    const running = view.state.turn.status === "running";
    const disabled = Boolean(session.disconnected);
    return (
      <div className="conversation-controls">
        <model.Form method="post" action="/actions">
          <input type="hidden" name="intent" value="model" />
          <input type="hidden" name="conversationId" value={id} />
          <label>
            Model
            <select
              aria-label="Conversation model"
              name="model"
              value={modelKey(selected.provider, selected.model)}
              disabled={disabled || model.state !== "idle"}
              onChange={(event) => {
                void model.submit(event.currentTarget.form);
              }}
            >
              <ModelOptions selected={selected} />
            </select>
          </label>
        </model.Form>
        {presets.length > 0 && (
          <preset.Form method="post" action="/actions">
            <input type="hidden" name="intent" value="preset" />
            <input type="hidden" name="conversationId" value={id} />
            <label>
              Preset
              <select
                aria-label="Conversation preset"
                name="preset"
                value={selected.preset ?? ""}
                disabled={disabled || preset.state !== "idle"}
                onChange={(event) => {
                  void preset.submit(event.currentTarget.form);
                }}
              >
                <option value="">Default</option>
                {presets.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label ?? entry.value}
                  </option>
                ))}
              </select>
            </label>
          </preset.Form>
        )}
        <sandbox.Form method="post" action="/actions">
          <input type="hidden" name="intent" value="sandbox" />
          <input type="hidden" name="conversationId" value={id} />
          <label>
            Sandbox
            <select
              aria-label="Conversation sandbox"
              name="sandbox"
              value={backend}
              disabled={running || disabled || sandbox.state !== "idle"}
              onChange={(event) => {
                if (
                  session.plugins.runningActivities(id) > 0 &&
                  !window.confirm(
                    "Changing sandbox stops this conversation's background work. Continue?",
                  )
                )
                  return;
                void sandbox.submit(event.currentTarget.form);
              }}
            >
              <SandboxOptions selected={backend} />
            </select>
          </label>
        </sandbox.Form>
        {backend === "docker" && (
          <control.Form method="post" action="/actions">
            <input type="hidden" name="conversationId" value={id} />
            <Button name="intent" value="rebuild" disabled={disabled || control.state !== "idle"}>
              Rebuild
            </Button>
            <Button
              name="intent"
              value="sandbox-stop"
              disabled={disabled || control.state !== "idle"}
            >
              Stop container
            </Button>
            <span className="muted">Affects conversations sharing this container.</span>
          </control.Form>
        )}
        <ActionFeedback data={model.data} />
        <ActionFeedback data={preset.data} />
        <ActionFeedback data={sandbox.data} />
        <ActionFeedback data={control.data} />
      </div>
    );
  }

  function TranscriptCell({ cell, children = [] }: { cell: Cell; children?: Cell[] | undefined }) {
    if (cell.kind === "tool") {
      const edit = editPresentation(cell);
      return (
        <details
          className={`cell tool ${cell.status === "error" ? "failed" : ""}`}
          data-testid="tool-call"
        >
          <summary>
            <strong>
              {edit
                ? cell.status === "ok"
                  ? edit.labels.succeeded
                  : cell.status === "error"
                    ? edit.labels.failed
                    : edit.labels.running
                : cell.name}
            </strong>
            <span className="muted">
              {cell.approvalProgress?.status === "reviewing"
                ? "awaiting approval"
                : (cell.status ?? "running")}
            </span>
            {children.length > 0 && (
              <span className="muted">{children.length} nested operations</span>
            )}
          </summary>
          {cell.parentCallId && <p className="muted">Invoked by {cell.parentCallId}</p>}
          {children.length > 0 && (
            <div className="nested-tools">
              {children.map((child) => (
                <TranscriptCell key={child.kind === "tool" ? child.callId : ""} cell={child} />
              ))}
            </div>
          )}
          {edit &&
            edit.files.map((file, index) => (
              <section className="diff" key={`${file.path}:${index}`}>
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
          <h3>Arguments</h3>
          <pre>
            {typeof cell.args === "string" ? cell.args : JSON.stringify(cell.args, null, 2)}
          </pre>
          <h3>Output</h3>
          <pre data-testid="tool-output">{cell.output ?? "Waiting for output…"}</pre>
          {cell.approval && (
            <p className="muted">
              {cell.approval.decision === "allow" ? "Allowed" : "Denied"} by{" "}
              {cell.approval.responder}
            </p>
          )}
        </details>
      );
    }
    if (cell.kind === "reasoning")
      return (
        <details className="cell reasoning">
          <summary>Reasoning {cell.streaming ? "…" : ""}</summary>
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: TranscriptLink }}>
            {cell.text}
          </Markdown>
        </details>
      );
    if (cell.kind === "compaction" || cell.kind === "context")
      return (
        <details className="cell">
          <summary>{cell.kind === "compaction" ? "Compacted context" : "Context"}</summary>
          <pre>{cell.text}</pre>
        </details>
      );
    if (cell.kind === "worked")
      return <div className="cell muted">Worked for {Math.round(cell.duration / 1000)}s</div>;
    if (cell.kind === "user")
      return (
        <article className="cell user">
          <small>You</small>
          <div className="user-text">{cell.text}</div>
        </article>
      );
    if (cell.kind === "assistant")
      return (
        <article className="cell assistant" data-testid="assistant-message">
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: TranscriptLink }}>
            {cell.text}
          </Markdown>
          {cell.streaming && <span className="stream-indicator" aria-label="Streaming" />}
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
        <details className="cell">
          <summary>{cell.command}</summary>
          <pre>{cell.text}</pre>
        </details>
      );
    return <div className="cell muted">{cell.text}</div>;
  }
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
    running,
  }: {
    view: ConversationView;
    id: string;
    title: string;
    running: boolean;
  }) {
    const output = useFetcher<ActionResult>();
    const kill = useFetcher<ActionResult>();
    return (
      <details className="activity">
        <summary>
          {title} · {running ? "running" : "finished"}
        </summary>
        <output.Form method="post" action="/actions">
          <input type="hidden" name="conversationId" value={view.conversation.id} />
          <input type="hidden" name="activityId" value={id} />
          <Button name="intent" value="activity-output" disabled={output.state !== "idle"}>
            Refresh output
          </Button>
        </output.Form>
        {output.data?.ok && output.data.message && <pre>{output.data.message}</pre>}
        {output.data && !output.data.ok && <ActionFeedback data={output.data} />}
        {running && (
          <kill.Form method="post" action="/actions">
            <input type="hidden" name="conversationId" value={view.conversation.id} />
            <input type="hidden" name="activityId" value={id} />
            <Button name="intent" value="activity-kill" disabled={kill.state !== "idle"}>
              Stop activity
            </Button>
          </kill.Form>
        )}
      </details>
    );
  }
  function Composer({ view }: { view: ConversationView }) {
    const send = useFetcher<ActionResult>();
    const stop = useFetcher<ActionResult>();
    const id = view.conversation.id;
    const [text, setText] = useState(localStorage.getItem(session.storageKey(`draft:${id}`)) ?? "");
    const textarea = useRef<HTMLTextAreaElement>(null);
    const handled = useRef<ActionResult | undefined>(undefined);
    const running = view.state.turn.status === "running";
    useEffect(() => {
      if (send.state === "idle" && send.data?.ok && handled.current !== send.data) {
        handled.current = send.data;
        setText(localStorage.getItem(session.storageKey(`draft:${id}`)) ?? "");
        textarea.current?.focus();
      }
    }, [send.state, send.data, id]);
    return (
      <div className="composer">
        {view.state.pendingInput.length > 0 && (
          <div className="pending-input">
            {view.state.pendingInput.map((input, index) => (
              <div key={index}>
                {input.intent}: {input.text}
              </div>
            ))}
          </div>
        )}
        <send.Form method="post" action="/actions">
          <input type="hidden" name="intent" value="send" />
          <input type="hidden" name="conversationId" value={id} />
          <textarea
            ref={textarea}
            name="text"
            aria-label="Message"
            placeholder="Ask Harness to work on something…"
            value={text}
            rows={3}
            onChange={(event) => {
              setText(event.target.value);
              localStorage.setItem(session.storageKey(`draft:${id}`), event.target.value);
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-actions">
            <label>
              Delivery
              <select
                name="delivery"
                key={running ? "running" : "idle"}
                defaultValue={running ? "steer" : "send"}
              >
                {running ? (
                  <>
                    <option value="steer">Steer now</option>
                    <option value="queue">Queue next</option>
                  </>
                ) : (
                  <option value="send">Send</option>
                )}
              </select>
            </label>
            <small className="muted">Ctrl / ⌘ Enter</small>
            <Button
              className="primary"
              disabled={!text.trim() || send.state !== "idle" || Boolean(session.disconnected)}
            >
              <Send size={14} aria-hidden="true" />
              {send.state !== "idle" ? "Sending…" : running ? "Submit" : "Send"}
            </Button>
          </div>
        </send.Form>
        {running && (
          <stop.Form method="post" action="/actions">
            <input type="hidden" name="intent" value="stop" />
            <input type="hidden" name="conversationId" value={id} />
            <Button
              className="stop-turn"
              disabled={stop.state !== "idle" || Boolean(session.disconnected)}
            >
              <Square size={12} aria-hidden="true" />
              Stop
            </Button>
          </stop.Form>
        )}
        <ActionFeedback data={send.data} />
        <ActionFeedback data={stop.data} />
      </div>
    );
  }
  function ConversationPage() {
    useLive();
    const view = useLoaderData<ConversationView>();
    const older = useFetcher<ActionResult>();
    const scroller = useRef<VirtuosoHandle>(null);
    const [atBottom, setAtBottom] = useState(true);
    const calls = new Set(
      view.state.cells.flatMap((cell) => (cell.kind === "tool" ? [cell.callId] : [])),
    );
    const children = new Map<string, Cell[]>();
    const cells = view.state.cells.filter((cell) => {
      if (cell.kind !== "tool" || !cell.parentCallId || !calls.has(cell.parentCallId)) return true;
      const siblings = children.get(cell.parentCallId) ?? [];
      siblings.push(cell);
      children.set(cell.parentCallId, siblings);
      return false;
    });
    return (
      <div className="conversation-page" key={view.conversation.id}>
        <header className="conversation-header">
          <h1>{conversationLabel(view.conversation, view)}</h1>
          <div className="workspace-path" title={view.conversation.workspaceRoot ?? undefined}>
            {view.conversation.workspaceRoot}
          </div>
          <ConversationControls view={view} />
        </header>
        <div className="transcript" data-testid="transcript">
          <Virtuoso
            ref={scroller}
            key={view.conversation.id}
            data={cells}
            initialTopMostItemIndex={Math.max(0, cells.length - 1)}
            followOutput={(bottom) => (bottom ? "auto" : false)}
            atBottomStateChange={setAtBottom}
            itemContent={(_index, cell) => (
              <TranscriptCell
                cell={cell}
                children={cell.kind === "tool" ? children.get(cell.callId) : undefined}
              />
            )}
            components={{
              Header: () =>
                view.cursor ? (
                  <older.Form method="post" action="/actions">
                    <input type="hidden" name="intent" value="older" />
                    <input type="hidden" name="conversationId" value={view.conversation.id} />
                    <Button disabled={older.state !== "idle"}>Load earlier messages</Button>
                    <ActionFeedback data={older.data} />
                  </older.Form>
                ) : null,
            }}
          />
          {!atBottom && (
            <Button
              className="jump-latest"
              onClick={() =>
                scroller.current?.scrollToIndex({
                  index: view.state.cells.length - 1,
                  align: "end",
                })
              }
            >
              <ArrowDown size={14} aria-hidden="true" /> Jump to latest
            </Button>
          )}
        </div>
        <div className="conversation-status">
          <span role="status">
            {view.approvals.size
              ? "Waiting for approval"
              : view.state.turn.status === "running"
                ? "Working…"
                : "Ready"}
          </span>
          <span className="muted">
            {view.state.usage.inputTokens.toLocaleString()} input ·{" "}
            {view.state.usage.outputTokens.toLocaleString()} output
            {view.state.usageIncomplete ? " · incomplete" : ""} · ${view.state.cost.toFixed(4)}
          </span>
        </div>
        {view.state.sandbox?.message && (
          <p
            role="status"
            className={
              view.state.sandbox.phase === "error" ? "error sandbox-status" : "sandbox-status muted"
            }
          >
            {view.state.sandbox.message}
          </p>
        )}
        {view.state.activities.length > 0 && (
          <details className="activities">
            <summary>
              Activities (
              {view.state.activities.filter((activity) => activity.status === undefined).length}{" "}
              running)
            </summary>
            {view.state.activities.map((activity) => (
              <Activity
                key={activity.id}
                view={view}
                id={activity.id}
                title={activity.title}
                running={activity.status === undefined}
              />
            ))}
          </details>
        )}
        <div className="approvals">
          {[...view.approvals.values()].map((approval) => (
            <Approval key={approval.requestId} approval={approval} />
          ))}
        </div>
        <Composer key={view.conversation.id} view={view} />
      </div>
    );
  }

  function Provider({ provider }: { provider: AppSettings["providers"][number] }) {
    const fetcher = useFetcher<ActionResult>();
    const submitKey = (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void fetcher.submit(data, { method: "post", action: "/actions" });
      event.currentTarget.reset();
    };
    return (
      <section className="provider">
        <h3>{provider.label}</h3>
        <p className="muted">
          {provider.authenticated
            ? `Credentials available${provider.detail ? ` · ${provider.detail}` : ""}`
            : "No credentials"}
        </p>
        <p className="muted">
          {provider.id} · {provider.type} · {provider.catalog} · {provider.modelCount} models
        </p>
        {provider.diagnostics.map((diagnostic, index) => (
          <p className="muted" key={index}>
            {diagnostic}
          </p>
        ))}
        {provider.canStore && (
          <fetcher.Form
            method="post"
            action="/actions"
            {...(provider.kind === "api-key" ? { onSubmit: submitKey } : {})}
            className="button-row"
          >
            <input type="hidden" name="intent" value="login" />
            <input type="hidden" name="provider" value={provider.id} />
            {provider.kind === "api-key" && (
              <label>
                API key
                <input
                  name="key"
                  type="password"
                  autoComplete="off"
                  required
                  aria-label={`${provider.label} API key`}
                />
              </label>
            )}
            <Button disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle"
                ? "Connecting…"
                : provider.kind === "oauth"
                  ? "Sign in with browser"
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
            <input type="hidden" name="intent" value="logout" />
            <input type="hidden" name="provider" value={provider.id} />
            <Button disabled={fetcher.state !== "idle"}>Disconnect stored credentials</Button>
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
    const selected = settings.settings.model ?? session.domain.defaultModel();
    const [theme, setTheme] = useState(localStorage.getItem("theme") ?? "system");
    return (
      <section className="page settings-page">
        <h1>Settings</h1>
        <p className="muted">Server settings · {connections.label}</p>
        <h2>Defaults</h2>
        <save.Form method="post" action="/actions" className="form-grid">
          <input type="hidden" name="intent" value="settings" />
          <label>
            Model for new conversations
            <select
              name="model"
              key={modelKey(selected.provider, selected.model)}
              defaultValue={modelKey(selected.provider, selected.model)}
            >
              <ModelOptions selected={selected} />
            </select>
          </label>
          <label>
            Sandbox for new conversations
            <select name="sandbox" defaultValue={settings.settings.sandbox}>
              <SandboxOptions selected={settings.settings.sandbox} />
            </select>
          </label>
          <label>
            Tools inside the workspace
            <select name="inWorkspace" defaultValue={settings.settings.approval.inWorkspace}>
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </select>
          </label>
          <label>
            Tools outside or with unknown scope
            <select name="outOfWorkspace" defaultValue={settings.settings.approval.outOfWorkspace}>
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </select>
          </label>
          <label>
            Auto approver
            <select
              name="autoApproval"
              defaultValue={String(settings.settings.autoApproval.enabled)}
            >
              <option value="false">Off</option>
              <option value="true">On</option>
            </select>
          </label>
          <ReviewerFields
            key={JSON.stringify(settings.settings.autoApproval.model)}
            model={settings.settings.autoApproval.model}
          />
          <Button
            className="primary"
            disabled={save.state !== "idle" || Boolean(session.disconnected)}
          >
            Save defaults
          </Button>
        </save.Form>
        <p className="muted">
          Auto-review settings apply to open and new conversations. If no reviewer model is
          selected, each review uses the conversation’s model.
        </p>
        <ActionFeedback data={save.data} />
        <h2>Providers</h2>
        <p className="muted">
          Credentials use Harness’s existing credential store. Provider changes take effect after a
          restart.
        </p>
        {settings.providers.map((provider) => (
          <Provider key={provider.id} provider={provider} />
        ))}
        {session.authUrl && (
          <div className="auth-url">
            <p>Complete sign-in in your browser. If it did not open, copy this URL:</p>
            <input
              readOnly
              value={session.authUrl}
              aria-label="Sign-in URL"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        )}
        <h2>Appearance</h2>
        <label>
          Theme
          <select
            value={theme}
            onChange={(event) => {
              setTheme(event.target.value);
              localStorage.setItem("theme", event.target.value);
              applyTheme(event.target.value);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <h2>Application</h2>
        <p className="muted">Harness home: {settings.home}</p>
        <RestartButton />
      </section>
    );
  }
  function ReviewerFields({ model }: { model: AppSettings["settings"]["autoApproval"]["model"] }) {
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
          Auto approver model
          <select
            name="reviewerModel"
            value={selection}
            onChange={(event) => setSelection(event.target.value)}
          >
            <option value="">Use conversation model</option>
            <ModelOptions {...(model ? { selected: model } : {})} />
          </select>
        </label>
        <label>
          Auto approver preset
          <select
            name="reviewerPreset"
            key={selection}
            defaultValue={initialPreset}
            disabled={!selection}
          >
            <option value="">Model default</option>
            {initialPreset && !presets.some((entry) => entry.value === initialPreset) && (
              <option value={initialPreset}>{initialPreset} — unavailable</option>
            )}
            {presets.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label ?? entry.value}
              </option>
            ))}
          </select>
        </label>
      </>
    );
  }
  function RouteError() {
    const error = useRouteError();
    const revalidator = useRevalidator();
    return (
      <section className="page">
        <h1>Could not open this view</h1>
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
        loader: async (): Promise<RootData> => {
          const [settings] = await Promise.all([
            session.readSettings(),
            session.listLoaded ? undefined : session.list(),
          ]);
          return { settings };
        },
        ErrorBoundary: RouteError,
        HydrateFallback: () => <div className="startup">Loading Harness…</div>,
        children: [
          { index: true, Component: Welcome },
          {
            path: "new",
            Component: NewConversation,
            action: async ({ request }) => {
              const data = await request.formData();
              const cwd = field(data, "cwd");
              const id = await session.create(
                cwd,
                field(data, "model"),
                field(data, "sandbox"),
                field(data, "toolMode"),
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
          { path: "actions", action },
        ],
      },
    ],
    { initialEntries: [localStorage.getItem(session.storageKey("route")) ?? "/"] },
  );
}
