import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command } from "commander";
import {
    createOpenAIChatGptAuthManager,
    type OpenAIChatGptAuthManager,
} from "@harness/auth-openai";
import { HarnessKernel, type ModelAdapter } from "@harness/core";
import {
    DEFAULT_OPENAI_CHATGPT_MODEL,
    OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID,
    OPENAI_CHATGPT_PROVIDER,
    createOpenAIChatGptResponsesModelAdapter,
} from "@harness/model-openai-chatgpt";
import {
    DEFAULT_OPENAI_MODEL,
    OPENAI_PROVIDER,
    OPENAI_RESPONSES_ADAPTER_ID,
    createOpenAIResponsesModelAdapter,
} from "@harness/model-openai";
import type {
    ContentBlock,
    ConversationRecord,
    ModelConfig,
    ProfileConfig,
} from "@harness/protocol";
import { HarnessService } from "@harness/service";
import {
    openSqliteHarnessStore,
    type SqliteHarnessStore,
} from "@harness/store-sqlite";

interface CliApp {
    service: HarnessService;
    store: SqliteHarnessStore;
    openAIAuth: OpenAIChatGptAuthManager;
}

interface CliAuthApp {
    openAIAuth: OpenAIChatGptAuthManager;
}

interface CliProgramOptions {
    createApp?: () => Promise<CliApp>;
    createAuth?: () => CliAuthApp;
}

interface CommonOptions {
    profile?: string;
    provider?: string;
    adapter?: string;
    model?: string;
    modelId?: string;
    prompt?: string;
    message?: string;
    m?: string;
    title?: string;
    select?: boolean;
    device?: boolean;
    open?: boolean;
    json?: boolean;
}

export function createCliProgram(options: CliProgramOptions = {}): Command {
    const withApp = <T extends unknown[]>(
        handler: (app: CliApp, ...args: T) => Promise<void>,
    ) => withCliApp(options.createApp ?? createCliApp, handler);
    const withAuthOnly = <T extends unknown[]>(
        handler: (app: CliAuthApp, ...args: T) => Promise<void>,
    ) => withCliAuth(options.createAuth ?? createCliAuth, handler);
    const program = new Command();
    program
        .name("harness")
        .version("0.0.0")
        .description("clean harness conversation runtime")
        .showHelpAfterError()
        .addHelpText(
            "beforeAll",
            `harness

Config:
  data directory: ${defaultHarnessHome()}
  database: ${defaultDbPath()}
  overrides: HARNESS_HOME, HARNESS_DB_PATH, HARNESS_MODEL, OPENAI_API_KEY
`,
        );

    program.action(async () => {
        if (process.stdin.isTTY && process.stdout.isTTY) {
            await withApp(async (app) => runTui(app, {}))();
            return;
        }
        program.help();
    });

    program
        .command("tui")
        .description("Start an interactive conversation shell")
        .option(
            "--profile <name>",
            "Profile name or built-in: fake, openai, chatgpt",
        )
        .option("--provider <provider>", "Provider override")
        .option("--adapter <adapter>", "Adapter override")
        .option("--model <model>", "Model id override")
        .option("--model-id <modelId>", "Model id override")
        .action(
            withApp(async (app, options: CommonOptions) => {
                await runTui(app, normalizeOptions(options));
            }),
        );

    program
        .command("exec")
        .description("Send one prompt and print the assistant response")
        .argument("[prompt...]", "Prompt text")
        .option("--prompt <prompt>", "Prompt text")
        .option("--message <message>", "Prompt text")
        .option("-m, --m <message>", "Prompt text")
        .option("--profile <name>", "Profile name or built-in")
        .option("--provider <provider>", "Provider override")
        .option("--adapter <adapter>", "Adapter override")
        .option("--model <model>", "Model id override")
        .option("--model-id <modelId>", "Model id override")
        .option("--json", "Print conversation items as JSON")
        .action(
            withApp(
                async (app, promptParts: string[], options: CommonOptions) => {
                    const normalized = normalizeOptions(options);
                    const text = promptText(promptParts, normalized);
                    const conversation = await app.service.createConversation(
                        conversationCreateOptions(
                            normalized,
                            text.slice(0, 80),
                        ),
                    );
                    await app.service.send(conversation.id, textBlocks(text));
                    const items = await app.service.listItems(conversation.id);
                    if (normalized.json) {
                        console.log(JSON.stringify(items, null, 2));
                        return;
                    }
                    const assistant = items
                        .filter((item) => item.kind === "assistant_message")
                        .at(-1);
                    if (assistant) {
                        console.log(renderBlocks(assistant.content));
                    }
                },
            ),
        );

    const profiles = program
        .command("profiles")
        .description("Manage durable profiles");
    profiles
        .command("create")
        .argument("<name>", "Profile name")
        .option("--provider <provider>", "Provider", "fake")
        .option("--adapter <adapter>", "Adapter")
        .option("--model <model>", "Model id")
        .option("--model-id <modelId>", "Model id")
        .option("--prompt <text>", "System prompt fragment")
        .option("--select", "Select as default")
        .action(
            withApp(async (app, name: string, options: CommonOptions) => {
                const config = profileConfigFromOptions(
                    normalizeOptions(options),
                    name,
                ) ?? {
                    model: {
                        provider: "fake",
                        adapter: "fake",
                        modelId: "fake-text",
                    },
                    promptFragments: [],
                };
                const profile = await app.service.createProfile({
                    name,
                    config,
                    select: options.select ?? false,
                });
                console.log(
                    `${profile.name} ${profile.config.model.provider}/${profile.config.model.adapter}/${profile.config.model.modelId}`,
                );
            }),
        );
    profiles
        .command("list")
        .description("List profiles")
        .action(
            withApp(async (app) => {
                const profilesList = await app.service.listProfiles();
                console.log(
                    profilesList
                        .map(
                            (profile) =>
                                `${profile.name}\t${profile.config.model.provider}/${profile.config.model.adapter}/${profile.config.model.modelId}`,
                        )
                        .join("\n"),
                );
            }),
        );
    profiles
        .command("select")
        .argument("<name>")
        .description("Set default profile")
        .action(
            withApp(async (app, name: string) => {
                const profile = await app.service.selectProfile(name);
                console.log(`selected ${profile.name}`);
            }),
        );

    const auth = program.command("auth").description("Manage ChatGPT auth");
    auth.command("status").action(
        withAuthOnly(async (app) => {
            console.log(JSON.stringify(await app.openAIAuth.status(), null, 2));
        }),
    );
    auth.command("login")
        .option("--device", "Use device code flow")
        .option("--no-open", "Do not open a browser")
        .action(
            withAuthOnly(async (app, options: CommonOptions) => {
                if (options.device) {
                    await app.openAIAuth.loginWithDeviceCode({
                        onDeviceCode: (info) => {
                            console.log(`Open ${info.verificationUrl}`);
                            console.log(`Code ${info.userCode}`);
                        },
                    });
                } else {
                    await app.openAIAuth.loginWithBrowser({
                        openBrowser: options.open !== false,
                        onAuthUrl: (url) => console.log(url),
                    });
                }
                console.log("logged in");
            }),
        );
    auth.command("logout").action(
        withAuthOnly(async (app) => {
            console.log(
                JSON.stringify(
                    { deleted: await app.openAIAuth.logout() },
                    null,
                    2,
                ),
            );
        }),
    );

    const conversation = program
        .command("conversation")
        .description("Manage conversations");
    conversation
        .command("start")
        .option("--message <message>", "User message")
        .option("-m, --m <message>", "User message")
        .option("--title <title>", "Conversation title")
        .option("--profile <name>", "Profile name or built-in")
        .option("--provider <provider>", "Provider override")
        .option("--adapter <adapter>", "Adapter override")
        .option("--model <model>", "Model id override")
        .option("--model-id <modelId>", "Model id override")
        .option("--json", "Print items as JSON")
        .action(
            withApp(async (app, options: CommonOptions) => {
                const normalized = normalizeOptions(options);
                const text = requiredText(
                    normalized.message ?? normalized.m,
                    "message",
                );
                const created = await app.service.createConversation(
                    conversationCreateOptions(
                        normalized,
                        normalized.title ?? text.slice(0, 80),
                    ),
                );
                await app.service.send(created.id, textBlocks(text));
                await printConversationItems(
                    app.service,
                    created.id,
                    normalized.json === true,
                );
            }),
        );
    conversation
        .command("continue")
        .argument("<conversationId>")
        .option("--message <message>", "User message")
        .option("-m, --m <message>", "User message")
        .option("--json", "Print items as JSON")
        .action(
            withApp(
                async (app, conversationId: string, options: CommonOptions) => {
                    const normalized = normalizeOptions(options);
                    const text = requiredText(
                        normalized.message ?? normalized.m,
                        "message",
                    );
                    await app.service.send(conversationId, textBlocks(text));
                    await printConversationItems(
                        app.service,
                        conversationId,
                        normalized.json === true,
                    );
                },
            ),
        );
    conversation
        .command("queue")
        .argument("<conversationId>")
        .option("--message <message>")
        .option("-m, --m <message>")
        .action(
            withApp(
                async (app, conversationId: string, options: CommonOptions) => {
                    const normalized = normalizeOptions(options);
                    const item = await app.service.queue(
                        conversationId,
                        textBlocks(
                            requiredText(
                                normalized.message ?? normalized.m,
                                "message",
                            ),
                        ),
                    );
                    console.log(`queued item ${item.sequence}`);
                },
            ),
        );
    conversation
        .command("manual")
        .argument("<conversationId>")
        .option("--message <message>")
        .option("-m, --m <message>")
        .action(
            withApp(
                async (app, conversationId: string, options: CommonOptions) => {
                    const normalized = normalizeOptions(options);
                    const item = await app.service.manual(
                        conversationId,
                        textBlocks(
                            requiredText(
                                normalized.message ?? normalized.m,
                                "message",
                            ),
                        ),
                    );
                    console.log(`manual item ${item.sequence}`);
                },
            ),
        );
    conversation
        .command("interrupt")
        .argument("<conversationId>")
        .option("--message <message>")
        .option("-m, --m <message>")
        .action(
            withApp(
                async (app, conversationId: string, options: CommonOptions) => {
                    const normalized = normalizeOptions(options);
                    const item = await app.service.interrupt(
                        conversationId,
                        textBlocks(
                            requiredText(
                                normalized.message ?? normalized.m,
                                "message",
                            ),
                        ),
                    );
                    console.log(`interrupt item ${item.sequence}`);
                },
            ),
        );
    conversation
        .command("show")
        .argument("<conversationId>")
        .action(
            withApp(async (app, conversationId: string) => {
                console.log(
                    JSON.stringify(
                        (await app.service.getConversation(conversationId)) ??
                            null,
                        null,
                        2,
                    ),
                );
            }),
        );
    conversation.command("list").action(
        withApp(async (app) => {
            console.log(
                renderConversations(await app.service.listConversations()),
            );
        }),
    );

    program
        .command("items")
        .argument("<conversationId>")
        .option("--after <n>")
        .option("--limit <n>")
        .action(
            withApp(
                async (
                    app,
                    conversationId: string,
                    options: { after?: string; limit?: string },
                ) => {
                    console.log(
                        JSON.stringify(
                            await app.service.listItems(
                                conversationId,
                                pageOptions(options),
                            ),
                            null,
                            2,
                        ),
                    );
                },
            ),
        );
    program
        .command("runs")
        .argument("<conversationId>")
        .action(
            withApp(async (app, conversationId: string) => {
                console.log(
                    JSON.stringify(
                        await app.service.listAgentRuns(conversationId),
                        null,
                        2,
                    ),
                );
            }),
        );

    const context = program
        .command("context")
        .description("Inspect context selection");
    context
        .command("builds")
        .argument("<conversationId>")
        .action(
            withApp(async (app, conversationId: string) => {
                console.log(
                    JSON.stringify(
                        await app.service.listContextBuilds(conversationId),
                        null,
                        2,
                    ),
                );
            }),
        );
    context
        .command("projections")
        .argument("<conversationId>")
        .action(
            withApp(async (app, conversationId: string) => {
                console.log(
                    JSON.stringify(
                        await app.service.listContextProjections(
                            conversationId,
                        ),
                        null,
                        2,
                    ),
                );
            }),
        );

    const compaction = program
        .command("compaction")
        .description("Compact model-visible transcript into a projection");
    compaction
        .command("run")
        .argument("<conversationId>")
        .action(
            withApp(async (app, conversationId: string) => {
                console.log(
                    JSON.stringify(
                        await app.service.runCompaction(conversationId),
                        null,
                        2,
                    ),
                );
            }),
        );

    return program;
}

export async function runCli(argv: string[]): Promise<void> {
    await createCliProgram().parseAsync(argv, { from: "user" });
}

export async function main(argv: string[]): Promise<void> {
    await runCli(argv);
}

async function createCliApp(): Promise<CliApp> {
    await fs.mkdir(defaultHarnessHome(), { recursive: true });
    const store = openSqliteHarnessStore({ path: defaultDbPath() });
    const openAIAuth = createCliAuth().openAIAuth;
    const models: ModelAdapter[] = [
        createOpenAIResponsesModelAdapter(),
        createOpenAIChatGptResponsesModelAdapter({ auth: openAIAuth }),
    ];
    const kernel = new HarnessKernel({ store, models });
    const service = new HarnessService(kernel);
    return { service, store, openAIAuth };
}

function createCliAuth(): CliAuthApp {
    return {
        openAIAuth: createOpenAIChatGptAuthManager({
            harnessHome: defaultHarnessHome(),
        }),
    };
}

function withCliApp<T extends unknown[]>(
    createApp: () => Promise<CliApp>,
    handler: (app: CliApp, ...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
    return async (...args) => {
        const app = await createApp();
        try {
            await handler(app, ...args);
        } finally {
            app.store.close();
        }
    };
}

function withCliAuth<T extends unknown[]>(
    createAuth: () => CliAuthApp,
    handler: (app: CliAuthApp, ...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
    return async (...args) => {
        await handler(createAuth(), ...args);
    };
}

async function runTui(app: CliApp, options: CommonOptions): Promise<void> {
    let conversation: ConversationRecord | undefined;
    let lastPrintedSequence = 0;
    const rl = createInterface({ input, output });
    console.log("Harness");
    console.log(
        "Commands: /exit, /conversation, /items, /compact, /manual <text>, /queue <text>, /interrupt <text>",
    );
    try {
        for (;;) {
            const line = await rl.question("> ");
            const trimmed = line.trim();
            if (trimmed === "/exit" || trimmed === "/quit") {
                return;
            }
            if (trimmed.length === 0) {
                continue;
            }
            if (trimmed === "/conversation") {
                console.log(conversation ? conversation.id : "no conversation");
                continue;
            }
            if (!conversation) {
                conversation = await app.service.createConversation(
                    conversationCreateOptions(options, trimmed.slice(0, 80)),
                );
            }
            if (trimmed === "/items") {
                console.log(
                    JSON.stringify(
                        await app.service.listItems(conversation.id),
                        null,
                        2,
                    ),
                );
                continue;
            }
            if (trimmed === "/compact") {
                const projection = await app.service.runCompaction(
                    conversation.id,
                );
                console.log(`projection item ${projection.sequence}`);
                continue;
            }
            if (trimmed.startsWith("/manual ")) {
                const item = await app.service.manual(
                    conversation.id,
                    textBlocks(trimmed.slice("/manual ".length)),
                );
                console.log(`manual item ${item.sequence}`);
                continue;
            }
            if (trimmed.startsWith("/queue ")) {
                await app.service.queue(
                    conversation.id,
                    textBlocks(trimmed.slice("/queue ".length)),
                );
                lastPrintedSequence = await printNewItems(
                    app.service,
                    conversation.id,
                    lastPrintedSequence,
                );
                continue;
            }
            if (trimmed.startsWith("/interrupt ")) {
                await app.service.interrupt(
                    conversation.id,
                    textBlocks(trimmed.slice("/interrupt ".length)),
                );
                lastPrintedSequence = await printNewItems(
                    app.service,
                    conversation.id,
                    lastPrintedSequence,
                );
                continue;
            }
            await app.service.send(conversation.id, textBlocks(trimmed));
            lastPrintedSequence = await printNewItems(
                app.service,
                conversation.id,
                lastPrintedSequence,
            );
        }
    } finally {
        rl.close();
    }
}

function conversationCreateOptions(
    options: CommonOptions,
    title?: string,
): { profileName?: string; profileConfig?: ProfileConfig; title?: string } {
    const config = profileConfigFromOptions(options, options.profile);
    const hasExplicitModel =
        options.provider !== undefined ||
        options.adapter !== undefined ||
        options.model !== undefined ||
        options.modelId !== undefined;
    return {
        ...(!hasExplicitModel &&
        options.profile &&
        !builtInModelConfig(options.profile)
            ? { profileName: options.profile }
            : {}),
        ...(config ? { profileConfig: config } : {}),
        ...(title ? { title } : {}),
    };
}

function profileConfigFromOptions(
    options: CommonOptions,
    profileName?: string,
): ProfileConfig | undefined {
    const base =
        builtInModelConfig(profileName) ??
        (options.provider ? builtInModelConfig(options.provider) : undefined);
    if (
        !base &&
        !options.provider &&
        !options.adapter &&
        !options.model &&
        !options.modelId &&
        !options.prompt
    ) {
        return undefined;
    }
    const provider = options.provider ?? base?.provider ?? "fake";
    const adapter =
        options.adapter ?? base?.adapter ?? defaultAdapterForProvider(provider);
    const modelId =
        options.modelId ??
        options.model ??
        base?.modelId ??
        defaultModelForProvider(provider);
    return {
        model: {
            provider,
            adapter,
            modelId,
        },
        promptFragments: options.prompt ? [options.prompt] : [],
    };
}

function builtInModelConfig(name: string | undefined): ModelConfig | undefined {
    if (!name) {
        return undefined;
    }
    switch (name) {
        case "fake":
            return { provider: "fake", adapter: "fake", modelId: "fake-text" };
        case "openai":
            return {
                provider: OPENAI_PROVIDER,
                adapter: OPENAI_RESPONSES_ADAPTER_ID,
                modelId: DEFAULT_OPENAI_MODEL,
            };
        case "chatgpt":
        case "openai-chatgpt":
            return {
                provider: OPENAI_CHATGPT_PROVIDER,
                adapter: OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID,
                modelId: DEFAULT_OPENAI_CHATGPT_MODEL,
            };
        default:
            return undefined;
    }
}

function defaultAdapterForProvider(provider: string): string {
    if (provider === OPENAI_PROVIDER) {
        return OPENAI_RESPONSES_ADAPTER_ID;
    }
    if (provider === OPENAI_CHATGPT_PROVIDER) {
        return OPENAI_CHATGPT_CODEX_RESPONSES_ADAPTER_ID;
    }
    if (provider === "fake") {
        return "fake";
    }
    return "default";
}

function defaultModelForProvider(provider: string): string {
    if (provider === OPENAI_PROVIDER) {
        return DEFAULT_OPENAI_MODEL;
    }
    if (provider === OPENAI_CHATGPT_PROVIDER) {
        return DEFAULT_OPENAI_CHATGPT_MODEL;
    }
    if (provider === "fake") {
        return "fake-text";
    }
    return "default";
}

function normalizeOptions(options: object): CommonOptions {
    const normalized: CommonOptions = {};
    for (const [key, value] of Object.entries(
        options as Record<string, unknown>,
    )) {
        if (value !== undefined) {
            (normalized as Record<string, unknown>)[key] = value;
        }
    }
    return normalized;
}

function promptText(promptParts: string[], options: CommonOptions): string {
    return requiredText(
        options.prompt ?? options.message ?? options.m ?? promptParts.join(" "),
        "prompt",
    );
}

function requiredText(value: string | undefined, label: string): string {
    const text = value?.trim() ?? "";
    if (text.length === 0) {
        throw new Error(`${label} is required`);
    }
    return text;
}

function textBlocks(text: string): ContentBlock[] {
    return [{ type: "text", text }];
}

async function printConversationItems(
    service: HarnessService,
    conversationId: string,
    json: boolean,
): Promise<void> {
    const items = await service.listItems(conversationId);
    if (json) {
        console.log(JSON.stringify(items, null, 2));
        return;
    }
    for (const item of items) {
        if (item.class === "transcript" && item.kind === "user_message") {
            console.log(`user> ${renderBlocks(item.content)}`);
        }
        if (item.class === "transcript" && item.kind === "assistant_message") {
            console.log(`assistant> ${renderBlocks(item.content)}`);
        }
    }
}

async function printNewItems(
    service: HarnessService,
    conversationId: string,
    after: number,
): Promise<number> {
    const items = await service.listItems(conversationId, { after });
    for (const item of items) {
        if (item.class === "transcript" && item.kind === "user_message") {
            console.log(`user> ${renderBlocks(item.content)}`);
        }
        if (item.class === "transcript" && item.kind === "assistant_message") {
            console.log(`assistant> ${renderBlocks(item.content)}`);
        }
        if (item.visibility === "ui" && item.kind === "model_error") {
            console.log(`error> ${renderBlocks(item.content)}`);
        }
    }
    return items.at(-1)?.sequence ?? after;
}

function renderBlocks(blocks: ContentBlock[]): string {
    return blocks
        .map((block) =>
            block.type === "text" ? block.text : JSON.stringify(block.data),
        )
        .join("\n");
}

function renderConversations(conversations: ConversationRecord[]): string {
    return conversations
        .map(
            (conversation) =>
                `${conversation.id}\t${conversation.status}\t${conversation.title ?? ""}`,
        )
        .join("\n");
}

function pageOptions(options: { after?: string; limit?: string }): {
    after?: number;
    limit?: number;
} {
    return {
        ...(options.after ? { after: Number.parseInt(options.after, 10) } : {}),
        ...(options.limit ? { limit: Number.parseInt(options.limit, 10) } : {}),
    };
}

export function defaultHarnessHome(): string {
    return process.env.HARNESS_HOME ?? path.join(homedir(), ".harness");
}

export function defaultDbPath(): string {
    return (
        process.env.HARNESS_DB_PATH ??
        path.join(defaultHarnessHome(), "harness.sqlite")
    );
}
