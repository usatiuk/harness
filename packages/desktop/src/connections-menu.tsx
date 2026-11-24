import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type RefObject,
} from "react";
import { hostSchema, type Host } from "@harness/connections";
import { connectionCommand } from "./transport.ts";
import { sessionBasename } from "./session-router.tsx";
import { StartupDetails } from "./components/startup-progress.tsx";
import { DesktopHosts } from "./hosts.ts";
import {
  Button,
  Dialog,
  Input,
  PopoverControl,
  Confirmation,
  Disclosure,
  Select,
  SelectItem,
} from "./ui.tsx";
import { ChevronDown, Monitor } from "lucide-react";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const value = (form: FormData, key: string): string => {
  const result = form.get(key);
  if (result === null) return "";
  if (typeof result !== "string") throw new Error(`Expected text for ${key}`);
  return result.trim();
};
const optional = (form: FormData, key: string): string | null => value(form, key) || null;

function WslDestination({
  value,
  distributions,
  change,
  discover,
  busy,
}: {
  value: string;
  distributions: string[] | undefined;
  change: (value: string) => void;
  discover: () => void;
  busy: boolean;
}) {
  const [manual, setManual] = useState(false);
  const listed = !!distributions?.length && !manual && (!value || distributions.includes(value));
  return (
    <div className="field-stack">
      <label>
        Distribution
        {listed ? (
          <Select
            aria-label="Distribution"
            value={value ? `distro:${value}` : ""}
            onValueChange={(next) => {
              if (next === "manual") {
                setManual(true);
                change("");
              } else {
                change(next.slice("distro:".length));
              }
            }}
          >
            <SelectItem value="" disabled>
              Choose an installed distribution
            </SelectItem>
            {distributions.map((distro) => (
              <SelectItem key={distro} value={`distro:${distro}`}>
                {distro}
              </SelectItem>
            ))}
            <SelectItem value="manual">Enter a different name…</SelectItem>
          </Select>
        ) : (
          <Input
            autoFocus
            required
            aria-describedby="wsl-distribution-hint"
            value={value}
            onChange={(event) => change(event.currentTarget.value)}
          />
        )}
      </label>
      <div className="connection-discovery">
        <p id="wsl-distribution-hint" className="field-hint muted">
          {listed
            ? "Installed on this computer."
            : distributions?.length === 0
              ? "None discovered. Enter a distribution name."
              : "Enter the name of an installed WSL distribution."}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setManual(false);
            discover();
          }}
        >
          Discover distributions
        </Button>
      </div>
    </div>
  );
}

export function ConnectionEditor({
  hosts,
  open,
  setOpen,
  returnFocusRef,
}: {
  hosts: DesktopHosts;
  open: boolean;
  setOpen: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  useSyncExternalStore(hosts.subscribe, hosts.snapshot);

  const [editing, setEditing] = useState<Host>();
  const [inspectedId, setInspectedId] = useState<string>();
  const [distributions, setDistributions] = useState<string[]>();
  const [pending, setPending] = useState<"working" | "cancellable" | "cancelling">();
  const busy = pending !== undefined;
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    host: Host;
    operation: "stop" | "restart";
  }>();
  const current = hosts.views.get(inspectedId ?? "") ?? hosts.selected;
  const connected = Boolean(current?.session && !current.session.disconnected);
  const selected = current?.host.id === hosts.config?.selectedHostId;
  const liveIdentity = connected ? current?.identity : undefined;
  const active = useRef<AbortController | null>(null);
  const done = useRef<HTMLButtonElement>(null);
  const editAction = useRef<HTMLButtonElement>(null);
  const restoreEditorFocus = useRef(false);
  const leaveEditor = () => {
    restoreEditorFocus.current = true;
    setEditing(undefined);
  };
  useLayoutEffect(() => {
    if (restoreEditorFocus.current && !editing && !busy) {
      if (open) editAction.current?.focus();
      restoreEditorFocus.current = false;
    }
  }, [editing, busy, open]);
  const saveDisabled = busy || (editing?.kind === "wsl" && !editing.distribution.trim());
  const act = (operation: (signal: AbortSignal) => Promise<void>, cancellable = false): void => {
    const abort = new AbortController();
    active.current = abort;
    setPending(cancellable ? "cancellable" : "working");
    setError(undefined);
    void operation(abort.signal)
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => {
        active.current = null;
        setPending(undefined);
      });
  };
  const cancelActive = () => {
    if (pending !== "cancellable" || !active.current) return;
    active.current.abort(new DOMException("Operation cancelled.", "AbortError"));
    setPending("cancelling");
  };
  const discover = async (signal: AbortSignal, hostId: string): Promise<void> => {
    const result = await connectionCommand({ type: "wsl.list" }, undefined, signal);
    signal.throwIfAborted();
    setDistributions(result);
    if (result.length === 1) {
      // Never replace a manual destination typed while discovery was pending.
      setEditing((draft) =>
        draft?.id === hostId && draft.kind === "wsl" && !draft.distribution
          ? { ...draft, distribution: result[0]! }
          : draft,
      );
    }
  };
  const create = (kind: "ssh" | "wsl"): void => {
    const common = {
      id: crypto.randomUUID(),
      label: kind === "wsl" ? "WSL" : "SSH",
    };
    setDistributions(undefined);
    setError(undefined);
    setEditing(
      kind === "wsl"
        ? { ...common, kind, distribution: "", user: null }
        : { ...common, kind, destination: "" },
    );
    if (kind === "wsl") act((signal) => discover(signal, common.id), true);
  };
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const connect = submitter?.getAttribute("value") === "connect";
    const test = submitter?.getAttribute("value") === "test";
    if (!editing) throw new Error("No connection selected");
    act(async (signal) => {
      const common = { id: editing.id, label: value(form, "label") };
      const host = hostSchema.parse(
        editing.kind === "local"
          ? { ...common, kind: "local" }
          : editing.kind === "wsl"
            ? {
                ...common,
                kind: "wsl",
                distribution: editing.distribution.trim(),
                user: optional(form, "user"),
              }
            : {
                ...common,
                kind: "ssh",
                destination: value(form, "destination"),
              },
      );
      await hosts.edit({ type: "host.save", host });
      signal.throwIfAborted();
      if (test) await hosts.connect(host.id, signal);
      if (connect) await hosts.select(host.id, signal);
      signal.throwIfAborted();
      if (connect) setOpen(false);
      setInspectedId(connect ? undefined : host.id);
      leaveEditor();
    }, test || connect);
  };
  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            cancelActive();
            setEditing(undefined);
            setInspectedId(undefined);
            setError(undefined);
          }
        }}
      >
        <Dialog.Content
          maxWidth="740px"
          className="connections-dialog"
          returnFocusRef={returnFocusRef}
        >
          <Dialog.Title>Connections</Dialog.Title>
          <Dialog.Description>
            Choose where your agents run. Each host keeps its own conversations and settings.
          </Dialog.Description>
          <div className="connections-layout">
            <nav aria-label="Saved connections" className="saved-connections">
              <h3>Saved hosts</h3>
              {hosts.config?.hosts.map((host) => (
                <button
                  key={host.id}
                  type="button"
                  className="selection-item"
                  aria-pressed={(editing?.id ?? current?.host.id) === host.id}
                  disabled={busy}
                  onClick={() => {
                    setInspectedId(host.id);
                    setEditing(undefined);
                    setError(undefined);
                  }}
                >
                  {host.label}
                </button>
              ))}
              <div className="connection-additions">
                <h3>Add a host</h3>
                <Button type="button" size="sm" disabled={busy} onClick={() => create("wsl")}>
                  Add WSL
                </Button>
                <Button type="button" size="sm" disabled={busy} onClick={() => create("ssh")}>
                  Add SSH
                </Button>
              </div>
            </nav>
            {editing ? (
              <form key={editing.id} onSubmit={save} className="connection-editor">
                <header className="connection-overview-heading">
                  <h3>
                    {editing.kind === "local"
                      ? "Local connection"
                      : editing.kind === "wsl"
                        ? "WSL connection"
                        : "SSH connection"}
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      leaveEditor();
                      setError(undefined);
                    }}
                  >
                    Back
                  </Button>
                </header>
                {editing.kind === "wsl" && (
                  <WslDestination
                    value={editing.distribution}
                    distributions={distributions}
                    busy={busy}
                    change={(distribution) => setEditing({ ...editing, distribution })}
                    discover={() => act((signal) => discover(signal, editing.id), true)}
                  />
                )}
                {editing.kind === "ssh" && (
                  <div className="field-stack">
                    <label>
                      SSH destination
                      <Input
                        autoFocus
                        name="destination"
                        required
                        placeholder="user@workstation or SSH alias"
                        defaultValue={editing.destination}
                        aria-describedby="ssh-destination-hint"
                      />
                    </label>
                    <p className="field-hint muted" id="ssh-destination-hint">
                      Uses your OpenSSH keys and aliases from <code>~/.ssh/config</code>. Password
                      prompts are not supported.
                    </p>
                  </div>
                )}
                <label>
                  Name
                  <Input
                    autoFocus={editing.kind === "local"}
                    name="label"
                    required
                    maxLength={100}
                    defaultValue={editing.label}
                  />
                </label>
                {editing.kind === "wsl" && (
                  <Disclosure title="Advanced WSL settings">
                    <label>
                      Linux user (optional)
                      <Input
                        name="user"
                        defaultValue={editing.user ?? ""}
                        placeholder="Default distribution user"
                      />
                    </label>
                  </Disclosure>
                )}
                <div className="button-row connection-editor-actions">
                  <Button type="submit" value="save" disabled={saveDisabled}>
                    Save
                  </Button>
                  <Button type="submit" value="test" variant="ghost" disabled={saveDisabled}>
                    Save &amp; test
                  </Button>
                  <Button type="submit" value="connect" variant="accent" disabled={saveDisabled}>
                    Save &amp; connect
                  </Button>
                </div>
                {hosts.views.get(editing.id)?.progress && (
                  <p role="status">{hosts.views.get(editing.id)?.progress}</p>
                )}
                {editing.kind !== "local" && hosts.views.has(editing.id) && (
                  <div className="connection-remove">
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        act(async (signal) => {
                          await hosts.edit({ type: "host.remove", id: editing.id });
                          signal.throwIfAborted();
                          leaveEditor();
                          setInspectedId(undefined);
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </form>
            ) : current ? (
              <div key={current.host.id} className="connection-editor">
                <div className="connection-overview-heading">
                  <h3>{current.host.label}</h3>
                  <p className="connection-state">{connected ? "Connected" : "Disconnected"}</p>
                </div>
                <dl className="connection-facts">
                  <div>
                    <dt>
                      {current.host.kind === "ssh"
                        ? "SSH destination"
                        : current.host.kind === "wsl"
                          ? "WSL distribution"
                          : "Host"}
                    </dt>
                    <dd>
                      {current.host.kind === "ssh"
                        ? current.host.destination
                        : current.host.kind === "wsl"
                          ? current.host.distribution
                          : "This computer"}
                    </dd>
                  </div>
                  {current.host.kind === "wsl" && current.host.user && (
                    <div>
                      <dt>Linux user</dt>
                      <dd>{current.host.user}</dd>
                    </div>
                  )}
                  {liveIdentity && (
                    <div>
                      <dt>Server</dt>
                      <dd>
                        {liveIdentity.productVersion} · {liveIdentity.platform}
                      </dd>
                    </div>
                  )}
                </dl>
                <StartupDetails attempt={current.attempt}>
                  {connected && current === hosts.selected && current.session && (
                    <a
                      href={`#${sessionBasename(current.session.storageKey("route"))}/settings/mcp`}
                      onClick={() => setOpen(false)}
                    >
                      MCP settings
                    </a>
                  )}
                </StartupDetails>
                {current.progress && <p role="status">{current.progress}</p>}
                {current.error && !connected && !error && (
                  <p role="alert" className="error">
                    {current.error}
                  </p>
                )}
                <div className="connection-editor-actions button-row">
                  <Button
                    variant={connected && selected ? "neutral" : "accent"}
                    disabled={busy}
                    onClick={() =>
                      act(
                        (signal) =>
                          selected
                            ? hosts.reconnect(current.host.id, signal)
                            : hosts.select(current.host.id, signal),
                        true,
                      )
                    }
                  >
                    {selected ? "Reconnect" : "Switch to host"}
                  </Button>
                  {connected && (
                    <Button
                      disabled={busy}
                      onClick={() => act(() => hosts.disconnect(current.host.id))}
                    >
                      Disconnect
                    </Button>
                  )}
                  <Button
                    ref={editAction}
                    variant={connected && selected ? "accent" : "neutral"}
                    disabled={busy}
                    onClick={() => {
                      setEditing(current.host);
                      setError(undefined);
                    }}
                  >
                    Edit connection
                  </Button>
                </div>
                <Disclosure title="Server actions" className="server-actions">
                  <p className="muted">
                    Stopping or restarting the server interrupts work for every client on this host.
                  </p>
                  <div className="button-row">
                    {current.host.kind !== "local" && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          act((signal) => hosts.refresh(current.host.id, signal), true)
                        }
                      >
                        Upload current build
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      disabled={busy || !current.identity}
                      onClick={() => setConfirmation({ host: current.host, operation: "stop" })}
                    >
                      Stop server
                    </Button>
                    <Button
                      disabled={busy || !current.identity}
                      onClick={() =>
                        setConfirmation({
                          host: current.host,
                          operation: "restart",
                        })
                      }
                    >
                      Restart server
                    </Button>
                  </div>
                  {current.runtime &&
                    current.identity &&
                    current.identity.buildId !== current.runtime.buildId && (
                      <p>New build ready. Restart the server to use it.</p>
                    )}
                </Disclosure>
              </div>
            ) : null}
          </div>
          {pending === "cancellable" && <Button onClick={cancelActive}>Cancel connection</Button>}
          {pending === "cancelling" && <p role="status">Cancelling connection…</p>}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="connections-footer">
            <Dialog.Close>
              <Button ref={done} type="button">
                Done
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Root>
      <Confirmation
        acceptedFocusRef={done}
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined);
        }}
        title={confirmation?.operation === "stop" ? "Stop server?" : "Restart server?"}
        description={
          confirmation?.operation === "stop"
            ? `Stopping the server on ${confirmation.host.label} interrupts running work and disconnects every client. Conversation history is saved.`
            : `Restarting the server on ${confirmation?.host.label} interrupts running work and disconnects every client before this desktop reconnects. Conversation history is saved.`
        }
        confirmLabel={confirmation?.operation === "stop" ? "Stop server" : "Restart server"}
        onConfirm={() => {
          if (!confirmation) throw new Error("Missing server confirmation intent");
          const intent = confirmation;
          act(() =>
            intent.operation === "stop"
              ? hosts.stop(intent.host.id)
              : hosts.restart(intent.host.id),
          );
        }}
      />
    </>
  );
}

export function HostControls({
  hosts,
  onManage,
  triggerRef,
}: {
  hosts: DesktopHosts;
  onManage: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  useSyncExternalStore(hosts.subscribe, hosts.snapshot);
  const [error, setError] = useState<string>();
  return (
    <div className="host-controls">
      <PopoverControl
        label="Hosts"
        align="start"
        trigger={
          <Button
            ref={triggerRef}
            disabled={!hosts.config}
            variant="ghost"
            className="host-trigger chrome-control"
            aria-label={`Switch host: ${hosts.selected?.host.label ?? "Local"}`}
          >
            <Monitor size={14} aria-hidden="true" />
            <span className="host-label">{hosts.selected?.host.label ?? "Local"}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </Button>
        }
      >
        <h3>Hosts</h3>
        <div className="host-options">
          {hosts.config?.hosts.map((host) => {
            const view = hosts.views.get(host.id);
            const pending = [...(view?.session?.views.values() ?? [])].some(
              (item) => item.approvals.size > 0,
            );
            const running = [...(view?.session?.views.values() ?? [])].some(
              (item) => item.state.turn.status === "running",
            );
            return (
              <button
                key={host.id}
                type="button"
                className="host-option selection-item"
                aria-pressed={hosts.config?.selectedHostId === host.id}
                onClick={() => {
                  setError(undefined);
                  void hosts.select(host.id).catch((cause) => setError(message(cause)));
                }}
              >
                {host.label}
                <small className="muted">
                  {pending
                    ? "Approval"
                    : running
                      ? "Running"
                      : view?.session && !view.session.disconnected
                        ? "Connected"
                        : ""}
                </small>
              </button>
            );
          })}
        </div>
        <Button size="sm" onClick={onManage}>
          Manage connections
        </Button>
      </PopoverControl>
      {hosts.selected?.progress && <small role="status">{hosts.selected.progress}</small>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
