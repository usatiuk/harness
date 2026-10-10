import { useRef, useState, useSyncExternalStore, type FormEvent, type RefObject } from "react";
import { hostSchema, type Host } from "@harness/connections";
import { connectionCommand } from "./transport.ts";
import { DesktopHosts } from "./hosts.ts";
import {
  Button,
  Dialog,
  Input,
  Checkbox,
  PopoverControl,
  Confirmation,
  Disclosure,
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
  const [distributions, setDistributions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    hostId: string;
    operation: "stop" | "restart";
  }>();
  const current = hosts.selected;
  const active = useRef<AbortController | null>(null);
  const done = useRef<HTMLButtonElement>(null);
  const act = (operation: (signal: AbortSignal) => Promise<void>): void => {
    const abort = new AbortController();
    active.current = abort;
    setBusy(true);
    setError(undefined);
    void operation(abort.signal)
      .catch((cause) => setError(message(cause)))
      .finally(() => {
        active.current = null;
        setBusy(false);
      });
  };
  const discover = async (signal: AbortSignal): Promise<void> => {
    const result = await connectionCommand({ type: "wsl.list" }, undefined, signal);
    setDistributions(result);
  };
  const create = (kind: "ssh" | "wsl"): void => {
    const common = {
      id: crypto.randomUUID(),
      label: kind === "wsl" ? "WSL" : "SSH",
    };
    setEditing(
      kind === "wsl"
        ? { ...common, kind, distribution: distributions[0] ?? "", user: null }
        : { ...common, kind, destination: "" },
    );
    if (kind === "wsl") act(discover);
  };
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const connect = submitter?.getAttribute("value") === "connect";
    const test = submitter?.getAttribute("value") === "test";
    act(async () => {
      if (!editing) throw new Error("No connection selected");
      const common = { id: editing.id, label: value(form, "label") };
      const host = hostSchema.parse(
        editing.kind === "local"
          ? { ...common, kind: "local" }
          : editing.kind === "wsl"
            ? {
                ...common,
                kind: "wsl",
                distribution: value(form, "distribution"),
                user: optional(form, "user"),
              }
            : {
                ...common,
                kind: "ssh",
                destination: value(form, "destination"),
              },
      );
      await hosts.edit({ type: "host.save", host });
      if (test) await hosts.connect(host.id);
      if (connect) {
        await hosts.select(host.id);
        setOpen(false);
      }
      setEditing(host);
    });
  };
  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setEditing(undefined);
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
              {hosts.config?.hosts.map((host) => (
                <button
                  key={host.id}
                  type="button"
                  className="selection-item"
                  aria-pressed={(editing?.id ?? current?.host.id) === host.id}
                  disabled={busy}
                  onClick={() => {
                    setEditing(host);
                    setError(undefined);
                  }}
                >
                  {host.label}
                </button>
              ))}
              <div className="connection-additions">
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
                <h3>
                  {editing.kind === "local"
                    ? "Local"
                    : editing.kind === "wsl"
                      ? "WSL connection"
                      : "SSH connection"}
                </h3>
                <label>
                  Name
                  <Input name="label" required maxLength={100} defaultValue={editing.label} />
                </label>
                {editing.kind === "wsl" && (
                  <>
                    <label>
                      Distribution
                      <Input
                        name="distribution"
                        list="wsl-distributions"
                        required
                        defaultValue={editing.distribution}
                      />
                    </label>
                    <datalist id="wsl-distributions">
                      {distributions.map((distro) => (
                        <option key={distro} value={distro} />
                      ))}
                    </datalist>
                    <Button type="button" disabled={busy} onClick={() => act(discover)}>
                      Discover distributions
                    </Button>
                    <label>
                      Linux user (optional)
                      <Input name="user" defaultValue={editing.user ?? ""} />
                    </label>
                  </>
                )}
                {editing.kind === "ssh" && (
                  <>
                    <label>
                      SSH destination
                      <Input
                        name="destination"
                        required
                        placeholder="user@workstation or SSH alias"
                        defaultValue={editing.destination}
                      />
                    </label>
                    <p>
                      Uses non-interactive OpenSSH authentication. Configure keys, ports and host
                      aliases in .ssh/config.
                    </p>
                  </>
                )}
                <div className="button-row">
                  <Button type="submit" value="save" disabled={busy}>
                    Save
                  </Button>
                  <Button type="submit" value="test" disabled={busy}>
                    Save & test
                  </Button>
                  <Button type="submit" value="connect" variant="accent" disabled={busy}>
                    Save & connect
                  </Button>
                  {editing.kind !== "local" && (
                    <Button
                      type="button"
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          await hosts.edit({ type: "host.remove", id: editing.id });
                          setEditing(undefined);
                        })
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>
                {hosts.views.get(editing.id)?.progress && (
                  <p role="status">{hosts.views.get(editing.id)?.progress}</p>
                )}
                {hosts.views.get(editing.id)?.identity && (
                  <p className="muted">
                    Connection ready · {hosts.views.get(editing.id)?.identity?.platform}
                  </p>
                )}
              </form>
            ) : (
              <div className="connection-editor">
                <div className="connection-overview-heading">
                  <h3>{current?.host.label}</h3>
                  <p className="connection-state">
                    {current?.session && !current.session.disconnected
                      ? "Connected"
                      : "Disconnected"}
                  </p>
                </div>
                <p className="muted">
                  {current?.host.kind === "local"
                    ? "Run agents on this computer."
                    : "A separate host for your agents and projects."}
                </p>
                <div className="button-row">
                  <Button
                    disabled={busy}
                    onClick={() => act(() => hosts.reconnect(hosts.config!.selectedHostId))}
                  >
                    Reconnect
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => act(() => hosts.disconnect(hosts.config!.selectedHostId))}
                  >
                    Disconnect
                  </Button>
                </div>
                <Disclosure title="Server actions" className="server-actions">
                  <p className="muted">These actions affect every client connected to this host.</p>
                  <div className="button-row">
                    {current?.host.kind !== "local" && (
                      <Button
                        disabled={busy}
                        onClick={() => act(() => hosts.refresh(hosts.config!.selectedHostId))}
                      >
                        Upload current build
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      disabled={busy || !current?.identity}
                      onClick={() =>
                        setConfirmation({ hostId: hosts.config!.selectedHostId, operation: "stop" })
                      }
                    >
                      Stop server
                    </Button>
                    <Button
                      disabled={busy || !current?.identity}
                      onClick={() =>
                        setConfirmation({
                          hostId: hosts.config!.selectedHostId,
                          operation: "restart",
                        })
                      }
                    >
                      Restart server
                    </Button>
                  </div>
                  {current?.runtime && current.identity?.buildId !== current.runtime.buildId && (
                    <p>New build ready. Restart the server to use it.</p>
                  )}
                </Disclosure>
              </div>
            )}
          </div>
          {busy && (
            <Button
              onClick={() => {
                active.current?.abort();
                hosts.cancel(editing?.id ?? hosts.config!.selectedHostId);
              }}
            >
              Cancel connection
            </Button>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="connections-footer">
            <label className="background-preference">
              <Checkbox
                checked={hosts.config?.desktop.keepServerRunning ?? false}
                disabled={busy}
                onChange={(event) =>
                  act(() =>
                    hosts.edit({ type: "preferences", keepServerRunning: event.target.checked }),
                  )
                }
              />
              Keep the local server running after desktop exit
            </label>
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
        description="This affects agents and work for every client connected to this host. Conversation history is saved."
        confirmLabel={confirmation?.operation === "stop" ? "Stop server" : "Restart server"}
        onConfirm={() => {
          if (!confirmation) throw new Error("Missing server confirmation intent");
          const intent = confirmation;
          act(() =>
            intent.operation === "stop" ? hosts.stop(intent.hostId) : hosts.restart(intent.hostId),
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
            className="host-trigger"
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
