import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { matchGlob, mayDescend, resolveScope, scopedPattern } from "./glob.ts";

const root = resolve("fake-ws"); // absolute, platform-native

describe("resolveScope", () => {
  it("treats empty and '.' as the whole workspace", () => {
    expect(resolveScope(root, "")).toEqual({ ok: true, dir: "" });
    expect(resolveScope(root, ".")).toEqual({ ok: true, dir: "" });
    expect(resolveScope(root, "./")).toEqual({ ok: true, dir: "" });
  });

  it("joins relative scopes, stripping './' and trailing '/'", () => {
    expect(resolveScope(root, "src")).toEqual({ ok: true, dir: "src" });
    expect(resolveScope(root, "./src/")).toEqual({ ok: true, dir: "src" });
    expect(resolveScope(root, "a/b")).toEqual({ ok: true, dir: "a/b" });
  });

  it("accepts an absolute path inside the workspace", () => {
    expect(resolveScope(root, resolve(root, "src"))).toEqual({ ok: true, dir: "src" });
    expect(resolveScope(root, root)).toEqual({ ok: true, dir: "" });
  });

  it("rejects scopes resolving outside the workspace", () => {
    for (const p of [resolve(root, ".."), `${root}-evil`, "../escape", ".."]) {
      const r = resolveScope(root, p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/outside the workspace/);
    }
  });

  it("uses the current directory when there is no workspace root", () => {
    expect(resolveScope(null, process.cwd())).toEqual({ ok: true, dir: "" });
  });

  it("rejects drive-letter paths not inside the workspace", () => {
    const r = resolveScope(root, "Z:\\nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/outside the workspace|Windows path/);
  });

  it("treats backslashes as separators on Windows only", () => {
    const r = resolveScope(root, "src\\sub");
    if (process.platform === "win32") expect(r).toEqual({ ok: true, dir: "src/sub" });
    else expect(r).toEqual({ ok: true, dir: "src\\sub" });
  });
});

describe("literal glob scopes", () => {
  it.each(["foo[1]", "foo{1,2}", "!scope", "#scope", "@(scope)", "a*b", "a?b"])(
    "matches literal scope %s without expanding it",
    (dir) => {
      const pattern = scopedPattern("**/*.ts", dir);
      expect(mayDescend(`${dir}/nested`, pattern)).toBe(true);
      expect(matchGlob([`${dir}/nested/a.ts`, "other/b.ts"], pattern)).toEqual([
        `${dir}/nested/a.ts`,
      ]);
    },
  );
});
