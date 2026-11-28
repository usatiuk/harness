import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { textOf, type ContextBoundary, type Conversation, type Item } from "@harness/protocol";
import { createAgentsPlugin } from "./index.ts";
import { LocalExecutionContext } from "@harness/execution";

const created: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-agents-"));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const setup = (
  workspaceRoot: string | null,
  home = join(workspaceRoot ?? tmpdir(), ".harness-test-home"),
) => {
  const agentsPlugin = createAgentsPlugin(home);
  const provider = agentsPlugin.services!()[0]!;
  const service = provider.for({ workspaceRoot } as Conversation);
  const execution = new LocalExecutionContext(workspaceRoot);
  const serviceOf = (key: string): unknown =>
    key === provider.key ? service : key === "execution" ? execution : undefined;
  const active: Item[] = [];
  const observe = async (boundary: ContextBoundary = { type: "turn" }) => {
    const output = await agentsPlugin.contextItems!(
      { service: serviceOf, active: async () => active },
      boundary,
    );
    for (const item of output)
      if (item.data !== undefined)
        active.push({ type: "plugin_data", plugin: agentsPlugin.id, data: item.data } as Item);
    return output.flatMap((item) => (item.type === "context" ? item.content : []));
  };
  const read = (path: string) =>
    observe({ type: "tools", calls: [{ callId: "read", name: "read_file", args: { path } }] });
  return { observe, read };
};

describe("agentsPlugin", () => {
  it("loads global guidance before unrelated project guidance with truthful scope", async () => {
    const root = await tempRoot();
    const home = join(root, "account", ".harness");
    const cwd = join(root, "project");
    await mkdir(home, { recursive: true });
    await mkdir(cwd);
    await writeFile(join(home, "AGENTS.md"), "personal global guidance");
    await writeFile(join(cwd, "AGENTS.md"), "project guidance");
    const { observe } = setup(cwd, home);
    const text = textOf(await observe());
    expect(text.indexOf("personal global guidance")).toBeLessThan(text.indexOf("project guidance"));
    expect(text).toContain("Scope: all conversations on this Harness server.");
    expect(text).toContain(`Scope: ${await realpath(cwd)} and its descendants.`);
  });

  it("loads global guidance for projectless conversations and observes creation, edits and removal once", async () => {
    const home = await tempRoot();
    const missing = setup(null, home);
    expect(await missing.observe()).toEqual([]);
    await writeFile(join(home, "AGENTS.md"), "version one");
    expect(textOf(await missing.observe())).toContain("version one");
    const loaded = setup(null, home);
    const first = await loaded.observe();
    expect(textOf(first)).toContain("version one");
    await writeFile(join(home, "AGENTS.md"), "version two");
    expect(textOf(await loaded.observe())).toContain("version two");
    expect(await loaded.observe()).toEqual([]);
    await rm(join(home, "AGENTS.md"));
    expect(textOf(await loaded.observe())).toContain("removed");
    expect(await loaded.observe()).toEqual([]);
    await writeFile(join(home, "AGENTS.md"), "version two");
    const reloaded = setup(null, home);
    expect(textOf(await reloaded.observe())).toContain("version two");
  });

  it("does not duplicate global guidance discovered in project ancestry", async () => {
    const home = await tempRoot();
    const cwd = join(home, "worktrees", "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(home, "AGENTS.md"), "once-only guidance");
    const { observe } = setup(cwd, home);
    const files = await observe();
    expect(files).toHaveLength(1);
    expect(textOf(files)).toContain("Scope: all conversations on this Harness server.");
  });

  it.skipIf(process.platform === "win32")(
    "deduplicates aliased home ancestry without following symlinked global files",
    async () => {
      const root = await tempRoot();
      const home = join(root, "home");
      const cwd = join(home, "project");
      const alias = join(root, "home-alias");
      await mkdir(cwd, { recursive: true });
      await symlink(home, alias);
      await writeFile(join(home, "AGENTS.md"), "global once");
      const global = setup(cwd, alias);
      expect(await global.observe()).toHaveLength(1);
      await writeFile(join(home, "AGENTS.md"), "updated through alias");
      expect(textOf(await global.read("."))).toContain("Scope: all conversations");
      await rm(join(home, "AGENTS.md"));
      expect(textOf(await global.observe())).toContain("removed");
      expect(await global.observe()).toEqual([]);
      await writeFile(join(home, "AGENTS.md"), "global");
      const other = join(root, "other");
      await mkdir(other);
      await symlink(join(home, "AGENTS.md"), join(other, "AGENTS.md"));
      const linked = setup(null, other);
      expect(await linked.observe()).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports unreadable global guidance rather than silently dropping it",
    async () => {
      const root = await tempRoot();
      const home = join(root, "home");
      await mkdir(home);
      await writeFile(join(home, "AGENTS.md"), "must not disappear");
      const { observe } = setup(null, home);
      await chmod(home, 0);
      try {
        await expect(observe()).rejects.toMatchObject({
          code: "EACCES",
        });
      } finally {
        await chmod(home, 0o700);
      }
      expect(textOf(await observe())).toContain("must not disappear");
    },
  );

  it("reconciles the directory chain when a tool path traverses a regular file", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "regular"), "file");
    await writeFile(join(root, "AGENTS.md"), "root guidance");
    expect(textOf(await setup(root).read(join("regular", "child")))).toContain("root guidance");
  });

  it("loads the host ancestor chain broadest-first and reports only changed paths", async () => {
    const root = await tempRoot();
    const cwd = join(root, "project", "src");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "outer");
    await writeFile(join(root, "project", "AGENTS.md"), "project");
    await writeFile(join(cwd, "AGENTS.md"), "inner");
    const { observe } = setup(cwd);

    const first = textOf(await observe());
    expect(first.indexOf("outer")).toBeLessThan(first.indexOf("project"));
    expect(first.indexOf("project")).toBeLessThan(first.indexOf("inner"));

    await writeFile(join(cwd, "AGENTS.md"), "changed");
    expect(textOf(await observe())).toContain("changed");
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a symlinked AGENTS.md file",
    async () => {
      const root = await tempRoot();
      const outside = await tempRoot();
      const secret = join(outside, "secret.txt");
      await writeFile(secret, "must not load");
      await symlink(secret, join(root, "AGENTS.md"));
      const { observe } = setup(root);

      expect(await observe()).toEqual([]);
    },
  );

  it("reconciles overlapping nested paths and detects deletion", async () => {
    const root = await tempRoot();
    const nested = join(root, "src");
    await mkdir(nested);
    await writeFile(join(nested, "AGENTS.md"), "nested rules");
    const { observe, read } = setup(root);
    await observe();
    const result = await observe({
      type: "tools",
      calls: ["a", "b"].map((path) => ({
        callId: path,
        name: "read_file",
        args: { path: "src/" + path },
      })),
    });
    expect(result).toHaveLength(1);
    expect(textOf(result)).toContain("nested rules");
    expect(await read("src/a")).toEqual([]);
    await rm(join(nested, "AGENTS.md"));
    expect(textOf(await read("src/b"))).toContain("removed");
  });

  it("discovers permitted external targets and ignores opaque calls", async () => {
    const root = await tempRoot();
    const project = join(root, "project"),
      sibling = join(root, "sibling");
    await mkdir(project);
    await mkdir(sibling);
    await writeFile(join(sibling, "AGENTS.md"), "external rules");
    const { read, observe } = setup(project);
    expect(textOf(await read("../sibling/a.ts"))).toContain("external rules");
    expect(
      await observe({
        type: "tools",
        calls: [{ callId: "s", name: "powershell", args: { command: "ls" } }],
      }),
    ).toEqual([]);
  });

  it("keeps an in-workspace directory link from exposing outside guidance", async () => {
    const root = await tempRoot(),
      outside = await tempRoot();
    await writeFile(join(outside, "AGENTS.md"), "private");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(await setup(root).read("linked/a.ts")).toEqual([]);
  });
});
