import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  textOf,
  type ContextSourceContext,
  type Conversation,
  type Item,
  type ToolCall,
  type ToolMiddlewareContext,
  type ToolResult,
} from "@harness/protocol";
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
  const source = agentsPlugin.contextSources!()[0]!;
  const middleware = agentsPlugin.toolMiddleware!()[0]!;
  return { serviceOf, source, middleware };
};

const sourceContext = (service: (key: string) => unknown): ContextSourceContext => ({
  service,
  toolNames: [],
});

const instructionItem = (key: string, content: string): Item =>
  ({ type: "context", key, content: [{ type: "text", text: content }] }) as Item;

const ok: ToolResult = { status: "ok", forModel: [{ type: "text", text: "done" }] };

const middlewareContext = (
  service: (key: string) => unknown,
  active: () => Promise<Item[]>,
  appendContext: ToolMiddlewareContext["appendContext"],
): ToolMiddlewareContext => ({
  conversationId: "conv" as ToolMiddlewareContext["conversationId"],
  callId: "call",
  signal: new AbortController().signal,
  service,
  emit: () => {},
  deliver: () => {},
  toolMeta: () => undefined,
  toolContract: () => undefined,
  acceptsToolCall: () => true,
  setResultAnnotation: () => {},
  putBlob: () => Promise.reject(new Error("unused")),
  request: () => Promise.reject(new Error("unused")),
  active,
  appendContext,
});

describe("agentsPlugin", () => {
  it("loads global guidance before unrelated project guidance with truthful scope", async () => {
    const root = await tempRoot();
    const home = join(root, "account", ".harness");
    const cwd = join(root, "project");
    await mkdir(home, { recursive: true });
    await mkdir(cwd);
    await writeFile(join(home, "AGENTS.md"), "personal global guidance");
    await writeFile(join(cwd, "AGENTS.md"), "project guidance");
    const { source, serviceOf } = setup(cwd, home);
    const text = textOf(await source.instructions(sourceContext(serviceOf)));
    expect(text.indexOf("personal global guidance")).toBeLessThan(text.indexOf("project guidance"));
    expect(text).toContain("Scope: all conversations on this Harness server.");
    expect(text).toContain(`Scope: ${cwd} and its descendants.`);
  });

  it("loads global guidance for projectless conversations and snapshots absence and edits", async () => {
    const home = await tempRoot();
    const missing = setup(null, home);
    expect(await missing.source.instructions(sourceContext(missing.serviceOf))).toEqual([]);
    await writeFile(join(home, "AGENTS.md"), "version one");
    expect(await missing.source.instructions(sourceContext(missing.serviceOf))).toEqual([]);
    const loaded = setup(null, home);
    const first = await loaded.source.instructions(sourceContext(loaded.serviceOf));
    expect(textOf(first)).toContain("version one");
    await writeFile(join(home, "AGENTS.md"), "version two");
    expect(await loaded.source.instructions(sourceContext(loaded.serviceOf))).toEqual(first);
    const reloaded = setup(null, home);
    expect(textOf(await reloaded.source.instructions(sourceContext(reloaded.serviceOf)))).toContain(
      "version two",
    );
  });

  it("does not duplicate global guidance discovered in project ancestry", async () => {
    const home = await tempRoot();
    const cwd = join(home, "worktrees", "project");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(home, "AGENTS.md"), "once-only guidance");
    const { source, serviceOf } = setup(cwd, home);
    const files = await source.instructions(sourceContext(serviceOf));
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
      expect(await global.source.instructions(sourceContext(global.serviceOf))).toHaveLength(1);
      const other = join(root, "other");
      await mkdir(other);
      await symlink(join(home, "AGENTS.md"), join(other, "AGENTS.md"));
      const linked = setup(null, other);
      expect(await linked.source.instructions(sourceContext(linked.serviceOf))).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports unreadable global guidance rather than silently dropping it",
    async () => {
      const root = await tempRoot();
      const home = join(root, "home");
      await mkdir(home);
      await writeFile(join(home, "AGENTS.md"), "must not disappear");
      const { source, serviceOf } = setup(null, home);
      await chmod(home, 0);
      try {
        await expect(source.instructions(sourceContext(serviceOf))).rejects.toMatchObject({
          code: "EACCES",
        });
      } finally {
        await chmod(home, 0o700);
      }
      expect(textOf(await source.instructions(sourceContext(serviceOf)))).toContain(
        "must not disappear",
      );
    },
  );

  it("loads the host ancestor chain broadest-first and snapshots its initial prefix", async () => {
    const root = await tempRoot();
    const cwd = join(root, "project", "src");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "outer");
    await writeFile(join(root, "project", "AGENTS.md"), "project");
    await writeFile(join(cwd, "AGENTS.md"), "inner");
    const { serviceOf, source } = setup(cwd);
    const ctx = sourceContext(serviceOf);

    const first = textOf(await source.instructions(ctx));
    expect(first.indexOf("outer")).toBeLessThan(first.indexOf("project"));
    expect(first.indexOf("project")).toBeLessThan(first.indexOf("inner"));

    await writeFile(join(cwd, "AGENTS.md"), "changed");
    expect(textOf(await source.instructions(ctx))).toBe(first);
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a symlinked AGENTS.md file",
    async () => {
      const root = await tempRoot();
      const outside = await tempRoot();
      const secret = join(outside, "secret.txt");
      await writeFile(secret, "must not load");
      await symlink(secret, join(root, "AGENTS.md"));
      const { serviceOf, source } = setup(root);

      expect(await source.instructions(sourceContext(serviceOf))).toEqual([]);
    },
  );

  it("injects a deeper instruction once before continuing the structured file call", async () => {
    const root = await tempRoot();
    const nested = join(root, "src");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root rules");
    await writeFile(join(nested, "AGENTS.md"), "nested rules");
    const { serviceOf, source, middleware } = setup(root);
    await source.instructions(sourceContext(serviceOf));

    const appended: { key: string; text: string }[] = [];
    const order: string[] = [];
    let active: Item[] = [];
    const ctx = middlewareContext(
      serviceOf,
      async () => active,
      async (key, content) => {
        appended.push({ key, text: textOf(content) });
        order.push("context");
      },
    );
    const call: ToolCall = { callId: "call", name: "read_file", args: { path: "src/a.ts" } };
    const next = async (): Promise<ToolResult> => {
      order.push("tool");
      return ok;
    };

    await middleware.wrap(call, ctx, next);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.text).toContain("nested rules");
    expect(order).toEqual(["context", "tool"]);

    active = [instructionItem(appended[0]!.key, appended[0]!.text)];
    await middleware.wrap(call, ctx, next);
    expect(appended).toHaveLength(1);
  });

  it("loads an approved outside-cwd target chain and ignores opaque tools", async () => {
    const root = await tempRoot();
    const project = join(root, "project");
    const sibling = join(root, "sibling");
    await mkdir(project);
    await mkdir(sibling);
    await writeFile(join(sibling, "AGENTS.md"), "sibling rules");
    const { serviceOf, source, middleware } = setup(project);
    await source.instructions(sourceContext(serviceOf));

    const appended: string[] = [];
    const ctx = middlewareContext(
      serviceOf,
      async () => [],
      async (_key, content) => {
        appended.push(textOf(content));
      },
    );
    const next = async (): Promise<ToolResult> => ok;

    await middleware.wrap(
      { callId: "read", name: "read_file", args: { path: "../sibling/a.ts" } },
      ctx,
      next,
    );
    expect(appended.join("\n")).toContain("sibling rules");

    await middleware.wrap(
      { callId: "shell", name: "powershell", args: { command: "Get-Content ../sibling/a.ts" } },
      ctx,
      next,
    );
    expect(appended).toHaveLength(1);
  });

  it("does not follow an in-workspace directory link to host-outside instructions", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, "AGENTS.md"), "must not load");
    await writeFile(join(outside, "a.ts"), "secret");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const { serviceOf, source, middleware } = setup(root);
    await source.instructions(sourceContext(serviceOf));
    const appended: string[] = [];
    const ctx = middlewareContext(
      serviceOf,
      async () => [],
      async (_key, content) => {
        appended.push(textOf(content));
      },
    );

    await middleware.wrap(
      { callId: "read", name: "read_file", args: { path: "linked/a.ts" } },
      ctx,
      async () => ok,
    );

    expect(appended).toEqual([]);
  });

  it("stops after cancellation without appending context or running the tool", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "AGENTS.md"), "nested rules");
    const { serviceOf, middleware } = setup(root);
    const controller = new AbortController();
    let appended = false;
    let continued = false;
    const ctx = {
      ...middlewareContext(
        serviceOf,
        async () => {
          controller.abort();
          return [];
        },
        async () => {
          appended = true;
        },
      ),
      signal: controller.signal,
    };

    const result = await middleware.wrap(
      { callId: "cancel", name: "read_file", args: { path: "src/a.ts" } },
      ctx,
      async () => {
        continued = true;
        return ok;
      },
    );

    expect(result.status).toBe("error");
    expect(appended).toBe(false);
    expect(continued).toBe(false);
  });
});
