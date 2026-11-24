import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type ReactNode,
} from "react";
import { DesktopSession } from "./session.ts";
import { DesktopHosts, type HostView } from "./hosts.ts";
import { ConnectionEditor, HostControls } from "./connections-menu.tsx";
import { createDesktopRouter } from "./routes.tsx";
import { SessionRouter } from "./session-router.tsx";
import { Tooltip } from "./ui.tsx";
import { StartupProgress } from "./components/startup-progress.tsx";
import { WindowShell } from "./window-shell.tsx";

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
  opening,
}: {
  opening: ReactNode;
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
  const opened = useCallback(() => view.attempt?.finish(), [view]);
  return (
    <SessionRouter
      router={router}
      opening={opening}
      onOpened={opened}
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
  const startup = (
    <div className="app">
      <aside className="sidebar">
        <HostControls hosts={hosts} onManage={onManage} triggerRef={hostTrigger} />
      </aside>
      <main className="connection-page">
        <StartupProgress
          settingsLocation={view?.host.kind === "local" ? "local" : view?.runtime?.home}
          host={view?.host.label ?? "Workspace"}
          attempt={view?.attempt ?? hosts.boot}
          busy={
            !!(view?.session && !view.session.disconnected) ||
            !!view?.progress ||
            (!hosts.config && !error)
          }
          error={error ?? view?.error}
          cancel={() =>
            view?.session ? void hosts.disconnect(view.host.id) : hosts.cancel(view?.host.id)
          }
          retry={() => {
            setError(undefined);
            if (!view) initialize();
            else void hosts.reconnect(view.host.id).catch(() => undefined);
          }}
        />
      </main>
    </div>
  );
  const content =
    view?.session && !view.session.disconnected ? (
      <SessionRoutes
        key={view.host.id}
        opening={startup}
        view={view}
        session={view.session}
        onManage={onManage}
        hostTrigger={hostTrigger}
      />
    ) : (
      startup
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
