import { afterEach, expect, it, vi } from "vitest";
import { createMemoryRouter, redirect } from "react-router";
import { persistDesktopRoute } from "./route-persistence.ts";

afterEach(() => vi.unstubAllGlobals());

function browser(hash = "") {
  const location = { hash };
  const replaceState = vi.fn((_data: unknown, _unused: string, url: string) => {
    location.hash = url;
  });
  const setItem = vi.fn();
  vi.stubGlobal("window", { location, history: { replaceState } });
  vi.stubGlobal("localStorage", { setItem });
  return { location, replaceState, setItem };
}

it("ignores fetcher cleanup, background actions and revalidation for an unchanged URL", async () => {
  const { location, replaceState, setItem } = browser();
  const router = createMemoryRouter(
    [
      { id: "conversation", path: "/conversations/:id", loader: () => null },
      { path: "/actions", action: () => ({ ok: true }) },
      { path: "/settings", loader: () => null },
      { path: "/", loader: () => redirect("/conversations/first") },
    ],
    { initialEntries: ["/conversations/first"] },
  );
  const unsubscribe = persistDesktopRoute(router, "host:first:route");
  try {
    await router.revalidate();
    for (let index = 0; index < 120; index++) {
      // Virtualized message fork buttons dispose idle fetchers when scrolled out.
      const key = `fork-${index}`;
      router.getFetcher(key);
      router.deleteFetcher(key);
    }
    for (let index = 0; index < 40; index++) {
      const formData = new FormData();
      formData.set("intent", "older");
      await router.fetch("older-history", "conversation", "/actions", {
        formMethod: "post",
        formData,
      });
      await router.revalidate();
    }
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledTimes(1);

    await router.navigate("/conversations/second");
    await router.navigate("/settings?section=appearance");
    await router.navigate("/settings?section=providers");
    await router.navigate("/settings?section=providers", { replace: true });
    expect(setItem).toHaveBeenCalledTimes(4);
    expect(replaceState).toHaveBeenCalledTimes(4);
    expect(location.hash).toBe("#/settings?section=providers");

    await router.navigate(-1);
    expect(location.hash).toBe("#/settings?section=appearance");
    await router.navigate("/");
    expect(location.hash).toBe("#/conversations/first");
    expect(setItem).toHaveBeenLastCalledWith("host:first:route", "/conversations/first");

    unsubscribe();
    replaceState.mockClear();
    await router.navigate("/settings");
    expect(replaceState).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    router.dispose();
  }
});

it("restores host routes on mount without replacing an already matching URL", () => {
  const { location, replaceState, setItem } = browser("#/conversations/first");
  for (const host of ["first", "second", "first"]) {
    const router = createMemoryRouter([{ path: "/conversations/:id" }], {
      initialEntries: [`/conversations/${host}`],
    });
    const unsubscribe = persistDesktopRoute(router, `host:${host}:route`);
    expect(location.hash).toBe(`#/conversations/${host}`);
    expect(setItem).toHaveBeenLastCalledWith(`host:${host}:route`, `/conversations/${host}`);
    unsubscribe();
    router.dispose();
  }
  expect(replaceState).toHaveBeenCalledTimes(2);
});
