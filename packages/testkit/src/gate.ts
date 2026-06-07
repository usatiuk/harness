/** Resolves when `released` settles, or immediately when `signal` aborts. */
export const awaitReleaseOrAbort = (released: Promise<void>, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    void released.then(resolve);
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
