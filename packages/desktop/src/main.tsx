import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RouterProvider } from "react-router/dom";
import { DesktopSession } from "./session.ts";
import { DesktopHosts, type HostView } from "./hosts.ts";
import { ConnectionEditor, HostControls } from "./connections-menu.tsx";
import { createDesktopRouter } from "./routes.tsx";
import { Theme } from "@radix-ui/themes";
import { Button } from "./ui.tsx";
import "./appearance.ts";
import "@radix-ui/themes/styles.css";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Desktop document is missing its root");
const root = createRoot(container);
const themed = (content: ReactNode) => (
  <Theme accentColor="blue" grayColor="slate" radius="small" scaling="95%">
    {content}
  </Theme>
);
const hosts = new DesktopHosts();

function SessionRoutes({
  view,
  onManage,
}: {
  view: HostView & { session: DesktopSession };
  onManage: () => void;
}) {
  const session = view.session;
  const router = useMemo(
    () =>
      createDesktopRouter(session, {
        controls: <HostControls hosts={hosts} onManage={onManage} />,
        local: view.host.kind === "local",
        label: view.host.label,
        restart: () => hosts.restart(view.host.id),
      }),
    [session, view.host.id, view.host.kind, view.host.label, onManage],
  );
  useEffect(() => {
    const unsubscribe = router.subscribe((state) => {
      const route = state.location.pathname + state.location.search;
      localStorage.setItem(session.storageKey("route"), route);
      window.history.replaceState(null, "", `#${route}`);
    });
    return () => {
      unsubscribe();
      router.dispose();
    };
  }, [router, session]);
  return <RouterProvider router={router} />;
}
function Desktop() {
  useSyncExternalStore(hosts.subscribe, hosts.snapshot);
  const [error, setError] = useState<string>();
  const [editingConnections, setEditingConnections] = useState(false);
  const onManage = useCallback(() => setEditingConnections(true), []);
  useEffect(() => {
    void hosts
      .initialize()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  const view = hosts.selected;
  const content =
    view?.session && !view.session.disconnected ? (
      <SessionRoutes
        key={view.host.id}
        view={{ ...view, session: view.session }}
        onManage={onManage}
      />
    ) : (
      <div className="app">
        <aside className="sidebar">
          <div className="brand">Harness</div>
          <HostControls hosts={hosts} onManage={onManage} />
        </aside>
        <main className="page">
          <h1>{hosts.config ? `${view?.host.label ?? "Host"} connection` : "Starting Harness…"}</h1>
          {(error ?? view?.error) && (
            <p role="alert" className="error">
              {error ?? view?.error}
            </p>
          )}
          {view?.progress ? (
            <p role="status">{view.progress}</p>
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
        </main>
      </div>
    );
  return (
    <>
      <ConnectionEditor hosts={hosts} open={editingConnections} setOpen={setEditingConnections} />
      {content}
    </>
  );
}
root.render(themed(<Desktop />));
