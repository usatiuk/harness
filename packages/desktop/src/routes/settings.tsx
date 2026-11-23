import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { useFetcher, useNavigate, useParams } from "react-router";
import { sections, settingsSection } from "./settings-location.ts";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppSettings } from "@harness/server/client-protocol";
import type { ModelInfo } from "@harness/protocol";
import type { DesktopSession } from "../session.ts";
import { AutoSaveForm } from "../components/auto-save-form.tsx";
import { ActionFeedback, type ActionResult } from "../components/action-feedback.tsx";
import { InstructionsSettings } from "../components/instructions-settings.tsx";
import { FeedbackSettings } from "../components/feedback-controls.tsx";
import { ManagedWorktrees, ManagedDockerEnvironments } from "../components/worktree-controls.tsx";
import { McpSettings } from "../components/mcp-settings.tsx";
import { DesktopUpdates } from "../components/desktop-updates.tsx";
import { ModelSelect, modelKey } from "../components/model-select.tsx";
import { AppearanceControls, ComposerSettings } from "../components/appearance-controls.tsx";
import { SectionHeading, SettingsGroup } from "../components/settings-layout.tsx";
import { Button, Checkbox, Input, Select, SelectItem, Disclosure, Dialog, Tabs } from "../ui.tsx";

export type GatewayCreatedError = { ok: false; gatewayCreated: true; message: string };
type DefaultSetting =
  | "model"
  | "sandbox"
  | "showToolNames"
  | "approval"
  | "autoApproval"
  | "conversationTitleModel"
  | "subagents"
  | "modelRetries"
  | "compactionThresholdTokens";

function Provider({
  provider,
  local,
  disconnected,
  restartButton,
}: {
  provider: AppSettings["providers"][number];
  local: boolean;
  disconnected: boolean;
  restartButton: ReactNode;
}) {
  const fetcher = useFetcher<ActionResult>();
  const submitKey = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void fetcher.submit(data, { method: "post", action: "/actions" });
    event.currentTarget.reset();
  };
  return (
    <section className="provider" aria-label={provider.label}>
      <Disclosure
        className="provider-toggle"
        title={
          <span className="provider-summary">
            <strong>{provider.label}</strong>
            <span className="muted">
              {provider.authenticated
                ? `Credentials available${provider.detail ? ` · ${provider.detail}` : ""}`
                : "No credentials"}
            </span>
          </span>
        }
      >
        <div className="provider-content">
          <p className="muted">
            {provider.id} · {provider.type} · {provider.catalog} · {provider.modelCount} models
          </p>
          {provider.diagnostics.map((diagnostic, index) => (
            <p className="muted" key={index}>
              {diagnostic}
            </p>
          ))}
          {provider.settings.length > 0 && (
            <AutoSaveForm
              preference={`provider:${provider.id}`}
              className="provider-fields"
              disabled={disconnected}
              afterSave={(data) => (data.restartRequired ? restartButton : null)}
            >
              <Input type="hidden" name="intent" value="provider-settings" />
              <Input type="hidden" name="provider" value={provider.id} />
              {provider.settings.map((setting) => (
                <div key={setting.key} className="provider-field">
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
            </AutoSaveForm>
          )}
          {provider.canStore && (
            <fetcher.Form
              method="post"
              action="/actions"
              {...(provider.kind === "api-key" ? { onSubmit: submitKey } : {})}
              className="provider-signin"
            >
              <Input type="hidden" name="intent" value="login" />
              <Input type="hidden" name="provider" value={provider.id} />
              {provider.kind === "oauth" && local ? (
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
                    ? local
                      ? "Sign in"
                      : "Sign in with device code"
                    : "Save key"}
              </Button>
            </fetcher.Form>
          )}
          {!provider.canStore && provider.kind === "api-key" && (
            <p className="muted">
              Manage this connection through its configured environment variable and restart
              Harness.
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
        </div>
      </Disclosure>
      <ActionFeedback data={fetcher.data} />
      {fetcher.data?.ok && fetcher.data.restartRequired && restartButton}
    </section>
  );
}
function DefaultForm({
  disconnected,
  setting,
  columns = false,
  children,
}: {
  disconnected: boolean;
  setting: DefaultSetting;
  columns?: boolean;
  children: ReactNode;
}) {
  return (
    <AutoSaveForm
      preference={setting}
      className={columns ? "form-grid" : "server-settings"}
      disabled={disconnected}
    >
      <Input type="hidden" name="intent" value="settings" />
      <Input type="hidden" name="setting" value={setting} />
      {children}
    </AutoSaveForm>
  );
}
export function SettingsPage({
  session,
  settings,
  connections,
  restartButton,
  sandboxOptions,
}: {
  session: DesktopSession;
  settings: AppSettings;
  connections: { local: boolean; label: ReactNode; restart(): Promise<void> };
  restartButton: ReactNode;
  sandboxOptions: ReactNode;
}) {
  const disconnected = Boolean(session.disconnected);
  const models = session.domain.availableModels();
  const providers = session.settings?.providers ?? [];
  const navigate = useNavigate();
  const section = settingsSection(useParams().section);
  const selected = settings.settings.model ?? session.domain.defaultModel();
  const savedSelection = modelKey(selected.provider, selected.model);
  const [modelDraft, setModelDraft] = useState<string>();
  if (modelDraft === savedSelection) setModelDraft(undefined);
  return (
    <section className="page settings-page">
      <div className="page-heading">
        <h1>Settings</h1>
      </div>
      <Tabs.Root
        activationMode="manual"
        value={section}
        onValueChange={(section) => {
          void navigate(`/settings/${section}`);
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
          <SectionHeading title="Appearance">Make this app feel like yours.</SectionHeading>
          <AppearanceControls />
        </Tabs.Content>
        <Tabs.Content value="composer" forceMount className="settings-panel">
          <SectionHeading title="Composer">
            Keyboard shortcuts and optional turn statistics.
          </SectionHeading>
          <ComposerSettings />
        </Tabs.Content>
        <Tabs.Content value="instructions" forceMount className="settings-panel">
          <InstructionsSettings
            key={session.storageKey("instructions")}
            active={section === "instructions"}
            disconnected={disconnected}
          />
        </Tabs.Content>
        <Tabs.Content value="defaults" forceMount className="settings-panel">
          <SectionHeading title="Conversation defaults">
            Used for new conversations on {connections.label}.
          </SectionHeading>
          <div className="settings-stack defaults-form">
            <SettingsGroup title="New conversations">
              <div className="form-grid">
                <DefaultForm disconnected={disconnected} setting="model">
                  <label>
                    Model for new conversations
                    <ModelSelect
                      label="Model for new conversations"
                      models={models}
                      providers={providers}
                      name="model"
                      value={modelDraft ?? savedSelection}
                      onValueChange={setModelDraft}
                    />
                  </label>
                </DefaultForm>
                <DefaultForm disconnected={disconnected} setting="sandbox">
                  <label>
                    Sandbox for new conversations
                    <Select name="sandbox" defaultValue={settings.settings.sandbox}>
                      {sandboxOptions}
                    </Select>
                  </label>
                </DefaultForm>
                <DefaultForm disconnected={disconnected} setting="showToolNames">
                  <div>
                    <Checkbox
                      label="Show deferred tool names"
                      name="showToolNames"
                      defaultChecked={settings.settings.showToolNames}
                    />
                    <small className="muted">
                      Include available tool names for the model. Applies to new or reloaded
                      conversations.
                    </small>
                  </div>
                </DefaultForm>
              </div>
            </SettingsGroup>
            <SettingsGroup title="Tool approvals">
              <DefaultForm disconnected={disconnected} setting="approval" columns>
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
              </DefaultForm>
            </SettingsGroup>
            <SettingsGroup title="Automatic review">
              <DefaultForm disconnected={disconnected} setting="autoApproval" columns>
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
                  models={models}
                  providers={providers}
                  prefix="reviewer"
                  label="Auto approver"
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
                <p className="muted settings-field-help">
                  Auto-review settings apply to open and new conversations. Without a reviewer
                  model, reviews use the conversation model.
                </p>
              </DefaultForm>
            </SettingsGroup>
            <SettingsGroup title="Conversation naming">
              <DefaultForm disconnected={disconnected} setting="conversationTitleModel" columns>
                <AuxiliaryModelFields
                  models={models}
                  providers={providers}
                  prefix="title"
                  label="Conversation naming"
                  model={settings.settings.conversationTitleModel}
                />
                <p className="muted settings-field-help">
                  Naming runs once after the first message, using the conversation model when unset.
                </p>
              </DefaultForm>
            </SettingsGroup>
            <SettingsGroup title="Subagent limits">
              <DefaultForm disconnected={disconnected} setting="subagents" columns>
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
              </DefaultForm>
            </SettingsGroup>
            <SettingsGroup title="Context and model retries">
              <DefaultForm disconnected={disconnected} setting="compactionThresholdTokens" columns>
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
                    Blank uses known model input/output limits. Restart the server to apply changes
                    to already-loaded conversations.
                  </small>
                </label>
              </DefaultForm>
              <DefaultForm disconnected={disconnected} setting="modelRetries" columns>
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
                    Total model invocations per call, including the first (Off or 1 disables
                    retries). Retries cover transient failures (rate limits, overload, network) in
                    every model call.
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
              </DefaultForm>
            </SettingsGroup>
          </div>
        </Tabs.Content>
        <Tabs.Content value="feedback" className="settings-panel">
          <FeedbackSettings session={session} />
        </Tabs.Content>
        <Tabs.Content value="mcp" forceMount className="settings-panel">
          <SectionHeading title="MCP servers">
            Manage tool connections on this host. Restart the server to activate saved changes.
          </SectionHeading>
          <McpSettings
            active={section === "mcp"}
            client={session.client}
            openUrl={openUrl}
            restart={() => connections.restart()}
          />
        </Tabs.Content>
        <Tabs.Content value="providers" forceMount className="settings-panel">
          <AddLiteLLM disconnected={disconnected} active={section === "providers"} />
          <div className="settings-stack providers-stack">
            {settings.providers.map((provider) => (
              <Provider
                local={connections.local}
                disconnected={disconnected}
                restartButton={restartButton}
                key={provider.id}
                provider={provider}
              />
            ))}
            {session.authUrl && (
              <div className="auth-url settings-group">
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
          </div>
        </Tabs.Content>
        <Tabs.Content value="worktrees" forceMount className="settings-panel">
          <SectionHeading title="Worktrees" />
          <div className="settings-stack">
            <SettingsGroup title="Checkout location">
              <AutoSaveForm
                preference="worktree-directory"
                className="server-settings"
                disabled={disconnected}
              >
                <Input type="hidden" name="intent" value="worktree-directory" />
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
              </AutoSaveForm>
            </SettingsGroup>
            {section === "worktrees" && (
              <>
                <SettingsGroup title="Managed checkouts">
                  <ManagedWorktrees session={session} />
                </SettingsGroup>
                <ManagedDockerEnvironments session={session} />
              </>
            )}
          </div>
        </Tabs.Content>
        <Tabs.Content value="application" forceMount className="settings-panel">
          <SectionHeading title="Application">Server lifecycle and local storage.</SectionHeading>
          <div className="settings-stack application-settings">
            <SettingsGroup title="Server lifecycle">
              <AutoSaveForm
                preference="server-settings"
                className="server-settings"
                disabled={disconnected}
              >
                <Input type="hidden" name="intent" value="server-settings" />
                <Checkbox
                  label="Keep this server running after desktop exit"
                  name="keepServerRunning"
                  defaultChecked={settings.settings.keepServerRunning}
                  disabled={disconnected}
                />
                <p className="muted">
                  Saved on {connections.label}. When off, exit stops this server unless another
                  client is connected.
                </p>
              </AutoSaveForm>
            </SettingsGroup>
            <DesktopUpdates />
            <SettingsGroup title="Harness home" className="storage-location">
              <p className="muted">{settings.home}</p>
            </SettingsGroup>
            <SettingsGroup title="Restart server">{restartButton}</SettingsGroup>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}
function AddLiteLLM({ disconnected, active }: { disconnected: boolean; active: boolean }) {
  const save = useFetcher<ActionResult | GatewayCreatedError>();
  const trigger = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const busy = save.state !== "idle";
  const completed = !busy && save.data && (save.data.ok || "gatewayCreated" in save.data);
  const open = active && editing && !completed;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) save.reset();
        setEditing(next);
      }}
    >
      <div className="settings-heading-actions">
        <SectionHeading title="Providers">
          Credentials use Harness’s existing credential store. Provider changes take effect after a
          restart.
        </SectionHeading>
        <Dialog.Trigger asChild>
          <Button ref={trigger} disabled={busy || disconnected}>
            Add gateway
          </Button>
        </Dialog.Trigger>
      </div>
      {!open && <ActionFeedback data={save.data} />}
      <Dialog.Content maxWidth="30rem" returnFocusRef={trigger}>
        <Dialog.Title>Add LiteLLM gateway</Dialog.Title>
        <Dialog.Description>
          Connect a LiteLLM endpoint to this server. Leave the key blank to add credentials later.
        </Dialog.Description>
        <save.Form
          method="post"
          action="/actions"
          className="gateway-fields"
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
          {!busy && <ActionFeedback data={save.data} />}
          <div className="button-row gateway-actions">
            <Dialog.Close>
              <Button disabled={busy}>Cancel</Button>
            </Dialog.Close>
            <Button type="submit" variant="accent" disabled={busy || disconnected}>
              {busy ? "Adding…" : "Add gateway"}
            </Button>
          </div>
        </save.Form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function AuxiliaryModelFields({
  models,
  providers,
  model,
  prefix,
  label,
}: {
  models: ModelInfo[];
  providers: AppSettings["providers"];
  model: AppSettings["settings"]["autoApproval"]["model"];
  prefix: "reviewer" | "title";
  label: string;
}) {
  const [selection, setSelection] = useState(model ? modelKey(model.provider, model.model) : "");
  const presets =
    models.find((entry) => modelKey(entry.provider, entry.model) === selection)?.presets ?? [];
  const initialPreset =
    model && selection === modelKey(model.provider, model.model) ? (model.preset ?? "") : "";
  return (
    <>
      <label>
        {label} model
        <ModelSelect
          label={`${label} model`}
          models={models}
          providers={providers}
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
