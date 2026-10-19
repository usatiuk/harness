import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessClient, createInProcessMessageConnectionPair } from "@harness/client";
import { textOf, type ConversationId } from "@harness/protocol";
import { textStep } from "@harness/testkit";
import { readGlobalSettings } from "@harness/config";
import * as config from "@harness/config";
import { buildServerComposition, type ServerComposition } from "./index.ts";
import { DemoProvider } from "./demo-provider.ts";
import {
  appInstructionsRequest,
  appInstructionsUpdateRequest,
  appSettingsRequest,
  appSettingsUpdateRequest,
} from "./client-protocol.ts";

// Shell startup is an external edge; these tests never inspect the actual user home.
vi.mock("@harness/execution", async (original) => ({
  ...(await original<typeof import("@harness/execution")>()),
  initializeUserShellEnvironment: vi.fn(async () => {}),
}));
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "harness-host-api-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv("HARNESS_SERVER_SELECTION", undefined);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])
    vi.stubEnv(key, "");
  const server = await buildServerComposition();
  cleanups.push(() => server.close());
  return { home, server, client: await connect(server) };
}
async function connect(server: ServerComposition) {
  const pair = createInProcessMessageConnectionPair();
  server.connect(pair.right);
  const client = new HarnessClient({
    connection: pair.left,
    client: { name: "host-settings-test", version: "1" },
  });
  cleanups.push(() => client.closeConnection());
  await client.start();
  return client;
}

it("shares flat host settings across clients/reconnects while isolating captured homes", async () => {
  const first = await fixture();
  const secondClient = await connect(first.server);
  const other = await fixture(); // Environment now points elsewhere, but first server keeps its home.
  expect((await first.client.peer.request(appSettingsRequest, {})).settings.keepServerRunning).toBe(
    false,
  );
  expect((await other.client.peer.request(appSettingsRequest, {})).settings.keepServerRunning).toBe(
    false,
  );
  const original = await first.client.peer.request(appSettingsRequest, {});
  await first.client.peer.request(appSettingsUpdateRequest, { keepServerRunning: true });
  expect((await secondClient.peer.request(appSettingsRequest, {})).settings).toEqual({
    ...original.settings,
    keepServerRunning: true,
  });
  expect((await readGlobalSettings(first.home)).desktop).toEqual({ keepServerRunning: true });
  first.client.closeConnection();
  const reconnected = await connect(first.server);
  expect((await reconnected.peer.request(appSettingsRequest, {})).settings.keepServerRunning).toBe(
    true,
  );
  expect((await other.client.peer.request(appSettingsRequest, {})).settings.keepServerRunning).toBe(
    false,
  );
  await reconnected.peer.request(appSettingsUpdateRequest, { keepServerRunning: false });
  expect((await secondClient.peer.request(appSettingsRequest, {})).settings.keepServerRunning).toBe(
    false,
  );
  expect((await readGlobalSettings(first.home)).desktop?.keepServerRunning).toBe(false);
  expect((await readGlobalSettings(other.home)).desktop).toBeUndefined();
});

it("round-trips exact fixed-home guidance, keeps ordinary settings independent and rejects arbitrary paths", async () => {
  const first = await fixture();
  const other = await fixture();
  const path = join(first.home, "AGENTS.md");
  expect(await first.client.peer.request(appInstructionsRequest, {})).toEqual({
    path,
    content: null,
  });
  const project = join(first.home, "project");
  await mkdir(project);
  await writeFile(join(project, "AGENTS.md"), "PROJECT UNCHANGED");
  await writeFile(
    join(first.home, "settings.json"),
    JSON.stringify({ version: 1, instructions: "JSON UNCHANGED" }),
  );
  const settingsBefore = await readFile(join(first.home, "settings.json"), "utf8");
  for (const content of ["", "  exact λ guidance\r\n\r\n\n"]) {
    expect(await first.client.peer.request(appInstructionsUpdateRequest, { content })).toBeNull();
    expect(await first.client.peer.request(appInstructionsRequest, {})).toEqual({ path, content });
  }
  expect((await other.client.peer.request(appInstructionsRequest, {})).content).toBeNull();
  expect(await readFile(join(first.home, "settings.json"), "utf8")).toBe(settingsBefore);
  expect(await readFile(join(project, "AGENTS.md"), "utf8")).toBe("PROJECT UNCHANGED");
  expect((await first.client.peer.request(appSettingsRequest, {})).settings).not.toHaveProperty(
    "instructions",
  );
  expect(() => appInstructionsRequest.params.parse({ path: "/anywhere" })).toThrow();
  expect(() =>
    appInstructionsUpdateRequest.params.parse({ content: "new", home: "/anywhere" }),
  ).toThrow();
  expect(() => appSettingsUpdateRequest.params.parse({ instructions: "not here" })).toThrow();
  await rm(path);
  await mkdir(path);
  await expect(first.client.peer.request(appInstructionsRequest, {})).rejects.toThrow(
    "regular file",
  );
  await expect(
    first.client.peer.request(appInstructionsUpdateRequest, { content: "no" }),
  ).rejects.toThrow("regular file");
  await rm(path, { recursive: true });
  const target = join(first.home, "target");
  await writeFile(target, "untouched");
  await symlink(target, path);
  await expect(
    first.client.peer.request(appInstructionsUpdateRequest, { content: "no" }),
  ).rejects.toThrow("regular file");
  expect(await readFile(target, "utf8")).toBe("untouched");
  // Broken guidance cannot break routine root settings reads.
  expect((await first.client.peer.request(appSettingsRequest, {})).home).toBe(first.home);
});

it("consumes API edits only in new/reloaded service runtimes, preserving existing snapshots", async () => {
  const stream = vi.spyOn(DemoProvider.prototype, "stream").mockImplementation(async function* () {
    yield* textStep("done");
  });
  const { server, client } = await fixture();
  const before = "ORIGINAL GLOBAL RULES\r\n";
  const after = "  UPDATED λ GLOBAL RULES\r\n\r\n";
  await client.peer.request(appInstructionsUpdateRequest, { content: before });
  const conversation = await client.create({
    overrides: { model: { provider: "demo", model: "demo-1" } },
  });
  const requests = () =>
    stream.mock.calls
      .map(([request]) => request)
      .filter((request) => request.tools?.some((tool) => tool.name === "eval"));
  const send = async (id: typeof conversation.id) => {
    await server.service.send(id as ConversationId, "hello");
    await server.service.whenIdle(id as ConversationId);
    return textOf(requests().at(-1)!.instructions);
  };
  expect(await send(conversation.id)).toContain(before);
  await client.peer.request(appInstructionsUpdateRequest, { content: after });
  expect(await send(conversation.id)).toContain(before);
  expect(textOf(requests().at(-1)!.instructions)).not.toContain(after);
  const fresh = await client.create({
    overrides: { model: { provider: "demo", model: "demo-1" } },
  });
  expect(await send(fresh.id)).toContain(after);
  await server.service.deactivateSession(conversation.id as ConversationId);
  await server.service.prepare(conversation.id as ConversationId);
  expect(await send(conversation.id)).toContain(after);
  expect(textOf(requests().at(-1)!.instructions)).not.toContain(before);
});

it("presents classified read/write failures without exposing unexpected exceptions", async () => {
  const { client } = await fixture();
  vi.spyOn(config, "readGlobalInstructions").mockRejectedValueOnce(
    new config.GlobalInstructionsError("Cannot access global instructions (EACCES)"),
  );
  await expect(client.peer.request(appInstructionsRequest, {})).rejects.toThrow("EACCES");
  vi.spyOn(config, "updateGlobalInstructions").mockRejectedValueOnce(
    new config.GlobalInstructionsError("Cannot access global instructions (EROFS)"),
  );
  await expect(
    client.peer.request(appInstructionsUpdateRequest, { content: "draft" }),
  ).rejects.toThrow("EROFS");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(config.updateGlobalInstructions).mockRejectedValueOnce(
    new Error("private implementation detail"),
  );
  await expect(
    client.peer.request(appInstructionsUpdateRequest, { content: "draft" }),
  ).rejects.toThrow("internal error");
  // Failures do not poison the existing settings serialization chain.
  await client.peer.request(appInstructionsUpdateRequest, { content: "retry" });
  expect((await client.peer.request(appInstructionsRequest, {})).content).toBe("retry");
});

it("drains an admitted guidance save before closing shared server resources", async () => {
  const { server, client, home } = await fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const update = config.updateGlobalInstructions;
  let saved = false;
  vi.spyOn(config, "updateGlobalInstructions").mockImplementation(async (home, content) => {
    enter();
    await gate;
    await update(home, content);
    saved = true;
  });
  const closeStore = server.store.close.bind(server.store);
  let savedAtResourceClose = false;
  vi.spyOn(server.store, "close").mockImplementation(() => {
    savedAtResourceClose = saved;
    closeStore();
  });
  const outcome = client.peer
    .request(appInstructionsUpdateRequest, { content: "drained\r\n" })
    .catch((error: unknown) => error);
  try {
    await entered;
    const closing = server.close();
    release();
    await closing;
    await outcome;
    expect(savedAtResourceClose).toBe(true);
    expect(await readFile(join(home, "AGENTS.md"), "utf8")).toBe("drained\r\n");
  } finally {
    release();
  }
});
