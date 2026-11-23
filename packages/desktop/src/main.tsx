import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { DesktopSession } from "./session.ts";
import { DesktopHosts, type HostView } from "./hosts.ts";
import { ConnectionEditor, HostControls } from "./connections-menu.tsx";
import { createDesktopRouter } from "./routes.tsx";
import { SessionRouter } from "./session-router.tsx";
import { Button, Tooltip } from "./ui.tsx";
import { Monitor, LoaderCircle, TriangleAlert } from "lucide-react";
import { WindowShell } from "./window-shell.tsx";
import { APP_NAME } from "./app-name.ts";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Desktop document is missing its root");
const root = createRoot(container);
const hosts = new DesktopHosts();

function HostLabel({ view }: { view: HostView }) {
  return useSyncExternalStore(hosts.subscribe, () => view.host.label);
}

function SessionRoutes({
  view,
  session,
  onManage,
  hostTrigger,
}: {
  view: HostView;
  session: DesktopSession;
  onManage: () => void;
  hostTrigger: RefObject<HTMLButtonElement | null>;
}) {
  const router = useMemo(
    () =>
      createDesktopRouter(session, {
        controls: <HostControls hosts={hosts} onManage={onManage} triggerRef={hostTrigger} />,
        local: view.host.kind === "local",
        label: <HostLabel view={view} />,
        restart: () => hosts.restart(view.host.id),
      }),
    [session, view, onManage, hostTrigger],
  );
  return (
    <SessionRouter
      router={router}
      storageKey={session.storageKey("route")}
      label={view.host.label}
      controls={<HostControls hosts={hosts} onManage={onManage} triggerRef={hostTrigger} />}
    />
  );
}
function Desktop() {
  useSyncExternalStore(hosts.subscribe, hosts.snapshot);
  const [error, setError] = useState<string>();
  const [editingConnections, setEditingConnections] = useState(false);
  const hostTrigger = useRef<HTMLButtonElement>(null);
  const onManage = useCallback(() => setEditingConnections(true), []);
  const initialize = useCallback(() => {
    void hosts
      .initialize()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  useEffect(initialize, [initialize]);
  const view = hosts.selected;
  const content =
    view?.session && !view.session.disconnected ? (
      <SessionRoutes
        key={view.host.id}
        view={view}
        session={view.session}
        onManage={onManage}
        hostTrigger={hostTrigger}
      />
    ) : (
      <div className="app">
        <aside className="sidebar">
          <HostControls hosts={hosts} onManage={onManage} triggerRef={hostTrigger} />
        </aside>
        <main className="connection-page">
          <section className="connection-empty-state">
            {error ? (
              <TriangleAlert size={22} aria-hidden="true" />
            ) : view?.progress || !hosts.config ? (
              <LoaderCircle size={22} className="loading-icon" aria-hidden="true" />
            ) : (
              <Monitor size={22} aria-hidden="true" />
            )}
            <h1>
              {hosts.config
                ? `${view?.host.label ?? "Host"} connection`
                : error
                  ? `Could not start ${APP_NAME}`
                  : `Starting ${APP_NAME}…`}
            </h1>
            <p className="muted">
              {error && !hosts.config
                ? "Check the configuration, then try again."
                : view?.progress || !hosts.config
                  ? "Getting your workspace ready."
                  : "Reconnect to continue your conversations."}
            </p>
            {(error ?? view?.error) && (
              <p role="alert" className="error">
                {error ?? view?.error}
              </p>
            )}
            {!hosts.config && error && (
              <Button
                onClick={() => {
                  setError(undefined);
                  initialize();
                }}
              >
                Retry startup
              </Button>
            )}
            {view?.progress ? (
              <>
                <p role="status">{view.progress}</p>
                <Button onClick={() => hosts.cancel(view.host.id)}>Cancel connection</Button>
              </>
            ) : (
              hosts.config && (
                <Button
                  onClick={() => {
                    setError(undefined);
                    void hosts
                      .reconnect(hosts.config!.selectedHostId)
                      .catch((cause: unknown) =>
                        setError(cause instanceof Error ? cause.message : String(cause)),
                      );
                  }}
                >
                  Reconnect
                </Button>
              )
            )}
          </section>
        </main>
      </div>
    );
  return (
    <>
      <ConnectionEditor
        hosts={hosts}
        open={editingConnections}
        setOpen={setEditingConnections}
        returnFocusRef={hostTrigger}
      />
      {content}
    </>
  );
}
root.render(
  <Tooltip.Provider delayDuration={300}>
    <WindowShell>
      <Desktop />
    </WindowShell>
  </Tooltip.Provider>,
);
