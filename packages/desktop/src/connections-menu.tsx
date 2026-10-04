import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Dialog } from "@radix-ui/themes";
import { hostSchema, type Host } from "@harness/connections";
import { connectionCommand } from "./transport.ts";
import { DesktopHosts } from "./hosts.ts";
import { Button } from "./ui.tsx";

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
}: {
  hosts: DesktopHosts;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  useSyncExternalStore(hosts.subscribe, hosts.snapshot);

  const [editing, setEditing] = useState<Host>();
  const [distributions, setDistributions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const current = hosts.selected;
  const active = useRef<AbortController | null>(null);
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
      runtime: { source: "managed" as const },
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
      const runtime = {
        source: value(form, "source"),
      };
      const host = hostSchema.parse(
        editing.kind === "local"
          ? { ...common, kind: "local" }
          : editing.kind === "wsl"
            ? {
                ...common,
                kind: "wsl",
                distribution: value(form, "distribution"),
                user: optional(form, "user"),
                runtime,
              }
            : {
                ...common,
                kind: "ssh",
                destination: value(form, "destination"),

                runtime,
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
        <Dialog.Content maxWidth="700px">
          <Dialog.Title>Agent command center</Dialog.Title>
          <Dialog.Description>
            Connections are shared by this computer’s desktop and TUI. Each host runs its own agents
            and settings.
          </Dialog.Description>
          <div className="connections-layout">
            <nav aria-label="Saved connections" className="saved-connections">
              {hosts.config?.hosts.map((host) => (
                <Button
                  key={host.id}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(host);
                    setError(undefined);
                  }}
                >
                  {host.label}
                </Button>
              ))}
              <Button type="button" disabled={busy} onClick={() => create("wsl")}>
                Add WSL
              </Button>
              <Button type="button" disabled={busy} onClick={() => create("ssh")}>
                Add SSH
              </Button>
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
                  <input name="label" required maxLength={100} defaultValue={editing.label} />
                </label>
                {editing.kind === "wsl" && (
                  <>
                    <label>
                      Distribution
                      <input
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
                      <input name="user" defaultValue={editing.user ?? ""} />
                    </label>
                  </>
                )}
                {editing.kind === "ssh" && (
                  <>
                    <label>
                      SSH destination
                      <input
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
                {editing.kind !== "local" && (
                  <label>
                    Runtime
                    <select name="source" defaultValue={editing.runtime.source}>
                      <option value="managed">Managed portable runtime</option>
                      <option value="development">Use host’s Node (development)</option>
                    </select>
                  </label>
                )}
                <div className="button-row">
                  <Button type="submit" value="save" disabled={busy}>
                    Save
                  </Button>
                  <Button type="submit" value="test" disabled={busy}>
                    Save & test
                  </Button>
                  <Button type="submit" value="connect" className="primary" disabled={busy}>
                    Save & connect
                  </Button>
                  {editing.kind !== "local" && (
                    <Button
                      type="button"
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
                <h3>{current?.host.label}</h3>
                <p>
                  {current?.session && !current.session.disconnected ? "Connected" : "Disconnected"}
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
                  {current?.host.kind !== "local" && (
                    <Button
                      disabled={busy}
                      onClick={() => act(() => hosts.refresh(hosts.config!.selectedHostId))}
                    >
                      Upload current build
                    </Button>
                  )}
                  <Button
                    disabled={busy || !current?.identity}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Stop this host’s server and its agents for every connected client?",
                        )
                      )
                        act(() => hosts.stop(hosts.config!.selectedHostId));
                    }}
                  >
                    Stop server
                  </Button>
                  <Button
                    disabled={busy || !current?.identity}
                    onClick={() => {
                      if (window.confirm("Restart this host’s server for every connected client?"))
                        act(() => hosts.restart(hosts.config!.selectedHostId));
                    }}
                  >
                    Restart server
                  </Button>
                </div>
                {current?.runtime && current.identity?.buildId !== current.runtime.buildId && (
                  <p>New build ready. Restart the server to use it.</p>
                )}
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
          <label className="background-preference">
            <input
              type="checkbox"
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
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Dialog.Close>
            <Button type="button">Done</Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

export function HostControls({ hosts, onManage }: { hosts: DesktopHosts; onManage: () => void }) {
  useSyncExternalStore(hosts.subscribe, hosts.snapshot);
  const [error, setError] = useState<string>();
  return (
    <div className="host-controls">
      <label className="host-selector">
        Host
        <select
          aria-label="Selected host"
          value={hosts.config?.selectedHostId ?? "local"}
          onChange={(event) => {
            setError(undefined);
            void hosts.select(event.target.value).catch((cause) => setError(message(cause)));
          }}
        >
          {hosts.config?.hosts.map((host) => {
            const view = hosts.views.get(host.id);
            const pending = [...(view?.session?.views.values() ?? [])].some(
              (item) => item.approvals.size > 0,
            );
            const running = [...(view?.session?.views.values() ?? [])].some(
              (item) => item.state.turn.status === "running",
            );
            return (
              <option key={host.id} value={host.id}>
                {host.label}
                {pending
                  ? " · Approval"
                  : running
                    ? " · Running"
                    : view?.session && !view.session.disconnected
                      ? " · Connected"
                      : ""}
              </option>
            );
          })}
        </select>
      </label>
      <Button type="button" onClick={onManage}>
        Manage connections
      </Button>
      {hosts.selected?.progress && <small role="status">{hosts.selected.progress}</small>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
