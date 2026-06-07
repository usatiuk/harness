import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { createOpenAIChatGptAuthManager, type OpenAIChatGptAuthManager } from "@harness/auth-openai";
import { HarnessKernel, createId, createProfileResolver, type ModelAdapter } from "@harness/core";
import { createOpenAIChatGptResponsesModelAdapter, DEFAULT_OPENAI_CHATGPT_MODEL, OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID, OPENAI_CHATGPT_PROVIDER } from "@harness/model-openai-chatgpt";
import { createOpenAIResponsesModelAdapter, DEFAULT_OPENAI_MODEL, OPENAI_PROVIDER, OPENAI_RESPONSES_ADAPTER_ID } from "@harness/model-openai";
import { createControlPlugin, CONTROL_PLUGIN_ID } from "@harness/plugin-control";
import { createMcpPlugin, MCP_PLUGIN_ID } from "@harness/plugin-mcp";
import { createSubagentsPlugin, SubagentDelegator, SUBAGENTS_PLUGIN_ID } from "@harness/plugin-subagents";
import { createTasksPlugin, TaskManager, TASKS_NAMESPACE } from "@harness/plugin-tasks";
import { type ApprovalPolicy, type AssetOrigin, type ContentBlock, type JsonValue, type ModelCapabilities, type ModelConfig, type ModelStepInput, type ModelStepResult, type ProfileConfig, profileConfigSchema } from "@harness/protocol";
import { createHostExecutionProvider } from "@harness/sandbox-host";
import { InProcessHarnessService } from "@harness/service";
import { openSqliteHarnessStore, type SqliteHarnessStore } from "@harness/store-sqlite";
import { createBasicTools, createBasicToolsPlugin } from "@harness/tools-basic";
import {
  renderActivities,
  renderArtifacts,
  renderAssets,
  renderContextBlocks,
  renderContextBuilds,
  renderEffectiveConfig,
  renderEvents,
  renderInteractions,
  renderProfiles,
  renderConversations,
  renderState,
  renderTurnState,
  renderTurns
} from "./render.ts";
import { runTui } from "./tui.tsx";

export const SOURCE_FIRST_MARKER = "harness-cli:src";
const DEFAULT_ENABLED_TOOLS = ["bash", "read_file", "write_file", "list_files", "grep", "activity_status", "activity_output", "activity_cancel"];

interface CliApp {
  service: InProcessHarnessService;
  store: SqliteHarnessStore;
  openAIAuth: OpenAIChatGptAuthManager;
}

export function createCliProgram(): Command {
  const program = new Command();
  program
    .name("harness")
    .version("0.0.0")
    .description("harness v0")
    .showHelpAfterError()
    .addHelpText("beforeAll", `harness v0

Config:
  data directory: ${defaultHarnessHome()}
  database: ${defaultDbPath()}
  overrides: HARNESS_HOME, HARNESS_DB_PATH, HARNESS_MODEL, OPENAI_API_KEY
`);

  program.action(async () => {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await withCliApp(async (app) => runTui(app.service, { projectPath: process.cwd(), openAIAuth: app.openAIAuth }))();
      return;
    }
    program.help();
  });

  program.command("tui")
    .description("harness tui")
    .option("--profile <name>", "Profile to use for a new conversation")
    .option("--project <path>", "Project path to bind", process.cwd())
    .option("--provider <provider>", "Model provider")
    .option("--adapter <adapter>", "Model adapter")
    .option("--model <model>", "Model id")
    .option("--reasoning-effort <effort>", "Provider reasoning effort")
    .option("--web-search", "Enable native web search")
    .option("--permissions <preset>", "auto, ask-always, read-only, or full-access")
    .action(withCliApp(async (app, options) => {
      await runTui(app.service, { ...tuiOptionsFromCommander(options), openAIAuth: app.openAIAuth });
    }));

  program.command("exec")
    .description("Run a non-interactive prompt")
    .argument("[prompt...]", "Prompt text")
    .option("--prompt <prompt>", "Prompt text")
    .option("--message <message>", "Prompt text")
    .option("-m, --m <message>", "Prompt text")
    .option("--profile <name>", "Profile to use")
    .option("--project <path>", "Project path", process.cwd())
    .option("--provider <provider>", "Model provider")
    .option("--adapter <adapter>", "Model adapter")
    .option("--model <model>", "Model id")
    .option("--reasoning-effort <effort>", "Provider reasoning effort")
    .option("--web-search", "Enable native web search")
    .option("--permissions <preset>", "auto, ask-always, read-only, or full-access")
    .option("--json", "Print events as JSON lines on stderr")
    .action(withCliApp(async (app, promptParts: string[], options) => {
      await execPromptFromCommander(app.service, promptParts, normalizeCommanderOptions(options));
    }));

  const profiles = program.command("profiles").description("Manage profiles");
  profiles.command("create")
    .argument("<name>", "Profile name")
    .option("--provider <provider>", "Model provider", "fake")
    .option("--adapter <adapter>", "Model adapter")
    .option("--model <model>", "Model id")
    .option("--model-id <modelId>", "Model id")
    .option("--tools <tools>", "Comma-separated enabled tools")
    .option("--plugins <plugins>", "Comma-separated enabled plugins")
    .option("--native-tools <tools>", "Comma-separated native tool kinds")
    .option("--web-search", "Enable native web search")
    .option("--reasoning-effort <effort>", "Provider reasoning effort")
    .option("--permissions <preset>", "auto, ask-always, read-only, or full-access")
    .option("--approval-preset <preset>", "Approval preset")
    .option("--prompt <text>", "Prompt fragment")
    .action(withCliApp(async (app, name: string, options) => {
      await createProfileFromCommander(app.service, name, normalizeCommanderOptions(options));
    }));
  profiles.command("list").action(withCliApp(async (app) => {
    console.log(renderProfiles(await app.service.listProfiles()));
  }));
  profiles.command("select").argument("<idOrName>").action(withCliApp(async (app, idOrName: string) => {
    const profile = await app.service.selectProfile(idOrName);
    console.log(`selected ${profile.name} (${profile.id})`);
  }));

  const auth = program.command("auth")
    .description("Manage ChatGPT auth")
    .addHelpText("after", `\nStorage:\n  ChatGPT/Codex OAuth credentials are stored in the OS keyring for ${defaultHarnessHome()}.\n`);
  auth.command("status").action(withCliApp(async (app) => {
    await printChatGptAuthStatus(app);
  }));
  auth.command("login")
    .option("--device", "Use device code flow")
    .option("--no-open", "Do not open a browser")
    .option("--select", "Select the ChatGPT profile after login")
    .action(withCliApp(async (app, options: { device?: boolean; open?: boolean; select?: boolean }) => {
      await loginChatGpt(app, options);
    }));
  auth.command("logout").action(withCliApp(async (app) => {
    await logoutChatGpt(app);
  }));

  const conversation = program.command("conversation").description("Manage one conversation");
  conversation.command("start")
    .option("--message <message>", "User message")
    .option("-m, --m <message>", "User message")
    .option("--title <title>", "Conversation title")
    .option("--project <path>", "Project path")
    .option("--profile <name>", "Profile name")
    .option("--provider <provider>", "Model provider")
    .option("--adapter <adapter>", "Model adapter")
    .option("--model <model>", "Model id")
    .option("--reasoning-effort <effort>", "Provider reasoning effort")
    .option("--web-search", "Enable native web search")
    .option("--permissions <preset>", "auto, ask-always, read-only, or full-access")
    .option("--tool <tool>", "Convenience tool trigger")
    .option("--attach <file...>", "Attach file(s)")
    .action(withCliApp(async (app, options) => {
      await startConversationFromCommander(app.service, normalizeCommanderOptions(options));
    }));
  conversation.command("continue").argument("<conversationId>").option("--message <message>").option("-m, --m <message>").action(withCliApp(async (app, conversationId: string, options) => {
    const normalized = normalizeCommanderOptions(options);
    const message = normalized.message ?? normalized.m ?? "hello";
    const queued = await app.service.continueConversation(conversationId, [{ type: "text", text: message }]);
    console.log(`queued input ${queued.id} ${queued.status}`);
  }));
  conversation.command("queue").argument("<conversationId>").option("--message <message>").option("-m, --m <message>").action(withCliApp(async (app, conversationId: string, options) => {
    const normalized = normalizeCommanderOptions(options);
    const message = normalized.message ?? normalized.m ?? "hello";
    const queued = await app.service.sendConversationInput({ conversationId, message: [{ type: "text", text: message }], delivery: "after_active" });
    console.log(`queued input ${queued.id} ${queued.status}`);
  }));

  const conversations = program.command("conversations").description("List or show conversations");
  conversations.command("list").action(withCliApp(async (app) => {
    console.log(renderConversations(await app.service.listConversations()));
  }));
  conversations.command("show").argument("<conversationId>").action(withCliApp(async (app, conversationId: string) => {
    console.log(JSON.stringify(await app.service.getConversation(conversationId) ?? null, null, 2));
  }));

  program.command("turns").argument("<conversationId>").action(withCliApp(async (app, conversationId: string) => {
    console.log(renderTurns(await app.service.listTurns(conversationId)));
  }));
  const turn = program.command("turn").description("Manage turns");
  turn.command("resume").argument("<turnId>").action(withCliApp(async (app, turnId: string) => {
    const resumed = await app.service.resumeTurn(turnId);
    console.log(`turn ${resumed.id} ${resumed.status}`);
  }));
  turn.command("interrupt").argument("<turnId>").option("--reason <reason>").action(withCliApp(async (app, turnId: string, options) => {
    const interrupted = await app.service.interruptTurn(turnId, normalizeCommanderOptions(options).reason);
    console.log(`turn ${interrupted.id} ${interrupted.status}`);
  }));

  program.command("events").argument("<conversationId>").option("--after <n>").option("--limit <n>").action(withCliApp(async (app, conversationId: string, options) => {
    console.log(renderEvents(await app.service.listEvents(conversationId, pageOptions(normalizeCommanderOptions(options), 50))));
  }));
  program.command("provider-events").argument("<conversationId>").option("--after <n>").option("--limit <n>").action(withCliApp(async (app, conversationId: string, options) => {
    console.log(renderEvents(await app.service.listProviderEvents(conversationId, pageOptions(normalizeCommanderOptions(options), 50))));
  }));
  program.command("activities").argument("<conversationId>").action(withCliApp(async (app, conversationId: string) => {
    console.log(renderActivities(await app.service.listActivities(conversationId)));
  }));
  const output = program.command("output").description("Inspect runtime-only live output");
  output.command("activity").argument("<activityId>").option("--after <n>").option("--limit <n>").action(withCliApp(async (app, activityId: string, options) => {
    console.log(JSON.stringify(await app.service.peekActivityOutput(activityId, pageOptions(normalizeCommanderOptions(options), 100)) ?? null, null, 2));
  }));
  output.command("tool").argument("<toolExecutionId>").option("--after <n>").option("--limit <n>").action(withCliApp(async (app, toolExecutionId: string, options) => {
    console.log(JSON.stringify(await app.service.peekToolOutput(toolExecutionId, pageOptions(normalizeCommanderOptions(options), 100)) ?? null, null, 2));
  }));
  program.command("state").argument("<conversationId>").action(withCliApp(async (app, conversationId: string) => {
    console.log(renderState(await app.service.listState(conversationId)));
  }));
  program.command("assets").argument("[conversationId]").action(withCliApp(async (app, conversationId?: string) => {
    console.log(renderAssets(await app.service.listAssets(conversationId)));
  }));
  program.command("artifacts").argument("<conversationId>").action(withCliApp(async (app, conversationId: string) => {
    console.log(renderArtifacts(await app.service.listArtifacts(conversationId)));
  }));
  program.command("config").argument("<conversationId>").action(withCliApp(async (app, conversationId: string) => {
    console.log(renderEffectiveConfig(await app.service.getEffectiveConfig(conversationId)));
  }));
  program.command("contexts").argument("[conversationId]").action(withCliApp(async (app, conversationId?: string) => {
    console.log(JSON.stringify(await app.service.listExecutionContexts(conversationId), null, 2));
  }));

  const interactions = program.command("interactions").description("Manage interactions");
  interactions.command("list").argument("[conversationId]").action(withCliApp(async (app, conversationId?: string) => {
    console.log(renderInteractions(await app.service.listPendingInteractions(conversationId)));
  }));
  interactions.command("show").argument("<interactionId>").action(withCliApp(async (app, interactionId: string) => {
    console.log(JSON.stringify(await app.service.getInteraction(interactionId) ?? null, null, 2));
  }));
  interactions.command("answer").argument("<interactionId>").option("--text <text>").option("--json <json>").action(withCliApp(async (app, interactionId: string, options) => {
    const normalized = normalizeCommanderOptions(options);
    const response = normalized.json ? JSON.parse(normalized.json) as JsonValue : { text: normalized.text ?? "" };
    console.log(JSON.stringify(await app.service.answerInteraction(interactionId, response), null, 2));
  }));
  interactions.command("cancel").argument("<interactionId>").action(withCliApp(async (app, interactionId: string) => {
    console.log(JSON.stringify(await app.service.cancelInteraction(interactionId), null, 2));
  }));

  program.command("turn-state").argument("<turnId>").action(withCliApp(async (app, turnId: string) => {
    console.log(renderTurnState(await app.service.getTurnState(turnId)));
  }));
  const context = program.command("context").description("Inspect context");
  context.command("blocks").argument("<conversationId>").action(withCliApp(async (app, conversationId: string) => {
    console.log(renderContextBlocks(await app.service.listContextBlocks(conversationId)));
  }));
  context.command("builds").argument("<conversationId>").action(withCliApp(async (app, conversationId: string) => {
    console.log(renderContextBuilds(await app.service.listContextBuilds(conversationId)));
  }));
  const compaction = program.command("compaction").description("Run context compaction");
  compaction.command("run").argument("<conversationId>").action(withCliApp(async (app, conversationId: string) => {
    console.log(JSON.stringify(await app.service.runCompaction(conversationId), null, 2));
  }));
  const tasks = program.command("tasks").description("Manage tasks");
  tasks.command("add").argument("<conversationId>").argument("<title...>").action(withCliApp(async (app, conversationId: string, titleParts: string[]) => {
    const title = titleParts.join(" ");
    if (title.length === 0) {
      throw new Error("Task title is required");
    }
    console.log(JSON.stringify(await app.service.addTask(conversationId, title), null, 2));
  }));
  const subagents = program.command("subagents").description("Manage subagents");
  subagents.command("delegate").argument("<conversationId>").option("--prompt <prompt>").option("--title <title>").action(withCliApp(async (app, conversationId: string, options) => {
    const normalized = normalizeCommanderOptions(options);
    const result = await app.service.delegateSubagent({
      parentConversationId: conversationId,
      prompt: requiredArg(normalized.prompt, "prompt"),
      ...(normalized.title ? { title: normalized.title } : {})
    });
    console.log(JSON.stringify({ childConversationId: result.childConversation.id, activityId: result.activity.id }, null, 2));
  }));
  subagents.command("send").argument("<activityId>").option("--message <message>").option("-m, --m <message>").action(withCliApp(async (app, activityId: string, options) => {
    const normalized = normalizeCommanderOptions(options);
    const message = requiredArg(normalized.message ?? normalized.m, "message");
    console.log(JSON.stringify(await app.service.sendSubagent({ activityId, message: [{ type: "text", text: message }] }), null, 2));
  }));
  subagents.command("peek").argument("<activityId>").action(withCliApp(async (app, activityId: string) => {
    console.log(JSON.stringify(await app.service.peekSubagent(activityId), null, 2));
  }));
  subagents.command("wait").argument("<activityId>").action(withCliApp(async (app, activityId: string) => {
    console.log(JSON.stringify(await app.service.waitSubagent(activityId), null, 2));
  }));
  subagents.command("cancel").argument("<activityId>").action(withCliApp(async (app, activityId: string) => {
    console.log(JSON.stringify(await app.service.cancelSubagent(activityId), null, 2));
  }));

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  await createCliProgram().parseAsync(argv, { from: "user" });
}

export async function main(argv: string[]): Promise<void> {
  await runCli(argv);
}

function withCliApp<T extends unknown[]>(handler: (app: CliApp, ...args: T) => Promise<void>): (...args: T) => Promise<void> {
  return async (...args) => {
    const app = await createCliApp();
    try {
      await handler(app, ...args);
    } finally {
      app.store.close();
    }
  };
}

function normalizeCommanderOptions(options: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(options)) {
    if (rawValue === undefined) {
      continue;
    }
    const key = rawKey.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    if (Array.isArray(rawValue)) {
      normalized[key] = rawValue.map((item) => String(item)).join(",");
      continue;
    }
    normalized[key] = typeof rawValue === "boolean" ? String(rawValue) : String(rawValue);
  }
  return normalized;
}

function tuiOptionsFromCommander(options: Record<string, unknown>): Parameters<typeof runTui>[1] {
  const normalized = normalizeCommanderOptions(options);
  const profileOverrides = profileOverridesFromOptions(normalized);
  return {
    ...(normalized.profile ? { profile: normalized.profile } : {}),
    projectPath: normalized.project ?? process.cwd(),
    ...(profileOverrides ? { profileOverrides } : {})
  };
}

async function createProfileFromCommander(service: InProcessHarnessService, name: string, options: Record<string, string>): Promise<void> {
  const provider = options.provider ?? "fake";
  const adapter = options.adapter ?? defaultAdapterForProvider(provider);
  const modelId = options.model ?? options["model-id"] ?? defaultModelForProvider(provider);
  const enabledTools = splitList(options.tools) ?? DEFAULT_ENABLED_TOOLS;
  const providerOptions = providerOptionsFromOptions(options);
  const approvalPolicy = approvalPolicyFromPreset(options.permissions ?? options["approval-preset"]) ?? defaultApprovalPolicy();
  const profile = await service.createProfile({
    name,
    config: profileConfigSchema.parse({
      model: {
        adapter,
        provider,
        modelId,
        ...(providerOptions === undefined ? {} : { providerOptions }),
        nativeTools: nativeToolsFromOptions(options)
      },
      enabledTools,
      approvalPolicy,
      plugins: pluginMap(splitList(options.plugins) ?? [CONTROL_PLUGIN_ID, TASKS_NAMESPACE, SUBAGENTS_PLUGIN_ID, MCP_PLUGIN_ID]),
      promptFragments: options.prompt ? [options.prompt] : []
    })
  });
  console.log(JSON.stringify(profile, null, 2));
}

async function startConversationFromCommander(service: InProcessHarnessService, options: Record<string, string>): Promise<void> {
  const message = options.message ?? options.m ?? "hello";
  const attachments = await Promise.all((arrayOption(options, "attach") ?? []).map((filePath) => createAttachment(filePath)));
  const promptText = options.tool === "bash" && !message.includes("tool:bash") ? `${message}\ntool:bash` : message;
  const profileOverrides = profileOverridesFromOptions(options);
  const conversation = await service.startConversation({
    message: [{ type: "text", text: promptText }],
    title: options.title ?? promptText.slice(0, 80),
    attachments,
    ...(options.profile ? { profile: options.profile } : {}),
    ...(profileOverrides ? { profileOverrides } : {}),
    ...(options.project ? { projectPath: options.project } : {})
  });
  console.log(`conversation ${conversation.id} ${conversation.status}`);
  console.log(renderEvents(await service.listEvents(conversation.id, { limit: 20 })));
}

async function execPromptFromCommander(service: InProcessHarnessService, promptParts: string[], options: Record<string, string>): Promise<void> {
  const prompt = options.prompt ?? options.message ?? options.m ?? promptParts.join(" ");
  if (!prompt) {
    throw new Error("exec prompt is required");
  }
  const profileOverrides = profileOverridesFromOptions(options);
  const conversation = await service.startConversation({
    message: [{ type: "text", text: prompt }],
    title: options.title ?? prompt.slice(0, 80),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(profileOverrides ? { profileOverrides } : {}),
    projectPath: options.project ?? process.cwd()
  });
  const events = await service.listEvents(conversation.id, { limit: 200 });
  if (options.json === "true") {
    for (const event of events) {
      console.error(JSON.stringify(event));
    }
  } else {
    const progress = events
      .filter((event) => event.type !== "message.created")
      .map((event) => `${event.sequence}\t${event.type}`)
      .join("\n");
    if (progress.length > 0) {
      console.error(progress);
    }
  }
  const messages = await service.kernel.store.listMessages(conversation.id);
  const assistantText = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  console.log(assistantText);
}

async function printChatGptAuthStatus(app: CliApp): Promise<void> {
  const status = await app.openAIAuth.status();
  if (!status.authenticated) {
    console.log("ChatGPT auth: not logged in");
    return;
  }
  console.log([
    "ChatGPT auth: logged in",
    `account=${status.accountId ?? "-"}`,
    `expires=${status.expiresAt ?? "-"}`,
    `storage=${status.storage}`
  ].join("\t"));
}

async function loginChatGpt(app: CliApp, options: { device?: boolean; open?: boolean; select?: boolean }): Promise<void> {
  const session = options.device
    ? await app.openAIAuth.loginWithDeviceCode({
        onDeviceCode(info) {
          console.error(`Open ${info.verificationUrl} and enter code ${info.userCode}`);
        }
      })
    : await app.openAIAuth.loginWithBrowser({
        openBrowser: options.open !== false,
        onAuthUrl(url) {
          console.error(`Open ${url}`);
        }
      });
  await createChatGptProfileIfMissing(app.service);
  if (options.select || await shouldSelectChatGptProfile(app.service)) {
    await app.service.selectProfile("chatgpt");
  }
  console.log(`logged in ChatGPT account ${session.accountId}`);
}

async function logoutChatGpt(app: CliApp): Promise<void> {
  const deleted = await app.openAIAuth.logout();
  console.log(deleted ? "logged out ChatGPT account" : "no ChatGPT auth was stored");
}

async function createCliApp(): Promise<CliApp> {
  const dbPath = defaultDbPath();
  const store = await openSqliteHarnessStore({ dbPath, migrate: true });
  const openAIAuth = createOpenAIChatGptAuthManager({ harnessHome: defaultHarnessHome() });
  const kernel = new HarnessKernel({
    store,
    profileResolver: createProfileResolver(store),
    model: new CliFakeModelAdapter(),
    models: [
      createOpenAIResponsesModelAdapter(),
      createOpenAIChatGptResponsesModelAdapter({ auth: openAIAuth })
    ],
    tools: createBasicTools(),
    executionProviders: [createHostExecutionProvider()],
    plugins: [createBasicToolsPlugin(), createControlPlugin(), createTasksPlugin(), createSubagentsPlugin(), createMcpPlugin()]
  });
  await kernel.recoverRuntimeState();
  const taskManager = new TaskManager(kernel);
  const subagents = new SubagentDelegator(kernel);
  const service = new InProcessHarnessService({
    kernel,
    tasks: { addTask: (conversationId, title) => taskManager.addTask(conversationId, title).then((state) => state as unknown as JsonValue) },
    subagents
  });
  await ensureDefaultProfile(service);
  return { service, store, openAIAuth };
}

async function ensureDefaultProfile(service: InProcessHarnessService): Promise<void> {
  const profiles = await service.listProfiles();
  if (profiles.length > 0) {
    if (!profiles.some((profile) => profile.name === "openai")) {
      await createOpenAIProfile(service);
    }
    if (!profiles.some((profile) => profile.name === "chatgpt")) {
      await createChatGptProfile(service);
    }
    return;
  }
  const profile = await service.createProfile({
    name: "default",
    config: profileConfigSchema.parse({
      model: { adapter: "fake", modelId: "fake-text" },
      promptFragments: ["You are running inside the modular harness v0."],
      enabledTools: DEFAULT_ENABLED_TOOLS,
      approvalPolicy: defaultApprovalPolicy(),
      plugins: {
        ...pluginMap([CONTROL_PLUGIN_ID, TASKS_NAMESPACE, SUBAGENTS_PLUGIN_ID]),
        [MCP_PLUGIN_ID]: {
          enabled: true,
          config: {
            servers: {
              demo: {
                command: "echo",
                args: ["mcp-demo"],
                env: {},
                enabled: false
              }
            }
          }
        }
      }
    })
  });
  await createOpenAIProfile(service);
  await createChatGptProfile(service);
  await service.selectProfile(profile.id);
}

async function createOpenAIProfile(service: InProcessHarnessService): Promise<void> {
  await service.createProfile({
    name: "openai",
    config: profileConfigSchema.parse({
      model: {
        adapter: OPENAI_RESPONSES_ADAPTER_ID,
        provider: OPENAI_PROVIDER,
        modelId: process.env.HARNESS_MODEL ?? DEFAULT_OPENAI_MODEL,
        nativeTools: []
      },
      promptFragments: ["You are running inside the modular harness v0."],
      enabledTools: DEFAULT_ENABLED_TOOLS,
      approvalPolicy: defaultApprovalPolicy(),
      plugins: {
        ...pluginMap([CONTROL_PLUGIN_ID, TASKS_NAMESPACE, SUBAGENTS_PLUGIN_ID]),
        [MCP_PLUGIN_ID]: {
          enabled: true,
          config: {
            servers: {}
          }
        }
      }
    })
  });
}

async function createChatGptProfileIfMissing(service: InProcessHarnessService): Promise<void> {
  const profiles = await service.listProfiles();
  if (!profiles.some((profile) => profile.name === "chatgpt")) {
    await createChatGptProfile(service);
  }
}

async function createChatGptProfile(service: InProcessHarnessService): Promise<void> {
  await service.createProfile({
    name: "chatgpt",
    config: profileConfigSchema.parse({
      model: {
        adapter: OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID,
        provider: OPENAI_CHATGPT_PROVIDER,
        modelId: process.env.HARNESS_MODEL ?? DEFAULT_OPENAI_CHATGPT_MODEL,
        nativeTools: []
      },
      promptFragments: ["You are running inside the modular harness v0."],
      enabledTools: DEFAULT_ENABLED_TOOLS,
      approvalPolicy: defaultApprovalPolicy(),
      plugins: {
        ...pluginMap([CONTROL_PLUGIN_ID, TASKS_NAMESPACE, SUBAGENTS_PLUGIN_ID]),
        [MCP_PLUGIN_ID]: {
          enabled: true,
          config: {
            servers: {}
          }
        }
      }
    })
  });
}

async function shouldSelectChatGptProfile(service: InProcessHarnessService): Promise<boolean> {
  const defaultProfileId = await service.kernel.store.getDefaultProfileId();
  if (!defaultProfileId) {
    return true;
  }
  const defaultProfile = await service.kernel.store.getProfile(defaultProfileId);
  return defaultProfile?.name === "default";
}

class CliFakeModelAdapter implements ModelAdapter {
  public readonly id = "fake";
  public readonly provider = "fake";

  public capabilities(): ModelCapabilities {
    return {
      textInput: true,
      textOutput: true,
      imageInput: false,
      fileInput: false,
      pdfInput: false,
      audioInput: false,
      audioOutput: false,
      toolCalling: true,
      hostedTools: false,
      reasoningMetadata: false
    };
  }

  public supportedNativeToolKinds(): string[] {
    return ["web_search", "reasoning", "code_interpreter"];
  }

  public validateModelConfig(config: ModelConfig): void {
    if (config.adapter !== this.id || config.provider !== this.provider) {
      throw new Error(`CLI fake adapter cannot run ${config.provider}/${config.adapter}`);
    }
  }

  public async step(input: ModelStepInput): Promise<ModelStepResult> {
    const text = input.messages.flatMap((message) => message.content).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const hasBashResult = input.messages.some((message) => message.content.some((block) => block.type === "tool_result_ref" && block.toolCallId.startsWith("call")));
    const toolCalls = text.includes("tool:bash") && !hasBashResult
      ? [
          {
            id: createId("call"),
            name: "bash",
            input: { command: "printf 'hello from bash\\n'; printf 'stderr sample\\n' 1>&2" }
          }
        ]
      : [];
    return {
      content: [{ type: "text", text: `fake model saw ${input.messages.length} context messages` }],
      toolCalls,
      providerEvents: input.modelConfig.nativeTools.filter((tool) => tool.enabled).map((tool, sequence) => ({
        provider: input.modelConfig.provider,
        modelId: input.modelConfig.modelId,
        sequence,
        kind: `native_tool.${tool.kind}`,
        normalized: { kind: tool.kind, name: tool.name ?? null }
      })),
      metadata: {
        unsupportedInputBlockCount: input.unsupportedInputBlocks.length.toString(),
        availableTools: input.availableTools.map((tool) => tool.name).join(",")
      }
    };
  }
}

async function createAttachment(filePath: string): Promise<{
  uri: string;
  mimeType: string;
  byteSize: number;
  sha256?: string;
  origin: AssetOrigin;
  metadata?: Record<string, JsonValue>;
  contentBlock: ContentBlock;
}> {
  const resolved = path.resolve(filePath);
  const buffer = await fs.readFile(resolved);
  const mimeType = mimeFromPath(resolved);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const contentBlock = contentBlockForAttachment("pending", mimeType, path.basename(resolved));
  return {
    uri: pathToFileURL(resolved).toString(),
    mimeType,
    byteSize: buffer.byteLength,
    sha256,
    origin: { kind: "user_upload", detail: { path: resolved } },
    metadata: { filename: path.basename(resolved) },
    contentBlock
  };
}

function contentBlockForAttachment(assetId: string, mimeType: string, filename: string): ContentBlock {
  if (mimeType.startsWith("image/")) {
    return { type: "image_ref", assetId, alt: filename };
  }
  if (mimeType === "application/pdf") {
    return { type: "pdf_ref", assetId, filename };
  }
  return { type: "file_ref", assetId, filename, mediaType: mimeType };
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".pdf") {
    return "application/pdf";
  }
  if (ext === ".mp3") {
    return "audio/mpeg";
  }
  return "application/octet-stream";
}

function profileOverridesFromOptions(options: Record<string, string>): Partial<ProfileConfig> | undefined {
  const model = modelConfigFromOptions(options);
  const approvalPolicy = approvalPolicyFromPreset(options.permissions ?? options["approval-preset"]);
  const overrides: Partial<ProfileConfig> = {
    ...(model ? { model } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {})
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function modelConfigFromOptions(options: Record<string, string>): ModelConfig | undefined {
  const hasModelOverride = Boolean(options.model ?? options["model-id"] ?? options.provider ?? options.adapter ?? options["native-tools"] ?? options["web-search"] ?? options["reasoning-effort"]);
  if (!hasModelOverride) {
    return undefined;
  }
  const provider = options.provider ?? OPENAI_PROVIDER;
  const adapter = options.adapter ?? defaultAdapterForProvider(provider);
  const modelId = options.model ?? options["model-id"] ?? defaultModelForProvider(provider);
  const providerOptions = providerOptionsFromOptions(options);
  return {
    adapter,
    provider,
    modelId,
    ...(providerOptions === undefined ? {} : { providerOptions }),
    nativeTools: nativeToolsFromOptions(options)
  };
}

function defaultAdapterForProvider(provider: string): string {
  if (provider === "fake") {
    return "fake";
  }
  if (provider === OPENAI_PROVIDER) {
    return OPENAI_RESPONSES_ADAPTER_ID;
  }
  if (provider === OPENAI_CHATGPT_PROVIDER) {
    return OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID;
  }
  throw new Error(`Unknown model provider ${provider}`);
}

function defaultModelForProvider(provider: string): string {
  if (provider === "fake") {
    return "fake-text";
  }
  if (provider === OPENAI_PROVIDER) {
    return process.env.HARNESS_MODEL ?? DEFAULT_OPENAI_MODEL;
  }
  if (provider === OPENAI_CHATGPT_PROVIDER) {
    return process.env.HARNESS_MODEL ?? DEFAULT_OPENAI_CHATGPT_MODEL;
  }
  throw new Error(`Unknown model provider ${provider}`);
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function pluginMap(pluginIds: string[]): Record<string, { enabled: boolean }> {
  return Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }]));
}

function arrayOption(options: Record<string, string>, key: string): string[] | undefined {
  return splitList(options[key]);
}

function nativeToolsFromOptions(options: Record<string, string>): Array<{ kind: string; enabled: boolean }> {
  const kinds = new Set(splitList(options["native-tools"]) ?? []);
  if (options["web-search"] === "true") {
    kinds.add("web_search");
  }
  return [...kinds].map((kind) => ({ kind, enabled: true }));
}

function providerOptionsFromOptions(options: Record<string, string>): JsonValue | undefined {
  const providerOptions: Record<string, JsonValue> = {};
  if (options["reasoning-effort"]) {
    providerOptions.reasoning = { effort: options["reasoning-effort"] };
  }
  return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
}

function approvalPolicyFromPreset(preset: string | undefined): ApprovalPolicy | undefined {
  if (!preset) {
    return undefined;
  }
  const normalized = preset.toLowerCase().replace(/\s+/gu, "-");
  if (normalized === "auto" || normalized === "on-request") {
    return { mode: "on-request", allowTools: [], denyTools: [] };
  }
  if (normalized === "ask-always" || normalized === "always") {
    return { mode: "always", allowTools: [], denyTools: [] };
  }
  if (normalized === "read-only" || normalized === "readonly") {
    return {
      mode: "never",
      allowTools: ["read_file", "list_files", "grep", "activity_status", "activity_output"],
      denyTools: ["write_file", "bash", "activity_cancel"]
    };
  }
  if (normalized === "full-access" || normalized === "full") {
    return { mode: "never", allowTools: [], denyTools: [] };
  }
  throw new Error(`Unknown permissions preset: ${preset}`);
}

function defaultApprovalPolicy(): ApprovalPolicy {
  return { mode: "always", allowTools: [], denyTools: [] };
}

function numberOption(options: Record<string, string>, key: string): number | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Option --${key} must be a number`);
  }
  return parsed;
}

function pageOptions(options: Record<string, string>, defaultLimit: number): { after?: number; limit?: number } {
  const after = numberOption(options, "after");
  const limit = numberOption(options, "limit") ?? defaultLimit;
  return {
    ...(after === undefined ? {} : { after }),
    limit
  };
}

function requiredArg(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function defaultDbPath(): string {
  return process.env.HARNESS_DB_PATH ?? path.join(defaultHarnessHome(), "harness.sqlite");
}

function defaultHarnessHome(): string {
  return process.env.HARNESS_HOME ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "harness");
}
