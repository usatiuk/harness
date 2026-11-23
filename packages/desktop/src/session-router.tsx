import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { createHashRouter, parsePath, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { APP_NAME } from "./app-name.ts";
import { legacySettingsTarget } from "./routes/settings-location.ts";
import { PreferenceWrites } from "./components/auto-save-form.tsx";

export function sessionBasename(storageKey: string): string {
  // Router basenames are case-insensitive; configured host identities aren't.
  const bytes = new TextEncoder().encode(storageKey);
  return `/hosts/${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function withinSession(pathname: string, basename: string): boolean {
  return pathname === basename || pathname.startsWith(basename + "/");
}

export function createSessionRouter(routes: RouteObject[], storageKey: string) {
  const basename = sessionBasename(storageKey);
  const router = createHashRouter(routes, { basename });
  const { pathname, search } = router.state.location;
  if (!withinSession(pathname, basename)) {
    // A connection switch pushes a real entry; only bootstrap replaces the
    // empty/legacy unscoped URL. A legacy Settings link names a panel, not a
    // server record; never replay an unscoped conversation ID on another host.
    const target =
      pathname === "/settings" ? pathname + search : (localStorage.getItem(storageKey) ?? "/");
    // Migrate a saved query before the push: a replacement redirect during
    // the switch would replace the previous host's last history entry.
    const saved = parsePath(target);
    const migrated =
      saved.pathname === "/settings" ? legacySettingsTarget(saved.search) : undefined;
    void router.navigate(migrated ?? target, {
      replace: !pathname.startsWith("/hosts/"),
    });
  }
  return Object.assign(router, { preferenceWrites: new Map<string, () => Promise<void>>() });
}

export function SessionRouter({
  router,
  storageKey,
  controls,
  label,
}: {
  router: ReturnType<typeof createSessionRouter>;
  storageKey: string;
  controls: ReactNode;
  label: string;
}) {
  const basename = sessionBasename(storageKey);
  const scope = useSyncExternalStore(
    (notify) => router.subscribe(notify),
    () => {
      if (withinSession(router.state.location.pathname, basename)) return "active";
      const next = router.state.navigation.location;
      return next && withinSession(next.pathname, basename) ? "opening" : "other";
    },
  );
  useEffect(
    () => () => {
      router.preferenceWrites.clear();
      router.dispose();
    },
    [router],
  );
  if (scope === "active")
    return (
      <PreferenceWrites.Provider value={router.preferenceWrites}>
        <RouterProvider router={router} />
      </PreferenceWrites.Provider>
    );
  if (scope === "opening") return <div className="startup">Loading {APP_NAME}…</div>;
  return (
    <div className="app">
      <aside className="sidebar">{controls}</aside>
      <main className="connection-page">
        <section className="connection-empty-state">
          <h1>This page belongs to another connection</h1>
          <p>Select its connection to open this page.</p>
          <a href={`#${basename}${localStorage.getItem(storageKey) ?? "/"}`}>Return to {label}</a>
        </section>
      </main>
    </div>
  );
}
