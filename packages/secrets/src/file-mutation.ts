import { resolve } from "node:path";

const mutations = new Map<string, Promise<void>>();

/** File-backed store instances share one read/modify/write lifetime per path. */
export function mutateCredentialFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const absolute = resolve(path);
  const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const result = (mutations.get(key) ?? Promise.resolve()).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  mutations.set(key, tail);
  void tail.then(() => {
    if (mutations.get(key) === tail) mutations.delete(key);
  });
  return result;
}
