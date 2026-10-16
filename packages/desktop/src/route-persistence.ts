import type { createMemoryRouter } from "react-router";

export function persistDesktopRoute(
  router: ReturnType<typeof createMemoryRouter>,
  storageKey: string,
): () => void {
  let previousRoute: string | undefined;
  const persist = () => {
    const { pathname, search } = router.state.location;
    const route = pathname + search;
    // Fetcher cleanup and revalidation also notify subscribers without navigation.
    if (route === previousRoute) return;
    localStorage.setItem(storageKey, route);
    if (window.location.hash !== `#${route}`) window.history.replaceState(null, "", `#${route}`);
    previousRoute = route;
  };
  persist();
  return router.subscribe(persist);
}
