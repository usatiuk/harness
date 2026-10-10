import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { render } from "ink";
import type { ConversationId, ModelConfig } from "@harness/protocol";
import type { HarnessClientService } from "@harness/client";
import { createNdjsonMessageConnection } from "@harness/client/node";
import { type ProviderStatus } from "@harness/server/client-protocol";
import { modelAvailabilityMessage } from "./provider-status.ts";
import { buildClientHarness, type Harness } from "./client-harness.ts";
import { Root, loadSession, launchOverrides, type Start } from "./session-app.tsx";
import type { LaunchOptions } from "./launch-options.ts";
import { launchConnected } from "./host-app.tsx";
import { prepareServerLaunch, selectStdioServer } from "./server-launch.ts";

const waitForChild = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolvePromise) => child.once("close", () => resolvePromise()));

async function buildSpawnedHarness(
  child: ChildProcess,
  release: () => Promise<void>,
): Promise<Harness> {
  if (child.stdout === null || child.stdin === null) {
    child.kill();
    await waitForChild(child);
    await release();
    throw new Error("server process did not expose protocol pipes");
  }
  const connection = createNdjsonMessageConnection(child.stdout, child.stdin);
  try {
    return await buildClientHarness(connection, async () => {
      await waitForChild(child);
      await release();
    });
  } catch (error) {
    child.kill();
    await waitForChild(child);
    await release();
    throw error;
  }
}

async function buildStdioHarness(): Promise<Harness> {
  const prepared = await prepareServerLaunch("stdio");
  const { launch } = prepared;
  const release = () => prepared.close();
  let child: ChildProcess;
  try {
    await selectStdioServer(launch);
    child = spawn(launch.executable, launch.args, {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
      env: { ...process.env, ...launch.env },
    });
  } catch (error) {
    await release();
    throw error;
  }
  return buildSpawnedHarness(child, release);
}

/** Warns when the session's configured model isn't backed by a registered (signed-in) provider. */
function notifyModel(
  service: HarnessClientService,
  providers: ProviderStatus[],
  model: ModelConfig,
): void {
  if (model.provider === "demo") {
    console.log(
      "No model provider configured — running on the demo provider. Run `harness auth login` to sign in.",
    );
    return;
  }
  const message = modelAvailabilityMessage(service.availableModels(), providers, model);
  if (message) console.log(message);
}

/** Parses launch flags into a running TUI: new session, resume by id, or resume picker. */
export async function launch(opts: LaunchOptions = {}): Promise<void> {
  if (!opts.connectStdio) return launchConnected(opts);

  if (opts.ssh !== undefined || opts.host !== undefined) {
    throw new Error("Choose --connect-stdio or a host connection");
  }
  const harness = await buildStdioHarness();
  const { service, plugins, fallbackModel } = harness;
  try {
    // Canonicalize once so a `--cwd ./x` flag and a stored `workspaceRoot` compare equal.
    const cwd = resolve(opts.cwd ?? process.cwd());
    // Conversations this instance created; empty ones are dropped on exit.
    const created = new Set<ConversationId>();

    let start: Start;
    if (opts.conversationId) {
      start = { kind: "session", session: await loadSession(service, opts.conversationId) };
    } else if (opts.resume) {
      start = { kind: "picker" };
    } else {
      // `--model` overrides the model id on the fallback provider (a dev convenience); otherwise
      // the settings cascade picks the model, falling back to `fallbackModel` only when none is set.
      const overrides = launchOverrides(fallbackModel, opts.model);
      const conversation = await service.createConversation({
        cwd,
        overrides,
      });
      console.log(`conversation ${conversation.id}\n`);
      created.add(conversation.id);
      await service.prepare(conversation.id);
      start = {
        kind: "session",
        session: {
          conversation,
          items: [],
          usage: {
            usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 },
            incomplete: false,
            cost: 0,
          },
        },
      };
    }

    if (start.kind === "session") {
      notifyModel(service, harness.providers, start.session.conversation.config.model);
    }

    const { waitUntilExit } = render(
      <Root
        service={service}
        plugins={plugins}
        providerLabels={Object.fromEntries(harness.providers.map(({ id, label }) => [id, label]))}
        start={start}
        cwd={cwd}
        onActive={() => undefined}
      />,
      // Ctrl+C is handled in-app (clear prompt / cancel overlay); Ctrl+D quits when empty.
      {
        exitOnCtrlC: false,
        incrementalRendering: true,
      },
    );
    await waitUntilExit();
    await Promise.all([...created].map((id) => service.deleteConversationIfEmpty(id)));
  } finally {
    await harness.close();
  }
}
