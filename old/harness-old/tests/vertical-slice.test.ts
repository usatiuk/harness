import { execFileSync } from "node:child_process";
import { mkdtempSync, promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { SOURCE_FIRST_MARKER as coreMarker, type ActiveProcess, type ExecutionCommandInput, type ExecutionCommandOutput, type ExecutionOutputSinks, type HarnessPlugin, type HarnessTool, type ModelAdapter, type ToolOutputPresenter } from "@harness/core";
import { mapMcpElicitationToInteraction } from "@harness/plugin-mcp";
import { SOURCE_FIRST_MARKER as protocolMarker, profileConfigSchema, type JsonValue, type ModelConfig, type ModelStepInput, type ModelStepResult, type ContentBlock, type ToolCall } from "@harness/protocol";
import { createHostExecutionProvider } from "@harness/sandbox-host";
import { TASKS_NAMESPACE } from "@harness/plugin-tasks";
import { BASIC_TOOLS_PLUGIN_ID } from "@harness/tools-basic";
import {
  createFakeMultimodalModel,
  FakeExecutionProvider,
  FakeExecutionRuntime,
  createMemoryTestHarness,
  createSqliteTestHarnessAtPath,
  createTempSqliteTestHarness,
  RecordingFakeModelAdapter
} from "@harness/testkit";
import { parseSlashCommand } from "../apps/harness-cli/src/tui.tsx";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("source-first workspace", () => {
  test("imports workspace packages from TypeScript source and runs CLI dev without build", () => {
    expect(coreMarker).toBe("core:src");
    expect(protocolMarker).toBe("protocol:src");
    const harnessHome = mkdtempSync(path.join(tmpdir(), "harness-home-"));
    const output = execFileSync("npm", ["run", "dev", "--", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, HARNESS_HOME: harnessHome }
    });
    expect(output).toContain("harness v0");
    expect(output).toContain(`data directory: ${harnessHome}`);
  });

  test("exposes TUI help and non-interactive exec through the CLI", () => {
    const harnessHome = mkdtempSync(path.join(tmpdir(), "harness-cli-"));
    const env = { ...process.env, HARNESS_HOME: harnessHome };
    const tuiHelp = execFileSync("npm", ["run", "dev", "--", "tui", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env
    });
    expect(tuiHelp).toContain("harness tui");

    const execOutput = execFileSync("npm", ["run", "dev", "--", "exec", "hello from exec"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env
    });
    expect(execOutput).toContain("fake model saw");

    const profileOutput = execFileSync("npm", [
      "run", "dev", "--", "profiles", "create", "oa",
      "--provider=openai",
      "--model=gpt-5.5",
      "--web-search",
      "--reasoning-effort=low",
      "--permissions=read-only"
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env
    });
    const profile = JSON.parse(profileOutput.slice(profileOutput.indexOf("{"))) as { config: { model: { provider: string; modelId: string; nativeTools: Array<{ kind: string }> }; approvalPolicy: { denyTools: string[] } } };
    expect(profile.config.model).toMatchObject({ provider: "openai", modelId: "gpt-5.5" });
    expect(profile.config.model.nativeTools).toEqual([{ kind: "web_search", enabled: true }]);
    expect(profile.config.approvalPolicy.denyTools).toContain("bash");

    let invalidProviderError: unknown;
    try {
      execFileSync("npm", ["run", "dev", "--", "profiles", "create", "bad-provider", "--provider=typo"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env
      });
    } catch (error) {
      invalidProviderError = error;
    }
    expect(String((invalidProviderError as { stderr?: string })?.stderr ?? invalidProviderError)).toContain("Unknown model provider typo");
    const profilesOutput = execFileSync("npm", ["run", "dev", "--", "profiles", "list"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env
    });
    expect(profilesOutput).not.toContain("bad-provider");
  });

  test("parses TUI slash commands", () => {
    expect(parseSlashCommand("/resume conv_123")).toEqual({ name: "resume", args: ["conv_123"] });
    expect(parseSlashCommand("plain prompt")).toBeUndefined();
  });
});

describe("vertical slice", () => {
  test("supports projectless and project-bound conversations, profiles, tools, events, state, and child conversations", async () => {
    const harness = await createMemoryTestHarness();
    const profile = await harness.service.createProfile({
      name: "dev",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: ["bash", "read_file", "write_file", "list_files", "grep"],
        plugins: {
          "plugin.control": { enabled: true },
          [TASKS_NAMESPACE]: { enabled: true },
          "plugin.subagents": { enabled: true },
          "plugin.mcp": {
            enabled: true,
            config: {
              servers: {
                local: {
                  command: "node",
                  args: ["server.js"],
                  env: { MCP_ENV: "test" },
                  enabled: true
                },
                disabled: {
                  command: "node",
                  args: ["disabled.js"],
                  env: {},
                  enabled: false
                }
              }
            }
          }
        }
      })
    });
    await harness.service.selectProfile(profile.id);

    const profiles = await harness.service.listProfiles();
    expect(profiles.map((item) => item.name)).toContain("dev");

    const projectless = await harness.service.startConversation({
      message: [{ type: "text", text: "projectless hello" }],
      title: "projectless"
    });
    expect(projectless.status).toBe("completed");
    expect(projectless.executionContextId).toBeUndefined();
    const projectlessTurns = await harness.service.listTurns(projectless.id);
    expect(projectlessTurns).toHaveLength(1);
    const projectlessState = await harness.service.getTurnState(projectlessTurns[0]?.id ?? "");
    expect(projectlessState?.phase).toBe("completed");

    const overridden = await harness.service.createProjectlessConversation({
      profile: "dev",
      profileOverrides: { model: { adapter: "fake", provider: "fake", modelId: "override-model", nativeTools: [] } },
      title: "override"
    });
    expect(overridden.effectiveProfile.config.model.modelId).toBe("override-model");
    expect(overridden.effectiveProfile.config.plugins["plugin.mcp"]?.config).toMatchObject({
      servers: {
        local: { command: "node" }
      }
    });

    const lateBindDir = await mkdtemp(path.join(tmpdir(), "harness-late-bind-"));
    const lateBound = await harness.service.bindHostProject(overridden.id, lateBindDir);
    expect(lateBound.executionContextId).toBeTruthy();

    const projectDir = await mkdtemp(path.join(tmpdir(), "harness-project-"));
    const projectConversation = await harness.service.startConversation({
      message: [{ type: "text", text: "please run tool:bash" }],
      projectPath: projectDir,
      title: "project-bound"
    });
    expect(projectConversation.status).toBe("completed");
    expect(projectConversation.executionContextId).toBeTruthy();

    const activities = await harness.service.listActivities(projectConversation.id);
    expect(activities.map((activity) => activity.kind)).toContain("plugin.bash.run");
    const bashActivity = activities.find((activity) => activity.kind === "plugin.bash.run");
    expect(bashActivity?.ownerPluginId).toBe(BASIC_TOOLS_PLUGIN_ID);

    const toolExecutions = await harness.kernel.store.listToolExecutions(projectConversation.id);
    expect(toolExecutions).toHaveLength(1);
    expect(toolExecutions[0]?.toolName).toBe("bash");
    expect(toolExecutions[0]?.createdActivityIds).toEqual([bashActivity?.id]);

    const eventsPage = await harness.service.listEvents(projectConversation.id, { limit: 2 });
    expect(eventsPage).toHaveLength(2);
    const nextEvents = await harness.service.listEvents(projectConversation.id, { after: eventsPage[1]?.sequence ?? 0, limit: 10 });
    expect(nextEvents.length).toBeGreaterThan(0);
    expect(nextEvents.some((event) => event.turnId)).toBe(true);

    const bashOutput = await harness.service.peekActivityOutput(bashActivity?.id ?? "", { limit: 10 });
    expect(bashOutput?.channels.map((channel) => channel.kind)).toEqual(expect.arrayContaining(["stdout", "stderr"]));
    expect(bashOutput?.frames.map((frame) => frame.text ?? "").join("")).toContain("fake-tool");

    const fakeConv = await harness.kernel.createConversation({ profileId: profile.id, title: "fake execution" });
    const fakeContext = await harness.kernel.createExecutionContext({ conversationId: fakeConv.id, providerKind: "fake" });
    await harness.kernel.attachExecutionContext(fakeConv.id, fakeContext.id);
    await harness.kernel.addMessage({ conversationId: fakeConv.id, role: "user", content: [{ type: "text", text: "tool:bash" }] });
    await harness.kernel.runModelStep(fakeConv.id);
    const fakeActivity = (await harness.service.listActivities(fakeConv.id)).find((activity) => activity.kind === "plugin.bash.run");
    const fakeOutput = await harness.service.peekActivityOutput(fakeActivity?.id ?? "", { limit: 10 });
    expect(fakeOutput?.frames.map((frame) => frame.text ?? "").join("")).toContain("fake stdout");

    const taskState = await harness.service.addTask(projectless.id, "track this") as { tasks: Array<{ title: string }> };
    expect(taskState.tasks[0]?.title).toBe("track this");
    const states = await harness.service.listState(projectless.id);
    expect(states.map((state) => state.namespace)).toContain(TASKS_NAMESPACE);

    const delegated = await harness.service.delegateSubagent({ parentConversationId: projectless.id, prompt: "child prompt" });
    expect(delegated.childConversation.parentConversationId).toBe(projectless.id);
    const parentActivities = await harness.service.listActivities(projectless.id);
    expect(parentActivities.map((activity) => activity.kind)).toContain("plugin.subagents.run");
  });

  test("preserves asset references and exposes asset metadata without a multimodal plugin", async () => {
    const model = new RecordingFakeModelAdapter();
    const harness = await createMemoryTestHarness({ model });
    await harness.service.createProfile({
      name: "assets",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [],
        plugins: {}
      })
    });
    await harness.service.selectProfile("assets");

    const imagePath = await writeFakeImage();
    const conversation = await harness.service.startConversation({
      message: [{ type: "text", text: "image input" }],
      attachments: [
        {
          uri: pathToFileURL(imagePath).toString(),
          mimeType: "image/png",
          byteSize: 8,
          origin: { kind: "user_upload", detail: { path: imagePath } },
          metadata: { filename: path.basename(imagePath) },
          contentBlock: { type: "image_ref", assetId: "pending", alt: "fake image" }
        }
      ]
    });

    const assets = await harness.service.listAssets(conversation.id);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.mimeType).toBe("image/png");
    const input = model.inputs.at(-1);
    expect(input?.unsupportedInputBlocks[0]?.type).toBe("image_ref");
    expect(input?.messages.flatMap((m: any) => m.content).some((b: any) => b.type === "image_ref")).toBe(true);
  });

  test("fake multimodal-capable model can accept image references without dropping protocol blocks", async () => {
    const model = createFakeMultimodalModel();
    const harness = await createMemoryTestHarness({ model });
    await harness.service.createProfile({
      name: "multimodal",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-multimodal" },
        enabledTools: [],
        plugins: {}
      })
    });
    await harness.service.selectProfile("multimodal");
    const imagePath = await writeFakeImage();

    await harness.service.startConversation({
      message: [{ type: "text", text: "multimodal image" }],
      attachments: [
        {
          uri: pathToFileURL(imagePath).toString(),
          mimeType: "image/png",
          byteSize: 8,
          origin: { kind: "user_upload", detail: { path: imagePath } },
          metadata: { filename: path.basename(imagePath) },
          contentBlock: { type: "image_ref", assetId: "pending", alt: "fake image" }
        }
      ]
    });

    const input = model.inputs.at(-1);
    expect(input?.unsupportedInputBlocks).toHaveLength(0);
    expect(input?.messages.flatMap((m: any) => m.content).some((b: any) => b.type === "image_ref")).toBe(true);
  });

  test("passes provider-native web search to the adapter and records provider events without tool activities", async () => {
    const harness = await createMemoryTestHarness();
    await harness.service.createProfile({
      name: "native",
      config: profileConfigSchema.parse({
        model: {
          adapter: "fake",
          provider: "fake",
          modelId: "fake-text",
          nativeTools: [{ kind: "web_search", enabled: true }]
        },
        enabledTools: [],
        plugins: {}
      })
    });
    await harness.service.selectProfile("native");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "search natively" }] });
    const input = harness.model.inputs.at(-1);
    expect(input?.modelConfig.nativeTools[0]?.kind).toBe("web_search");
    expect((await harness.service.listActivities(conversation.id)).map((activity) => activity.kind)).not.toContain("tool.execution");
    const providerEvents = await harness.service.listProviderEvents(conversation.id, { limit: 20 });
    expect(providerEvents).toHaveLength(1);
    expect(providerEvents[0]?.payload).toMatchObject({ kind: "native_tool.web_search" });
  });

  test("selects model adapters by effective profile config", async () => {
    const openaiLike = new TaggedModelAdapter("responses", "openai", "openai adapter response");
    const harness = await createMemoryTestHarness({ models: [openaiLike] });
    await harness.service.createProfile({
      name: "openai-profile",
      config: profileConfigSchema.parse({
        model: { adapter: "responses", provider: "openai", modelId: "gpt-test", nativeTools: [] },
        enabledTools: [],
        plugins: {}
      })
    });
    await harness.service.selectProfile("openai-profile");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "use openai-like adapter" }] });

    expect(conversation.status).toBe("completed");
    expect(openaiLike.inputs).toHaveLength(1);
    expect(harness.model.inputs).toHaveLength(0);
    expect(openaiLike.inputs[0]?.modelConfig).toMatchObject({ provider: "openai", adapter: "responses", modelId: "gpt-test" });
  });

  test("tool descriptors include JSON schemas in model context", async () => {
    const harness = await createMemoryTestHarness();
    await harness.service.createProfile({
      name: "tool-schema",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: ["read_file"],
        plugins: {}
      })
    });
    await harness.service.selectProfile("tool-schema");

    await harness.service.startConversation({ message: [{ type: "text", text: "inspect tools" }] });

    const readFile = harness.model.inputs.at(-1)?.availableTools.find((tool) => tool.name === "read_file");
    expect(readFile?.inputSchema).toMatchObject({
      type: "object",
      required: ["path"]
    });
  });

  test("assistant tool call references persist the original tool input", async () => {
    const model = new RecordingFakeModelAdapter({
      toolCall: { id: "call_input", name: "bash", input: { command: "echo persisted" } }
    });
    const harness = await createMemoryTestHarness({ model });
    await harness.service.createProfile({
      name: "tool-call-input",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: ["bash"],
        plugins: {}
      })
    });
    await harness.service.selectProfile("tool-call-input");
    const conversation = await harness.kernel.createConversation({ profileName: "tool-call-input", title: "tool call input" });
    const context = await harness.kernel.createExecutionContext({ conversationId: conversation.id, providerKind: "fake" });
    await harness.kernel.attachExecutionContext(conversation.id, context.id);

    await harness.service.continueConversation(conversation.id, [{ type: "text", text: "run tool" }]);

    const messages = await harness.kernel.store.listMessages(conversation.id);
    const toolCallRef = messages
      .find((message) => message.role === "assistant")
      ?.content.find((block) => block.type === "tool_call_ref");
    expect(toolCallRef).toMatchObject({
      toolCallId: "call_input",
      toolName: "bash",
      input: { command: "echo persisted" }
    });
  });

  test("model failures mark the turn and conversation failed and emit model.failed", async () => {
    const model = new FailingModelAdapter();
    const harness = await createMemoryTestHarness({ model });
    await harness.service.createProfile({
      name: "failing-model",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [],
        plugins: {}
      })
    });
    await harness.service.selectProfile("failing-model");

    await expect(harness.service.startConversation({
      message: [{ type: "text", text: "trigger failure" }],
      title: "failing conversation"
    })).rejects.toThrow("model exploded");

    const conversation = (await harness.service.listConversations()).find((item) => item.title === "failing conversation");
    expect(conversation?.status).toBe("failed");
    const turn = (await harness.service.listTurns(conversation?.id ?? ""))[0];
    expect(turn?.status).toBe("failed");
    const events = await harness.service.listEvents(conversation?.id ?? "", { limit: 50 });
    expect(events.find((event) => event.type === "model.failed")?.payload).toMatchObject({
      message: "model exploded",
      name: "Error"
    });
  });

  test("failed streaming model calls persist no partial assistant message or durable output", async () => {
    const model = new StreamingFailingModelAdapter();
    const harness = await createTempSqliteTestHarness({ model });
    try {
      await harness.service.createProfile({
        name: "streaming-failing-model",
        config: profileConfigSchema.parse({
          model: { adapter: "fake", modelId: "fake-text" },
          enabledTools: [],
          plugins: {}
        })
      });
      await harness.service.selectProfile("streaming-failing-model");

      await expect(harness.service.startConversation({
        message: [{ type: "text", text: "trigger streaming failure" }],
        title: "streaming failing conversation"
      })).rejects.toThrow("stream failed");

      const conversation = (await harness.service.listConversations()).find((item) => item.title === "streaming failing conversation");
      const messages = await harness.kernel.store.listMessages(conversation?.id ?? "");
      expect(messages.some((message) => message.role === "assistant")).toBe(false);
      const events = await harness.service.listEvents(conversation?.id ?? "", { limit: 50 });
      expect(events.map((event) => event.type)).toContain("model.failed");
    } finally {
      if ("close" in harness.store) {
        harness.store.close();
      }
    }
  });

  test("waiting tools create interactions and answering resumes the original tool execution", async () => {
    const waitingTool = createWaitingTool();
    const model = new RecordingFakeModelAdapter({
      toolCall: { id: "call_wait", name: waitingTool.name, input: {} }
    });
    const harness = await createMemoryTestHarness({ model, tools: [waitingTool] });
    await harness.service.createProfile({
      name: "waiting",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [waitingTool.name],
        plugins: {}
      })
    });
    await harness.service.selectProfile("waiting");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "ask me" }] });
    expect(conversation.status).toBe("waiting");
    const turns = await harness.service.listTurns(conversation.id);
    expect(turns[0]?.status).toBe("waiting");
    const interactions = await harness.service.listPendingInteractions(conversation.id);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.kind).toBe("user_input");

    const toolExecutions = await harness.kernel.store.listToolExecutions(conversation.id);
    const toolExec = toolExecutions.find((item) => item.toolCallId === "call_wait");
    expect(toolExec?.status).toBe("waiting");

    await harness.service.answerInteraction(interactions[0]?.id ?? "", { text: "approved" });
    const completedConversation = await harness.service.getConversation(conversation.id);
    expect(completedConversation?.status).toBe("completed");
    const completedToolExec = await harness.kernel.store.getToolExecution(toolExec?.id ?? "");
    expect(completedToolExec?.status).toBe("completed");
    const state = await harness.service.getTurnState(turns[0]?.id ?? "");
    expect(state?.phase).toBe("completed");
  });

  test("failed tool calls still create matching tool result transcript messages", async () => {
    const throwingTool = createThrowingTool("throw_once");
    const model = new SequencedModelAdapter([
      {
        content: [{ type: "text", text: "trying tool" }],
        toolCalls: [{ id: "call_throw", name: throwingTool.name, input: {} }]
      },
      {
        content: [{ type: "text", text: "saw tool failure" }],
        toolCalls: []
      }
    ]);
    const harness = await createMemoryTestHarness({ model, tools: [throwingTool] });
    await harness.service.createProfile({
      name: "tool-failure-transcript",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [throwingTool.name],
        plugins: {}
      })
    });
    await harness.service.selectProfile("tool-failure-transcript");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "call throwing tool" }] });

    expect(conversation.status).toBe("completed");
    const toolMessages = (await harness.kernel.store.listMessages(conversation.id)).filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContainEqual(expect.objectContaining({
      type: "tool_result_ref",
      toolCallId: "call_throw",
      status: "error"
    }));
    const toolExecutions = await harness.kernel.store.listToolExecutions(conversation.id);
    expect(toolExecutions).toHaveLength(1);
    expect(toolExecutions[0]).toMatchObject({
      toolCallId: "call_throw",
      status: "failed",
      result: expect.objectContaining({ toolCallId: "call_throw", status: "error" })
    });
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[1]?.messages.some((message) =>
      message.role === "tool" &&
      message.content.some((block) => block.type === "tool_result_ref" && block.toolCallId === "call_throw")
    )).toBe(true);
  });

  test("waiting tool resume preserves and completes the rest of the model batch", async () => {
    const waitingTool = createWaitingTool();
    const immediateTool = createCountingTool("after_wait");
    const model = new SequencedModelAdapter([
      {
        content: [{ type: "text", text: "batch with wait first" }],
        toolCalls: [
          { id: "call_wait", name: waitingTool.name, input: {} },
          { id: "call_after_wait", name: immediateTool.name, input: { value: "after" } }
        ]
      },
      {
        content: [{ type: "text", text: "batch completed" }],
        toolCalls: []
      }
    ]);
    const harness = await createMemoryTestHarness({ model, tools: [waitingTool, immediateTool] });
    await harness.service.createProfile({
      name: "resume-full-batch",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [waitingTool.name, immediateTool.name],
        plugins: {}
      })
    });
    await harness.service.selectProfile("resume-full-batch");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "run batch" }] });
    expect(conversation.status).toBe("waiting");
    expect(immediateTool.calls).toHaveLength(0);

    const interaction = (await harness.service.listPendingInteractions(conversation.id))[0];
    await harness.service.answerInteraction(interaction?.id ?? "", { text: "resume" });

    expect((await harness.service.getConversation(conversation.id))?.status).toBe("completed");
    expect(immediateTool.calls.map((call) => call.id)).toEqual(["call_after_wait"]);
    const toolMessages = (await harness.kernel.store.listMessages(conversation.id))
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result_ref");
    expect(toolMessages.map((block) => block.toolCallId)).toEqual(["call_wait", "call_after_wait"]);
    expect(model.inputs).toHaveLength(2);
  });

  test("waiting in the middle of a model batch does not replay completed calls or drop later calls", async () => {
    const firstTool = createCountingTool("before_wait");
    const waitingTool = createWaitingTool();
    const lastTool = createCountingTool("after_middle_wait");
    const model = new SequencedModelAdapter([
      {
        content: [{ type: "text", text: "batch with middle wait" }],
        toolCalls: [
          { id: "call_first", name: firstTool.name, input: { value: "first" } },
          { id: "call_wait", name: waitingTool.name, input: {} },
          { id: "call_last", name: lastTool.name, input: { value: "last" } }
        ]
      },
      {
        content: [{ type: "text", text: "middle batch completed" }],
        toolCalls: []
      }
    ]);
    const harness = await createMemoryTestHarness({ model, tools: [firstTool, waitingTool, lastTool] });
    await harness.service.createProfile({
      name: "resume-middle-batch",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [firstTool.name, waitingTool.name, lastTool.name],
        plugins: {}
      })
    });
    await harness.service.selectProfile("resume-middle-batch");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "run middle batch" }] });
    expect(conversation.status).toBe("waiting");
    expect(firstTool.calls.map((call) => call.id)).toEqual(["call_first"]);
    expect(lastTool.calls).toHaveLength(0);

    const interaction = (await harness.service.listPendingInteractions(conversation.id))[0];
    await harness.service.answerInteraction(interaction?.id ?? "", { text: "resume" });

    expect(firstTool.calls.map((call) => call.id)).toEqual(["call_first"]);
    expect(lastTool.calls.map((call) => call.id)).toEqual(["call_last"]);
    const toolExecutions = await harness.kernel.store.listToolExecutions(conversation.id);
    expect(toolExecutions.map((execution) => execution.toolCallId)).toEqual(["call_first", "call_wait", "call_last"]);
  });

  test("answering the same interaction twice is idempotent and does not duplicate continuation", async () => {
    const waitingTool = createWaitingTool();
    const model = new SequencedModelAdapter([
      {
        content: [{ type: "text", text: "waiting" }],
        toolCalls: [{ id: "call_wait", name: waitingTool.name, input: {} }]
      },
      {
        content: [{ type: "text", text: "resumed" }],
        toolCalls: []
      }
    ]);
    const harness = await createMemoryTestHarness({ model, tools: [waitingTool] });
    await harness.service.createProfile({
      name: "idempotent-answer",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [waitingTool.name],
        plugins: {}
      })
    });
    await harness.service.selectProfile("idempotent-answer");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "ask" }] });
    const interaction = (await harness.service.listPendingInteractions(conversation.id))[0];
    const response = { text: "same response" };
    const first = await harness.service.answerInteraction(interaction?.id ?? "", response);
    const second = await harness.service.answerInteraction(interaction?.id ?? "", response);

    expect(second).toEqual(first);
    const toolResultRefs = (await harness.kernel.store.listMessages(conversation.id))
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result_ref" && block.toolCallId === "call_wait");
    expect(toolResultRefs).toHaveLength(1);
    expect(model.inputs).toHaveLength(2);
    const answeredEvents = (await harness.service.listEvents(conversation.id, { limit: 100 })).filter((event) => event.type === "interaction.answered");
    expect(answeredEvents).toHaveLength(1);
  });

  test("disabled plugin hooks do not run and enabled plugins receive only their config", async () => {
    let calls = 0;
    const plugin: HarnessPlugin = {
      id: "plugin.test",
      async contextFragments(input) {
        calls += 1;
        return [{ type: "text", text: `plugin config: ${JSON.stringify(input.pluginConfig ?? null)}` }];
      }
    };
    const harness = await createMemoryTestHarness({ plugins: [plugin] });
    await harness.service.createProfile({
      name: "disabled-plugin",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [],
        plugins: {}
      })
    });
    await harness.service.selectProfile("disabled-plugin");
    await harness.service.startConversation({ message: [{ type: "text", text: "no plugin" }] });
    expect(calls).toBe(0);

    await harness.service.createProfile({
      name: "enabled-plugin",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [],
        plugins: {
          "plugin.test": { enabled: true, config: { label: "enabled" } }
        }
      })
    });
    await harness.service.selectProfile("enabled-plugin");
    await harness.service.startConversation({ message: [{ type: "text", text: "with plugin" }] });
    expect(calls).toBe(1);
    expect(harness.model.inputs.at(-1)?.messages.flatMap((m: any) => m.content).some((b: any) => b.type === "text" && b.text.includes("\"enabled\""))).toBe(true);
  });

  test("asap input reaches the active turn when current turn state remains", async () => {
    const waitingTool = createWaitingTool();
    const model = new SequencedModelAdapter([
      {
        content: [{ type: "text", text: "waiting" }],
        toolCalls: [{ id: "call_wait", name: waitingTool.name, input: {} }]
      },
      {
        content: [{ type: "text", text: "queued response" }],
        toolCalls: []
      }
    ]);
    const harness = await createMemoryTestHarness({ model, tools: [waitingTool] });
    await harness.service.createProfile({
      name: "queue",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [waitingTool.name],
        plugins: {}
      })
    });
    await harness.service.selectProfile("queue");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "first turn" }] });
    expect(conversation.status).toBe("waiting");
    const queued = await harness.service.sendConversationInput({ conversationId: conversation.id, message: [{ type: "text", text: "next turn please" }] });
    expect(queued.delivery).toBe("asap");
    const interaction = (await harness.service.listPendingInteractions(conversation.id))[0];
    await harness.service.answerInteraction(interaction?.id ?? "", { text: "resume" });

    const completed = await harness.service.getConversation(conversation.id);
    expect(completed?.status).toBe("completed");
    const turns = await harness.service.listTurns(conversation.id);
    expect(turns).toHaveLength(1);
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[1]?.messages.flatMap((m: any) => m.content).some((b: any) => b.type === "text" && b.text === "next turn please")).toBe(true);
  });

  test("after_active input waits for current work and starts a later turn", async () => {
    const waitingTool = createWaitingTool();
    const model = new SequencedModelAdapter([
      {
        content: [{ type: "text", text: "waiting" }],
        toolCalls: [{ id: "call_wait", name: waitingTool.name, input: {} }]
      },
      {
        content: [{ type: "text", text: "queued response" }],
        toolCalls: []
      }
    ]);
    const harness = await createMemoryTestHarness({ model, tools: [waitingTool] });
    await harness.service.createProfile({
      name: "queue-after-active",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [waitingTool.name],
        plugins: {}
      })
    });
    await harness.service.selectProfile("queue-after-active");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "first turn" }] });
    expect(conversation.status).toBe("waiting");
    const queued = await harness.service.sendConversationInput({
      conversationId: conversation.id,
      message: [{ type: "text", text: "after active" }],
      delivery: "after_active"
    });
    expect(queued.delivery).toBe("after_active");
    const interaction = (await harness.service.listPendingInteractions(conversation.id))[0];
    await harness.service.answerInteraction(interaction?.id ?? "", { text: "resume" });

    const completed = await harness.service.getConversation(conversation.id);
    expect(completed?.status).toBe("completed");
    const turns = await harness.service.listTurns(conversation.id);
    expect(turns).toHaveLength(2);
    expect(model.inputs).toHaveLength(3);
    expect(model.inputs[2]?.messages.flatMap((m: any) => m.content).some((b: any) => b.type === "text" && b.text === "after active")).toBe(true);
  });

  test("manual input remains pending until explicitly consumed", async () => {
    const waitingTool = createWaitingTool();
    const model = new SequencedModelAdapter([
      {
        content: [{ type: "text", text: "waiting" }],
        toolCalls: [{ id: "call_wait", name: waitingTool.name, input: {} }]
      }
    ]);
    const harness = await createMemoryTestHarness({ model, tools: [waitingTool] });
    await harness.service.createProfile({
      name: "queue-manual",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [waitingTool.name],
        plugins: {}
      })
    });
    await harness.service.selectProfile("queue-manual");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "first turn" }] });
    const queued = await harness.service.sendConversationInput({
      conversationId: conversation.id,
      message: [{ type: "text", text: "manual input" }],
      delivery: "manual"
    });
    const interaction = (await harness.service.listPendingInteractions(conversation.id))[0];
    await harness.service.answerInteraction(interaction?.id ?? "", { text: "resume" });

    const inputs = await harness.kernel.store.listConversationInputs({ conversationId: conversation.id, status: "pending" });
    expect(inputs.map((input) => input.id)).toContain(queued.id);
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[1]?.messages.flatMap((m: any) => m.content).some((b: any) => b.type === "text" && b.text === "manual input")).toBe(false);
  });

  test("background bash keeps an activity running, owns live output, and cancellation steers completion input", async () => {
    const runtime = new CancellableFakeRuntime();
    const model = new SequencedModelAdapter([
      {
        content: [{ type: "text", text: "starting background" }],
        toolCalls: [{ id: "call_bg", name: "bash", input: { command: "sleep fake", wait: "start" } }]
      },
      {
        content: [{ type: "text", text: "saw bash completion" }],
        toolCalls: []
      }
    ]);
    const harness = await createMemoryTestHarness({ model, executionProviders: [new FakeExecutionProvider(runtime)] });
    await harness.service.createProfile({
      name: "background-bash",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: ["bash"],
        plugins: {}
      })
    });
    await harness.service.selectProfile("background-bash");
    const conversation = await harness.service.createProjectlessConversation({ profile: "background-bash" });
    const context = await harness.kernel.createExecutionContext({ conversationId: conversation.id, providerKind: "fake" });
    await harness.kernel.attachExecutionContext(conversation.id, context.id);

    await harness.service.continueConversation(conversation.id, [{ type: "text", text: "start background bash" }]);
    const activity = (await harness.service.listActivities(conversation.id))[0];
    expect(activity).toMatchObject({ ownerPluginId: BASIC_TOOLS_PLUGIN_ID, kind: "plugin.bash.run", status: "running" });
    expect((await harness.service.getConversation(conversation.id))?.status).toBe("waiting");
    const toolExec = (await harness.kernel.store.listToolExecutions(conversation.id))[0];
    expect(toolExec).toMatchObject({ status: "completed", createdActivityIds: [activity?.id] });
    const output = await harness.service.peekActivityOutput(activity?.id ?? "");
    expect(output?.channels.map((channel) => channel.kind)).toEqual(expect.arrayContaining(["stdout", "stderr"]));
    expect(output?.frames.map((frame) => frame.text ?? "").join("")).toContain("background stdout: sleep fake");

    await harness.kernel.cancelActivity(activity?.id ?? "");

    expect(runtime.cancelled).toBe(true);
    expect((await harness.kernel.store.getActivity(activity?.id ?? ""))?.status).toBe("cancelled");
    const inputs = await harness.kernel.store.listConversationInputs({ conversationId: conversation.id });
    expect(inputs.some((input) => input.source === "activity" && input.sourceRef?.id === activity?.id && input.status === "consumed")).toBe(true);
    expect(model.inputs.at(-1)?.messages.flatMap((message: any) => message.content).some((block: any) => block.type === "text" && block.text.includes("Bash command cancelled: sleep fake"))).toBe(true);
  });

  test("activity driver routing uses owner plugin id and kind", async () => {
    const pluginA = ownerStatusPlugin("plugin.owner-a", "a");
    const pluginB = ownerStatusPlugin("plugin.owner-b", "b");
    const harness = await createMemoryTestHarness({ plugins: [pluginA, pluginB] });
    const conversation = await harness.service.createProjectlessConversation({ title: "activity owners" });

    const activity = await harness.kernel.createActivity({
      conversationId: conversation.id,
      ownerPluginId: pluginB.id,
      kind: "shared.kind",
      label: "shared",
      status: "running"
    });

    expect(await harness.kernel.getActivityStatus(activity.id)).toMatchObject({ owner: "b" });
    await expect(harness.kernel.createActivity({
      conversationId: conversation.id,
      ownerPluginId: "plugin.missing",
      kind: "shared.kind",
      label: "missing"
    })).rejects.toThrow("No activity driver registered");
  });

  test("tool activity control is scoped to the current conversation", async () => {
    const externalActivityId = "activity_external_scope";
    const ownerPlugin = ownerStatusPlugin("plugin.owner-scope", "external");
    const probeTool = createActivityScopeProbeTool(externalActivityId);
    const model = new RecordingFakeModelAdapter({
      toolCall: { id: "call_activity_scope", name: probeTool.name, input: {} }
    });
    const harness = await createMemoryTestHarness({ model, tools: [probeTool], plugins: [ownerPlugin] });
    await harness.service.createProfile({
      name: "activity-scope",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [probeTool.name],
        plugins: { [ownerPlugin.id]: { enabled: true } }
      })
    });
    await harness.service.selectProfile("activity-scope");
    const sourceConversation = await harness.kernel.createConversation({ profileName: "activity-scope", title: "source" });
    await harness.kernel.createActivity({
      id: externalActivityId,
      conversationId: sourceConversation.id,
      ownerPluginId: ownerPlugin.id,
      kind: "shared.kind",
      label: "external",
      status: "running"
    });

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "probe activity scope" }] });

    const toolExecution = (await harness.kernel.store.listToolExecutions(conversation.id))[0];
    expect(toolExecution?.result).toMatchObject({
      status: "ok",
      data: { scoped: true }
    });
  });

  test("subagent controls operate on the parent-facing activity id", async () => {
    const waitingTool = createWaitingTool();
    const model = new SequencedModelAdapter([
      {
        content: [{ type: "text", text: "child waiting" }],
        toolCalls: [{ id: "call_child_wait", name: waitingTool.name, input: {} }]
      }
    ]);
    const harness = await createMemoryTestHarness({ model, tools: [waitingTool] });
    await harness.service.createProfile({
      name: "subagent-controls",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [waitingTool.name],
        plugins: { "plugin.subagents": { enabled: true } }
      })
    });
    await harness.service.selectProfile("subagent-controls");
    const parent = await harness.service.createProjectlessConversation({ title: "parent" });

    const delegated = await harness.service.delegateSubagent({ parentConversationId: parent.id, prompt: "child prompt" });
    const activityId = delegated.activity.id;
    const peeked = await harness.service.peekSubagent(activityId);
    expect(peeked.childConversation.status).toBe("waiting");
    expect(peeked.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === "child prompt"))).toBe(true);
    expect((await harness.kernel.getActivityStatus(activityId)) as any).toMatchObject({
      childConversation: { id: delegated.childConversation.id, status: "waiting" }
    });

    const sent = await harness.service.sendSubagent({ activityId, message: [{ type: "text", text: "follow-up" }] });
    expect(sent.queuedInputId).toBeTruthy();
    const waited = await harness.service.waitSubagent(activityId);
    expect(waited.childConversation.status).toBe("waiting");

    const cancelled = await harness.service.cancelSubagent(activityId);
    expect(cancelled.status).toBe("cancelled");
    expect((await harness.service.getConversation(delegated.childConversation.id))?.status).toBe("cancelled");
  });

  test("approval policy uses generic approval interactions and resumes the original tool execution", async () => {
    const approvalTool = createApprovalProbeTool();
    const model = new RecordingFakeModelAdapter({
      toolCall: { id: "call_approval", name: approvalTool.name, input: { value: "ok" } }
    });
    const harness = await createMemoryTestHarness({ model, tools: [approvalTool] });
    await harness.service.createProfile({
      name: "approval",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [approvalTool.name],
        plugins: {},
        approvalPolicy: { mode: "always", allowTools: [], denyTools: [] }
      })
    });
    await harness.service.selectProfile("approval");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "approve tool" }] });
    expect(conversation.status).toBe("waiting");
    const interaction = (await harness.service.listPendingInteractions(conversation.id))[0];
    expect(interaction).toMatchObject({ origin: "approval", kind: "approval" });
    const toolExecutions = await harness.kernel.store.listToolExecutions(conversation.id);
    const toolExec = toolExecutions.find((item) => item.toolCallId === "call_approval");
    expect(toolExec?.pendingInteractionIds).toContain(interaction?.id);

    await expect(harness.service.answerInteraction(interaction?.id ?? "", {})).rejects.toThrow(/response does not match requested schema/u);
    expect((await harness.service.getInteraction(interaction?.id ?? ""))?.status).toBe("pending");

    await harness.service.answerInteraction(interaction?.id ?? "", { approved: true });
    const completedToolExec = await harness.kernel.store.getToolExecution(toolExec?.id ?? "");
    expect(completedToolExec?.status).toBe("completed");
    expect((await harness.service.getConversation(conversation.id))?.status).toBe("completed");
  });

  test("approval resume requires approved true and declines without executing the tool", async () => {
    const approvalTool = createCountingTool("declined_probe");
    const model = new RecordingFakeModelAdapter({
      toolCall: { id: "call_declined", name: approvalTool.name, input: { value: "no" } }
    });
    const harness = await createMemoryTestHarness({ model, tools: [approvalTool] });
    await harness.service.createProfile({
      name: "approval-declined",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [approvalTool.name],
        plugins: {},
        approvalPolicy: { mode: "always", allowTools: [], denyTools: [] }
      })
    });
    await harness.service.selectProfile("approval-declined");

    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "decline tool" }] });
    const interaction = (await harness.service.listPendingInteractions(conversation.id))[0];
    await harness.service.answerInteraction(interaction?.id ?? "", { approved: false });

    expect(approvalTool.calls).toHaveLength(0);
    const toolExecution = (await harness.kernel.store.listToolExecutions(conversation.id))[0];
    expect(toolExecution).toMatchObject({
      toolCallId: "call_declined",
      status: "failed",
      result: expect.objectContaining({ status: "error" })
    });
    const toolResultRef = (await harness.kernel.store.listMessages(conversation.id))
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result_ref" && block.toolCallId === "call_declined");
    expect(toolResultRef).toMatchObject({ status: "error" });
  });

  test("maps MCP elicitation to an interaction request shape owned by core", () => {
    const mapped = mapMcpElicitationToInteraction({
      conversationId: "conv_1",
      turnId: "turn_1",
      prompt: [{ type: "text", text: "Need input" }],
      requestedSchema: { type: "object" },
      sensitive: true
    });
    expect(mapped).toMatchObject({
      origin: "mcp_elicitation",
      kind: "user_input",
      conversationId: "conv_1",
      turnId: "turn_1"
    });
  });

  test("persists context builds, immutable file-read blocks, and explicit compaction projections", async () => {
    const model = new RecordingFakeModelAdapter({
      toolCall: { id: "call_read", name: "read_file", input: { path: "README.md" } }
    });
    const harness = await createMemoryTestHarness({ model });
    await harness.service.createProfile({
      name: "context",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: ["read_file"],
        plugins: {}
      })
    });
    await harness.service.selectProfile("context");
    const conversation = await harness.kernel.createConversation({ profileName: "context", title: "context" });
    const fakeContext = await harness.kernel.createExecutionContext({ conversationId: conversation.id, providerKind: "fake" });
    await harness.kernel.attachExecutionContext(conversation.id, fakeContext.id);
    await harness.service.continueConversation(conversation.id, [{ type: "text", text: "read a file" }]);

    const builds = await harness.service.listContextBuilds(conversation.id);
    expect(builds.length).toBeGreaterThan(0);
    const fileReads = (await harness.service.listContextBlocks(conversation.id)).filter((block) => block.kind === "file_read");
    expect(fileReads).toHaveLength(1);
    expect(fileReads[0]?.metadata.path).toBe("README.md");
    const activitiesBeforeCompaction = await harness.service.listActivities(conversation.id);
    const projection = await harness.service.runCompaction(conversation.id);
    expect(projection.source).toEqual({ type: "system" });
    expect(projection.metadata.coveredThroughMessageSequence).toBeGreaterThanOrEqual(0);
    const blocksAfterCompaction = await harness.service.listContextBlocks(conversation.id);
    expect(blocksAfterCompaction.filter((block) => block.kind === "file_read")).toHaveLength(1);
    expect(blocksAfterCompaction.some((block) => block.kind === "projection")).toBe(true);
    expect(await harness.service.listActivities(conversation.id)).toEqual(activitiesBeforeCompaction);
    const events = await harness.service.listEvents(conversation.id, { limit: 100 });
    expect(events).toContainEqual(expect.objectContaining({
      source: { type: "system" },
      type: "context.compaction.completed",
      payload: expect.objectContaining({ blockId: projection.id })
    }));

    await harness.service.continueConversation(conversation.id, [{ type: "text", text: "new after compaction" }]);
    const compactedInput = model.inputs.at(-1);
    const inputText = compactedInput?.messages.flatMap((message) => message.content).filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
    expect(inputText).toContain("Compacted");
    expect(inputText).toContain("new after compaction");
    expect(inputText).not.toContain("read a file");
  });

  test("initializes temp SQLite through migrations and serves through the same service API", async () => {
    const harness = await createTempSqliteTestHarness();
    try {
      await harness.service.createProfile({
        name: "sqlite",
        config: profileConfigSchema.parse({
          model: { adapter: "fake", modelId: "fake-text" },
          enabledTools: [],
          plugins: {}
        })
      });
      await harness.service.selectProfile("sqlite");
      const conversation = await harness.service.startConversation({
        message: [{ type: "text", text: "sqlite run" }]
      });
      const events = await harness.service.listEvents(conversation.id, { limit: 20 });
      expect(events.map((event) => event.type)).toContain("conversation.created");
      expect(events.map((event) => event.type)).toContain("conversation.completed");
      expect(await fs.stat(harness.dbPath)).toBeTruthy();
    } finally {
      if ("close" in harness.store) {
        harness.store.close();
      }
    }
  });

  test("bash output is live-only in SQLite and final tool output is bounded", async () => {
    const model = new RecordingFakeModelAdapter({
      toolCall: { id: "call_long_output", name: "bash", input: { command: "long output" } }
    });
    const harness = await createTempSqliteTestHarness({ model, executionProviders: [new FakeExecutionProvider(new LongOutputRuntime())] });
    try {
      await harness.service.createProfile({
        name: "sqlite-output-reset",
        config: profileConfigSchema.parse({
          model: { adapter: "fake", modelId: "fake-text" },
          enabledTools: ["bash"],
          plugins: {}
        })
      });
      await harness.service.selectProfile("sqlite-output-reset");
      const conversation = await harness.kernel.createConversation({ profileName: "sqlite-output-reset" });
      const context = await harness.kernel.createExecutionContext({ conversationId: conversation.id, providerKind: "fake" });
      await harness.kernel.attachExecutionContext(conversation.id, context.id);
      await harness.service.continueConversation(conversation.id, [{ type: "text", text: "run long output" }]);

      const events = await harness.service.listEvents(conversation.id, { limit: 100 });
      expect(events.map((event) => event.type)).toContain("tool.completed");

      const activity = (await harness.service.listActivities(conversation.id))[0];
      const preview = await harness.service.peekActivityOutput(activity?.id ?? "", { limit: 20 });
      expect(preview?.frames.map((frame) => frame.text ?? "").join("")).toContain("long-output");

      const toolExecution = (await harness.kernel.store.listToolExecutions(conversation.id))[0];
      expect(JSON.stringify(toolExecution?.result?.content)).toContain("truncated");
      expect(JSON.stringify(toolExecution?.result?.content).length).toBeLessThan(9000);
      expect(JSON.stringify(toolExecution?.result?.content)).not.toContain("long-output-9999");
      const toolMessage = (await harness.kernel.store.listMessages(conversation.id)).find((message) => message.role === "tool");
      expect(toolMessage?.content.some((block) => block.type === "tool_result_ref" && block.toolCallId === "call_long_output")).toBe(true);
    } finally {
      if ("close" in harness.store) {
        harness.store.close();
      }
    }
  });

  test("live output peek is unavailable after a runtime restart", async () => {
    const model = new RecordingFakeModelAdapter({
      toolCall: { id: "call_restart_output", name: "bash", input: { command: "echo restart" } }
    });
    const harness = await createTempSqliteTestHarness({ model });
    let activityId = "";
    try {
      await harness.service.createProfile({
        name: "sqlite-live-restart",
        config: profileConfigSchema.parse({
          model: { adapter: "fake", modelId: "fake-text" },
          enabledTools: ["bash"],
          plugins: {}
        })
      });
      await harness.service.selectProfile("sqlite-live-restart");
      const conversation = await harness.kernel.createConversation({ profileName: "sqlite-live-restart" });
      const context = await harness.kernel.createExecutionContext({ conversationId: conversation.id, providerKind: "fake" });
      await harness.kernel.attachExecutionContext(conversation.id, context.id);
      await harness.service.continueConversation(conversation.id, [{ type: "text", text: "run output" }]);
      activityId = (await harness.service.listActivities(conversation.id))[0]?.id ?? "";
      expect(await harness.service.peekActivityOutput(activityId)).toBeDefined();
    } finally {
      if ("close" in harness.store) {
        harness.store.close();
      }
    }

    const restarted = await createSqliteTestHarnessAtPath(harness.dbPath);
    try {
      expect(await restarted.service.peekActivityOutput(activityId)).toBeUndefined();
    } finally {
      if ("close" in restarted.store) {
        restarted.store.close();
      }
    }
  });

  test("custom output presenter can redact final tool output", async () => {
    const model = new RecordingFakeModelAdapter({
      toolCall: { id: "call_redact_output", name: "bash", input: { command: "secret output" } }
    });
    const presenterFactory = (): ToolOutputPresenter => ({
      observeChunk() {},
      async prepareFinal() {
        return {
          content: [{ type: "text", text: "[redacted output]" }],
          data: { output: { redacted: true } }
        };
      }
    });
    const harness = await createMemoryTestHarness({
      model,
      executionProviders: [new FakeExecutionProvider(new SecretOutputRuntime())],
      toolOutputPresenterFactory: presenterFactory
    });
    await harness.service.createProfile({
      name: "redacted-output",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: ["bash"],
        plugins: {}
      })
    });
    await harness.service.selectProfile("redacted-output");
    const conversation = await harness.kernel.createConversation({ profileName: "redacted-output" });
    const context = await harness.kernel.createExecutionContext({ conversationId: conversation.id, providerKind: "fake" });
    await harness.kernel.attachExecutionContext(conversation.id, context.id);
    await harness.service.continueConversation(conversation.id, [{ type: "text", text: "run secret output" }]);

    const toolMessageText = JSON.stringify((await harness.kernel.store.listMessages(conversation.id)).filter((message) => message.role === "tool").flatMap((message) => message.content));
    expect(toolMessageText).toContain("[redacted output]");
    expect(toolMessageText).not.toContain("top secret token");
  });

  test("startup recovery fails abandoned runtime activities", async () => {
    const harness = await createTempSqliteTestHarness();
    let activityId = "";
    try {
      await harness.service.createProfile({
        name: "recover-activity",
        config: profileConfigSchema.parse({
          model: { adapter: "fake", modelId: "fake-text" },
          enabledTools: [],
          plugins: {}
        })
      });
      const conversation = await harness.kernel.createConversation({ profileName: "recover-activity" });
      const turn = await harness.kernel.store.createTurn({ conversationId: conversation.id, status: "waiting" });
      const activity = await harness.kernel.store.createActivity({
        conversationId: conversation.id,
        turnId: turn.id,
        ownerPluginId: "test",
        kind: "runtime",
        label: "runtime activity",
        status: "running"
      });
      activityId = activity.id;
    } finally {
      if ("close" in harness.store) {
        harness.store.close();
      }
    }

    const restarted = await createSqliteTestHarnessAtPath(harness.dbPath);
    try {
      const recovered = await restarted.kernel.store.getActivity(activityId);
      expect(recovered?.status).toBe("failed");
      expect(JSON.stringify(recovered?.result)).toContain("runtime restart");
    } finally {
      if ("close" in restarted.store) {
        restarted.store.close();
      }
    }
  });

  test("startup recovery finalizes abandoned tool executions with explicit error results", async () => {
    const harness = await createTempSqliteTestHarness();
    let conversationId = "";
    let toolExecutionId = "";
    try {
      await harness.service.createProfile({
        name: "recover-tool",
        config: profileConfigSchema.parse({
          model: { adapter: "fake", modelId: "fake-text" },
          enabledTools: [],
          plugins: {}
        })
      });
      const conversation = await harness.kernel.createConversation({ profileName: "recover-tool" });
      conversationId = conversation.id;
      const turn = await harness.kernel.store.createTurn({ conversationId: conversation.id, status: "waiting" });
      const execution = await harness.kernel.store.createToolExecution({
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: "call_recovered",
        toolName: "bash",
        input: { command: "stale" },
        status: "running"
      });
      toolExecutionId = execution.id;
    } finally {
      if ("close" in harness.store) {
        harness.store.close();
      }
    }

    const restarted = await createSqliteTestHarnessAtPath(harness.dbPath);
    try {
      const execution = await restarted.kernel.store.getToolExecution(toolExecutionId);
      expect(execution?.status).toBe("failed");
      expect(execution?.result?.summary).toContain("runtime restart");
      const messages = await restarted.kernel.store.listMessages(conversationId);
      expect(messages.some((message) =>
        message.role === "tool" &&
        message.content.some((block) => block.type === "tool_result_ref" && block.toolCallId === "call_recovered")
      )).toBe(true);
      const events = await restarted.service.listEvents(conversationId, { limit: 50 });
      expect(events.map((event) => event.type)).toContain("tool.completed");
    } finally {
      if ("close" in restarted.store) {
        restarted.store.close();
      }
    }
  });

  test("startup recovery preserves valid pending interactions", async () => {
    const harness = await createTempSqliteTestHarness();
    let interactionId = "";
    let turnId = "";
    try {
      await harness.service.createProfile({
        name: "recover-interaction",
        config: profileConfigSchema.parse({
          model: { adapter: "fake", modelId: "fake-text" },
          enabledTools: [],
          plugins: {}
        })
      });
      const conversation = await harness.kernel.createConversation({ profileName: "recover-interaction" });
      const turn = await harness.kernel.store.createTurn({ conversationId: conversation.id, status: "waiting" });
      turnId = turn.id;
      const interaction = await harness.kernel.store.createInteractionRequest({
        conversationId: conversation.id,
        turnId: turn.id,
        origin: "tool",
        kind: "user_input",
        prompt: [{ type: "text", text: "still pending" }]
      });
      interactionId = interaction.id;
    } finally {
      if ("close" in harness.store) {
        harness.store.close();
      }
    }

    const restarted = await createSqliteTestHarnessAtPath(harness.dbPath);
    try {
      expect((await restarted.kernel.store.getInteractionRequest(interactionId))?.status).toBe("pending");
      expect((await restarted.kernel.store.getTurn(turnId))?.status).toBe("waiting");
    } finally {
      if ("close" in restarted.store) {
        restarted.store.close();
      }
    }
  });

  test("startup recovery fails waiting turns without valid pending state", async () => {
    const harness = await createTempSqliteTestHarness();
    let conversationId = "";
    let turnId = "";
    try {
      await harness.service.createProfile({
        name: "recover-invalid-turn",
        config: profileConfigSchema.parse({
          model: { adapter: "fake", modelId: "fake-text" },
          enabledTools: [],
          plugins: {}
        })
      });
      const conversation = await harness.kernel.createConversation({ profileName: "recover-invalid-turn" });
      conversationId = conversation.id;
      const turn = await harness.kernel.store.createTurn({ conversationId: conversation.id, status: "waiting" });
      turnId = turn.id;
    } finally {
      if ("close" in harness.store) {
        harness.store.close();
      }
    }

    const restarted = await createSqliteTestHarnessAtPath(harness.dbPath);
    try {
      expect((await restarted.kernel.store.getTurn(turnId))?.status).toBe("failed");
      expect((await restarted.kernel.store.getTurnState(turnId))?.phase).toBe("failed");
      const events = await restarted.service.listEvents(conversationId, { limit: 50 });
      expect(events.map((event) => event.type)).toContain("turn.failed");
    } finally {
      if ("close" in restarted.store) {
        restarted.store.close();
      }
    }
  });

  test("stores reject duplicate active turns and duplicate tool executions per turn", async () => {
    await assertStoreInvariants(await createMemoryTestHarness(), "memory");
    const sqlite = await createTempSqliteTestHarness();
    try {
      await assertStoreInvariants(sqlite, "sqlite");
    } finally {
      if ("close" in sqlite.store) {
        sqlite.store.close();
      }
    }
  });

  test("SQLite messages are sequenced durably and live output has no durable schema", async () => {
    const harness = await createTempSqliteTestHarness();
    try {
      await harness.service.createProfile({
        name: "sqlite-order",
        config: profileConfigSchema.parse({
          model: { adapter: "fake", modelId: "fake-text" },
          enabledTools: [],
          plugins: {}
        })
      });
      await harness.service.selectProfile("sqlite-order");
      const conversation = await harness.kernel.createConversation({ profileName: "sqlite-order" });
      await harness.kernel.addMessage({ conversationId: conversation.id, role: "user", content: [{ type: "text", text: "one" }] });
      await harness.kernel.addMessage({ conversationId: conversation.id, role: "assistant", content: [{ type: "text", text: "two" }] });
      await harness.kernel.addMessage({ conversationId: conversation.id, role: "user", content: [{ type: "text", text: "three" }] });

      const messages = await harness.kernel.store.listMessages(conversation.id);
      expect(messages.map((message) => message.sequence)).toEqual([0, 1, 2]);
      expect(messages.flatMap((message) => message.content).filter((block) => block.type === "text").map((block) => block.text)).toEqual(["one", "two", "three"]);

    } finally {
      if ("close" in harness.store) {
        harness.store.close();
      }
    }
  });

  test("model deltas are live-only and final assistant text is durable", async () => {
    const harness = await createMemoryTestHarness({ model: new StreamingTextModelAdapter() });
    await harness.service.createProfile({
      name: "streaming",
      config: profileConfigSchema.parse({
        model: { adapter: "fake", modelId: "fake-text" },
        enabledTools: [],
        plugins: {}
      })
    });
    await harness.service.selectProfile("streaming");
    const conversation = await harness.service.startConversation({ message: [{ type: "text", text: "stream" }] });
    const messages = await harness.kernel.store.listMessages(conversation.id);
    expect(messages.some((message) =>
      message.role === "assistant" &&
      message.content.some((block) => block.type === "text" && block.text === "streamed")
    )).toBe(true);
  });

  test("host runtime rejects path traversal and symlink escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-host-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "harness-host-outside-"));
    await fs.writeFile(path.join(root, "visible.txt"), "inside needle", "utf8");
    await fs.writeFile(path.join(outside, "secret.txt"), "outside needle", "utf8");
    await fs.symlink(outside, path.join(root, "outside-link"));
    const timestamp = new Date().toISOString();
    const runtime = await createHostExecutionProvider().resolve({
      id: "ctx_host",
      providerKind: "host",
      cwd: root,
      env: {},
      providerConfig: {},
      status: "ready",
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await expect(runtime.readFile("../secret.txt")).rejects.toThrow(/escapes/u);
    await expect(runtime.readFile(path.join(outside, "secret.txt"))).rejects.toThrow(/Absolute paths/u);
    await expect(runtime.readFile("outside-link/secret.txt")).rejects.toThrow(/escapes/u);
    await expect(runtime.writeFile("outside-link/new.txt", "nope")).rejects.toThrow(/symlink|escapes/u);
    await expect(runtime.grep({ pattern: "outside needle" })).resolves.toEqual([]);
    await expect(runtime.grep({ pattern: "inside needle" })).resolves.toEqual([
      { path: "visible.txt", line: 1, text: "inside needle" }
    ]);
  });
});

async function assertStoreInvariants(harness: Awaited<ReturnType<typeof createMemoryTestHarness>>, label: string): Promise<void> {
  const profile = await harness.service.createProfile({
    name: `${label}-invariants`,
    config: profileConfigSchema.parse({
      model: { adapter: "fake", modelId: "fake-text" },
      enabledTools: [],
      plugins: {}
    })
  });
  const conversation = await harness.kernel.createConversation({ profileId: profile.id });
  const inactiveTurn = await harness.kernel.store.createTurn({ conversationId: conversation.id, status: "completed" });
  const activeTurn = await harness.kernel.store.createTurn({ conversationId: conversation.id, status: "running" });

  await expect(harness.kernel.store.updateTurn({ id: inactiveTurn.id, status: "waiting" })).rejects.toThrow(/active turn/u);

  await harness.kernel.store.createToolExecution({
    conversationId: conversation.id,
    turnId: activeTurn.id,
    toolCallId: "call_duplicate",
    toolName: "duplicate_tool",
    input: {},
    status: "running"
  });
  await expect(harness.kernel.store.createToolExecution({
    conversationId: conversation.id,
    turnId: activeTurn.id,
    toolCallId: "call_duplicate",
    toolName: "duplicate_tool",
    input: {},
    status: "running"
  })).rejects.toThrow(/tool execution|already has/u);
}

async function writeFakeImage(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "harness-asset-"));
  const file = path.join(dir, "fake.png");
  await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return file;
}

function createWaitingTool(): HarnessTool {
  return {
    name: "wait_for_user",
    description: "Requests user input before completing.",
    requiresExecutionContext: false,
    async execute({ io }) {
      const interaction = await io.createInteraction({
        kind: "user_input",
        prompt: [{ type: "text", text: "Provide a value" }]
      });
      return {
        status: "waiting",
        interactionIds: [interaction.id],
        resumeState: { step: "await_user" }
      };
    },
    async resume({ call, interactions }) {
      return {
        toolCallId: call.id,
        status: "ok",
        content: [
          { type: "text", text: "resumed" },
          { type: "data", label: "responses", data: interactions.map((interaction) => interaction.response ?? null) as JsonValue }
        ],
        assetIds: [],
        artifactIds: [],
        summary: "resumed after interaction"
      };
    }
  };
}

function createThrowingTool(name: string): HarnessTool {
  return {
    name,
    description: "Throws during execution.",
    requiresExecutionContext: false,
    async execute() {
      throw new Error(`${name} exploded`);
    }
  };
}

function createCountingTool(name: string): HarnessTool & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    name,
    calls,
    description: "Records calls and completes.",
    requiresExecutionContext: false,
    async execute({ call }) {
      calls.push(call);
      return {
        toolCallId: call.id,
        status: "ok",
        content: [{ type: "text", text: `${name} completed` }],
        data: call.input,
        assetIds: [],
        artifactIds: [],
        summary: `${name} completed`
      };
    }
  };
}

function createActivityScopeProbeTool(activityId: string): HarnessTool {
  return {
    name: "activity_scope_probe",
    description: "Verifies cross-conversation activity capabilities are unavailable to tool IO.",
    requiresExecutionContext: false,
    async execute({ call, io }) {
      try {
        await io.getActivityStatus(activityId);
        return {
          toolCallId: call.id,
          status: "error",
          content: [{ type: "text", text: "cross-conversation activity status leaked" }],
          data: { scoped: false },
          assetIds: [],
          artifactIds: [],
          summary: "activity scope leaked"
        };
      } catch {
        return {
          toolCallId: call.id,
          status: "ok",
          content: [{ type: "text", text: "cross-conversation activity status blocked" }],
          data: { scoped: true },
          assetIds: [],
          artifactIds: [],
          summary: "activity scope enforced"
        };
      }
    }
  };
}

function createApprovalProbeTool(): HarnessTool {
  return {
    name: "approval_probe",
    description: "Completes after generic approval.",
    requiresExecutionContext: false,
    async execute({ call }) {
      return {
        toolCallId: call.id,
        status: "ok",
        content: [{ type: "text", text: "approved tool executed" }],
        data: call.input,
        assetIds: [],
        artifactIds: [],
        summary: "approval probe completed"
      };
    }
  };
}

function ownerStatusPlugin(id: string, owner: string): HarnessPlugin {
  return {
    id,
    activityDrivers: {
      "shared.kind": {
        async status() {
          return { owner };
        },
        async cancel() {}
      }
    }
  };
}

class CancellableFakeRuntime extends FakeExecutionRuntime {
  public cancelled = false;
  private finish: ((output: ExecutionCommandOutput) => void) | undefined;

  public override async startCommand(input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ActiveProcess> {
    await sinks.stdout(`background stdout: ${input.command}\n`);
    await sinks.stderr(`background stderr: ${input.command}\n`);
    return {
      pid: 4242,
      wait: async () => new Promise<ExecutionCommandOutput>((resolve) => {
        this.finish = resolve;
      }),
      cancel: async () => {
        this.cancelled = true;
        this.finish?.({ exitCode: 130, signal: "SIGTERM" });
      }
    };
  }
}

class LongOutputRuntime extends FakeExecutionRuntime {
  public override async runCommand(_input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ExecutionCommandOutput> {
    await sinks.stdout(Array.from({ length: 10_000 }, (_unused, index) => `long-output-${index}`).join("\n"));
    await sinks.stderr("long-stderr\n");
    return { exitCode: 0 };
  }

  public override async startCommand(input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ActiveProcess> {
    await this.runCommand(input, sinks);
    return {
      pid: 1111,
      wait: async () => ({ exitCode: 0 }),
      cancel: async () => {}
    };
  }
}

class SecretOutputRuntime extends FakeExecutionRuntime {
  public override async runCommand(_input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ExecutionCommandOutput> {
    await sinks.stdout("top secret token\n");
    return { exitCode: 0 };
  }

  public override async startCommand(input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ActiveProcess> {
    await this.runCommand(input, sinks);
    return {
      pid: 2222,
      wait: async () => ({ exitCode: 0 }),
      cancel: async () => {}
    };
  }
}

class TaggedModelAdapter implements ModelAdapter {
  public readonly inputs: ModelStepInput[] = [];

  public constructor(public readonly id: string, public readonly provider: string, private readonly responseText: string) {}

  public capabilities() {
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
    return [];
  }

  public validateModelConfig(config: ModelConfig): void {
    if (config.adapter !== this.id || config.provider !== this.provider) {
      throw new Error(`Tagged adapter cannot run ${config.provider}/${config.adapter}`);
    }
  }

  public async step(input: ModelStepInput): Promise<ModelStepResult> {
    this.inputs.push(input);
    return {
      content: [{ type: "text", text: this.responseText }],
      toolCalls: [],
      providerEvents: [],
      metadata: { tagged: "true" }
    };
  }
}

class FailingModelAdapter extends RecordingFakeModelAdapter {
  public override async step(input: ModelStepInput): Promise<ModelStepResult> {
    this.inputs.push(input);
    throw new Error("model exploded");
  }
}

class StreamingFailingModelAdapter extends RecordingFakeModelAdapter {
  public override async step(input: ModelStepInput, observer?: Parameters<ModelAdapter["step"]>[1]): Promise<ModelStepResult> {
    this.inputs.push(input);
    await observer?.onTextDelta?.("partial assistant text");
    throw new Error("stream failed");
  }
}

class SequencedModelAdapter extends RecordingFakeModelAdapter {
  public constructor(private readonly results: Array<Pick<ModelStepResult, "content" | "toolCalls">>) {
    super();
  }

  public override async step(input: ModelStepInput): Promise<ModelStepResult> {
    this.inputs.push(input);
    const result = this.results[Math.min(this.inputs.length - 1, this.results.length - 1)];
    if (!result) {
      throw new Error("Sequenced model has no result");
    }
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      providerEvents: [],
      metadata: { sequence: (this.inputs.length - 1).toString() }
    };
  }
}

class StreamingTextModelAdapter extends RecordingFakeModelAdapter {
  public override async step(input: ModelStepInput, observer?: Parameters<ModelAdapter["step"]>[1]): Promise<ModelStepResult> {
    this.inputs.push(input);
    await observer?.onTextDelta?.("streamed");
    return {
      content: [{ type: "text", text: "streamed" }],
      toolCalls: [],
      providerEvents: [],
      metadata: { streaming: "true" }
    };
  }
}
