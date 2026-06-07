import type { ActiveProcess, ActivityDriver, ExecutionRuntime, HarnessPlugin, HarnessTool, OutputChannelHandle, OutputKind, ToolOutputPresenter } from "@harness/core";
import type { ActivityRecord, ContentBlock, JsonValue, ToolCall, ToolResult } from "@harness/protocol";

export const SOURCE_FIRST_MARKER = "tools-basic:src";
export const BASIC_TOOLS_PLUGIN_ID = "plugin.tools.basic";
const BASH_ACTIVITY_KIND = "plugin.bash.run";

const runningBashProcesses = new Map<string, ActiveProcess>();

const READ_FILE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to read, relative to the active project unless absolute paths are allowed by the runtime." }
  },
  required: ["path"],
  additionalProperties: false
} satisfies JsonValue;

const WRITE_FILE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to write, relative to the active project unless absolute paths are allowed by the runtime." },
    content: { type: "string", description: "UTF-8 text content to write." }
  },
  required: ["path", "content"],
  additionalProperties: false
} satisfies JsonValue;

const LIST_FILES_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory or file path to list. Defaults to the project root." }
  },
  additionalProperties: false
} satisfies JsonValue;

const GREP_INPUT_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Literal text pattern to search for." },
    path: { type: "string", description: "Directory or file path to search. Defaults to the project root." },
    limit: { type: "number", description: "Maximum number of matches to return. Defaults to 50." }
  },
  required: ["pattern"],
  additionalProperties: false
} satisfies JsonValue;

const BASH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to run through the active execution context." },
    wait: { type: "string", enum: ["completion", "start"], description: "Use completion to wait for exit, or start to run in the background." }
  },
  required: ["command"],
  additionalProperties: false
} satisfies JsonValue;

const ACTIVITY_ID_INPUT_SCHEMA = {
  type: "object",
  properties: {
    activityId: { type: "string", description: "Activity id." }
  },
  required: ["activityId"],
  additionalProperties: false
} satisfies JsonValue;

const ACTIVITY_OUTPUT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    activityId: { type: "string", description: "Activity id." },
    limit: { type: "number", description: "Maximum live output frames to read. Defaults to 100." }
  },
  required: ["activityId"],
  additionalProperties: false
} satisfies JsonValue;

export function createBasicToolsPlugin(): HarnessPlugin {
  const bashDriver: ActivityDriver = {
    async status(activity) {
      const proc = runningBashProcesses.get(activity.id);
      return compactJson({
        status: activity.status,
        pid: proc?.pid,
        command: activityCommand(activity),
        result: activity.result ?? null
      });
    },
    async cancel(activity) {
      const proc = runningBashProcesses.get(activity.id);
      if (proc) {
        await proc.cancel();
        runningBashProcesses.delete(activity.id);
      }
    },
    async summarizeCompletion(activity) {
      const result = activity.result;
      const command = activityCommand(activity);
      if (activity.status === "cancelled") {
        return [{ type: "text", text: `Bash command cancelled: ${command}` }];
      }
      if (isRecord(result) && typeof result.summary === "string") {
        return [{ type: "text", text: result.summary }];
      }
      if (activity.status === "failed") {
        return [{ type: "text", text: `Bash command failed: ${command}` }];
      }
      return [{ type: "text", text: `Bash command completed: ${command}` }];
    }
  };
  return {
    id: BASIC_TOOLS_PLUGIN_ID,
    activityDrivers: {
      [BASH_ACTIVITY_KIND]: bashDriver
    }
  };
}

export function createBasicTools(): HarnessTool[] {
  return [
    createReadFileTool(),
    createWriteFileTool(),
    createListFilesTool(),
    createGrepTool(),
    createBashTool(),
    createActivityStatusTool(),
    createActivityOutputTool(),
    createActivityCancelTool()
  ];
}

export function createReadFileTool(): HarnessTool {
  return {
    name: "read_file",
    description: "Read a file through the active execution context.",
    inputSchema: READ_FILE_INPUT_SCHEMA,
    requiresExecutionContext: true,
    async execute({ call, runtime, io }) {
      const input = requireRecord(call.input);
      const filePath = requireString(input.path, "path");
      const result = await requireRuntime(runtime).readFile(filePath);
      if (result.kind === "text") {
        const text = result.text ?? "";
        return okResult(call, {
          summary: `Read ${filePath} (${result.byteSize} bytes)`,
          content: [
            {
              type: "text",
              text: truncate(text, 4000)
            },
            {
              type: "data",
              label: "file",
              data: {
                path: filePath,
                byteSize: result.byteSize,
                mimeType: result.mimeType,
                sha256: result.sha256 ?? null,
                truncated: text.length > 4000
              }
            }
          ],
          data: { path: filePath, kind: "text", byteSize: result.byteSize, mimeType: result.mimeType }
        });
      }
      const asset = await io.createAsset({
        uri: result.uri ?? `context://${filePath}`,
        mimeType: result.mimeType,
        byteSize: result.byteSize,
        origin: { kind: "tool_read", detail: { path: filePath } },
        metadata: { path: filePath },
        ...(result.sha256 ? { sha256: result.sha256 } : {})
      });
      return okResult(call, {
        summary: `Read binary ${filePath} as asset ${asset.id}`,
        content: [
          assetBlockFor(asset.id, result.mimeType, filePath),
          {
            type: "data",
            label: "file",
            data: {
              path: filePath,
              byteSize: result.byteSize,
              mimeType: result.mimeType,
              sha256: result.sha256 ?? null
            }
          }
        ],
        data: { path: filePath, kind: "binary", assetId: asset.id, mimeType: result.mimeType },
        assetIds: [asset.id]
      });
    }
  };
}

export function createWriteFileTool(): HarnessTool {
  return {
    name: "write_file",
    description: "Write UTF-8 text through the active execution context.",
    inputSchema: WRITE_FILE_INPUT_SCHEMA,
    requiresExecutionContext: true,
    async execute({ call, runtime }) {
      const input = requireRecord(call.input);
      const filePath = requireString(input.path, "path");
      const content = requireString(input.content, "content");
      await requireRuntime(runtime).writeFile(filePath, content);
      return okResult(call, {
        summary: `Wrote ${filePath}`,
        content: [{ type: "text", text: `Wrote ${filePath} (${content.length} chars)` }],
        data: { path: filePath, charCount: content.length }
      });
    }
  };
}

export function createListFilesTool(): HarnessTool {
  return {
    name: "list_files",
    description: "List files through the active execution context.",
    inputSchema: LIST_FILES_INPUT_SCHEMA,
    requiresExecutionContext: true,
    async execute({ call, runtime }) {
      const input = requireRecord(call.input);
      const filePath = typeof input.path === "string" ? input.path : ".";
      const rows = await requireRuntime(runtime).listFiles(filePath);
      return okResult(call, {
        summary: `Listed ${rows.length} entries under ${filePath}`,
        content: [
          {
            type: "data",
            label: "files",
            data: rows as unknown as JsonValue
          },
          {
            type: "text",
            text: rows.map((row) => `${row.kind}\t${row.path}${row.byteSize === undefined ? "" : `\t${row.byteSize}`}`).join("\n")
          }
        ],
        data: { path: filePath, entries: rows as unknown as JsonValue }
      });
    }
  };
}

export function createGrepTool(): HarnessTool {
  return {
    name: "grep",
    description: "Search text files through the active execution context.",
    inputSchema: GREP_INPUT_SCHEMA,
    requiresExecutionContext: true,
    async execute({ call, runtime }) {
      const input = requireRecord(call.input);
      const pattern = requireString(input.pattern, "pattern");
      const filePath = typeof input.path === "string" ? input.path : ".";
      const limit = typeof input.limit === "number" ? input.limit : 50;
      const rows = await requireRuntime(runtime).grep({ pattern, path: filePath, limit });
      return okResult(call, {
        summary: `Found ${rows.length} matches for ${pattern}`,
        content: [
          {
            type: "text",
            text: rows.map((row) => `${row.path}:${row.line}: ${row.text}`).join("\n")
          },
          {
            type: "data",
            label: "matches",
            data: rows as unknown as JsonValue
          }
        ],
        data: { pattern, matches: rows as unknown as JsonValue }
      });
    }
  };
}

export function createBashTool(): HarnessTool {
  return {
    name: "bash",
    description: "Run a shell command through the active execution context with runtime live stdout/stderr.",
    inputSchema: BASH_INPUT_SCHEMA,
    requiresExecutionContext: true,
    async execute({ call, runtime, io }) {
      const input = requireRecord(call.input);
      const command = requireString(input.command, "command");
      const wait = typeof input.wait === "string" ? input.wait : "completion";

      if (wait === "start") {
        const activeRuntime = requireRuntime(runtime);
        if (!activeRuntime.startCommand) {
          throw new Error("Execution runtime does not support background command execution");
        }

        const activity = await io.createActivity({
          ownerPluginId: BASIC_TOOLS_PLUGIN_ID,
          kind: BASH_ACTIVITY_KIND,
          label: `bash: ${command}`,
          status: "running",
          cancellable: true,
          activityState: { command },
          onCompletion: { delivery: "asap" }
        });
        const presenter = io.createOutputPresenter({ metadata: { command, wait } });
        const stdout = await io.openLiveOutput({ activityId: activity.id, name: "stdout", kind: "stdout" });
        const stderr = await io.openLiveOutput({ activityId: activity.id, name: "stderr", kind: "stderr" });
        const stdoutSink = createLiveOutputSink(stdout, presenter, "stdout");
        const stderrSink = createLiveOutputSink(stderr, presenter, "stderr");

        const activeProc = await activeRuntime.startCommand({ command }, { stdout: stdoutSink, stderr: stderrSink });
        runningBashProcesses.set(activity.id, activeProc);

        activeProc.wait().then(
          async (output) => {
            runningBashProcesses.delete(activity.id);
            await closeLiveOutputs(stdout, stderr);
            if (await activityIsCancelled(io, activity.id)) {
              return;
            }
            const summary = `Command exited ${output.exitCode}`;
            await io.completeActivity(activity.id, {
              exitCode: output.exitCode,
              signal: output.signal ?? null,
              summary
            }, output.exitCode === 0 ? "completed" : "failed");
          },
          async (err) => {
            runningBashProcesses.delete(activity.id);
            await closeLiveOutputs(stdout, stderr);
            if (await activityIsCancelled(io, activity.id)) {
              return;
            }
            await io.completeActivity(activity.id, {
              error: String(err),
              summary: `Command failed: ${err}`
            }, "failed");
          }
        );

        const summary = `Started command in background: ${command}`;
        return {
          toolCallId: call.id,
          status: "ok",
          summary,
          content: [
            { type: "text", text: summary },
            { type: "activity_ref", activityId: activity.id, label: activity.label },
            { type: "data", label: "bash_activity", data: { activityId: activity.id, command } }
          ],
          data: { activityId: activity.id, command },
          assetIds: [],
          artifactIds: []
        };
      } else {
        const activity = await io.createActivity({
          ownerPluginId: BASIC_TOOLS_PLUGIN_ID,
          kind: BASH_ACTIVITY_KIND,
          label: `bash: ${command}`,
          status: "running",
          cancellable: true,
          activityState: { command }
        });
        const presenter = io.createOutputPresenter({ metadata: { command, wait } });
        const stdout = await io.openLiveOutput({ activityId: activity.id, name: "stdout", kind: "stdout" });
        const stderr = await io.openLiveOutput({ activityId: activity.id, name: "stderr", kind: "stderr" });
        const stdoutSink = createLiveOutputSink(stdout, presenter, "stdout");
        const stderrSink = createLiveOutputSink(stderr, presenter, "stderr");

        const activeRuntime = requireRuntime(runtime);
        const output = await (async () => {
          try {
            return activeRuntime.startCommand
              ? await waitForStartedProcess(activity.id, await activeRuntime.startCommand({ command }, { stdout: stdoutSink, stderr: stderrSink }))
              : await activeRuntime.runCommand({ command }, { stdout: stdoutSink, stderr: stderrSink });
          } finally {
            await closeLiveOutputs(stdout, stderr);
          }
        })();
        if (await activityIsCancelled(io, activity.id)) {
          const summary = `Command cancelled: ${command}`;
          const presentation = await presenter.prepareFinal({
            status: "cancelled",
            summary,
            metadata: { command, activityId: activity.id }
          });
          return {
            toolCallId: call.id,
            status: "error",
            summary,
            content: [
              { type: "text", text: summary },
              { type: "activity_ref", activityId: activity.id, label: activity.label },
              ...presentation.content
            ],
            data: { command, cancelled: true, ...presentationData(presentation.data) },
            assetIds: [],
            artifactIds: []
          };
        }

        const summary = `Command exited ${output.exitCode}`;
        await io.completeActivity(activity.id, {
          exitCode: output.exitCode,
          signal: output.signal ?? null,
          summary
        }, output.exitCode === 0 ? "completed" : "failed");
        const presentation = await presenter.prepareFinal({
          status: output.exitCode === 0 ? "completed" : "failed",
          summary,
          metadata: { command, activityId: activity.id, exitCode: output.exitCode, signal: output.signal ?? null }
        });

        return {
          toolCallId: call.id,
          status: output.exitCode === 0 ? "ok" : "error",
          summary,
          content: [
            { type: "text", text: summary },
            { type: "activity_ref", activityId: activity.id, label: activity.label },
            ...presentation.content,
            { type: "data", label: "command", data: { command, exitCode: output.exitCode, signal: output.signal ?? null } }
          ],
          data: { command, exitCode: output.exitCode, signal: output.signal ?? null, ...presentationData(presentation.data) },
          assetIds: [],
          artifactIds: []
        };
      }
    }
  };
}

export function createActivityStatusTool(): HarnessTool {
  return {
    name: "activity_status",
    description: "Check the status of an activity.",
    inputSchema: ACTIVITY_ID_INPUT_SCHEMA,
    requiresExecutionContext: false,
    async execute({ call, io }) {
      const input = requireRecord(call.input);
      const activityId = requireString(input.activityId, "activityId");
      const status = await io.getActivityStatus(activityId);
      return okResult(call, {
        summary: `Activity ${activityId} status: ${JSON.stringify(status)}`,
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        data: status
      });
    }
  };
}

export function createActivityOutputTool(): HarnessTool {
  return {
    name: "activity_output",
    description: "Inspect live output for a running activity.",
    inputSchema: ACTIVITY_OUTPUT_INPUT_SCHEMA,
    requiresExecutionContext: false,
    async execute({ call, io }) {
      const input = requireRecord(call.input);
      const activityId = requireString(input.activityId, "activityId");
      const limit = typeof input.limit === "number" ? input.limit : 100;
      const preview = await io.peekActivityOutput(activityId, { limit });
      if (!preview) {
        return okResult(call, {
          summary: `Live output unavailable for activity ${activityId}`,
          content: [{ type: "text", text: `Live output unavailable for activity ${activityId}` }],
          data: { activityId, available: false }
        });
      }
      const content: ContentBlock[] = [];
      const outputData: Record<string, string> = {};
      for (const channel of preview.channels) {
        const text = preview.frames
          .filter((frame) => frame.channelId === channel.channelId)
          .map((frame) => frame.text ?? "")
          .join("");
        content.push({ type: "text", text: `Output ${channel.name} (${channel.kind}):\n${text}` });
        outputData[channel.name] = text;
      }
      return okResult(call, {
        summary: `Read ${preview.channels.length} live output channels for activity ${activityId}`,
        content,
        data: { activityId, available: true, outputs: outputData, truncated: preview.truncated }
      });
    }
  };
}

export function createActivityCancelTool(): HarnessTool {
  return {
    name: "activity_cancel",
    description: "Cancel a running activity.",
    inputSchema: ACTIVITY_ID_INPUT_SCHEMA,
    requiresExecutionContext: false,
    async execute({ call, io }) {
      const input = requireRecord(call.input);
      const activityId = requireString(input.activityId, "activityId");
      await io.cancelActivity(activityId);
      const summary = `Cancelled activity ${activityId}`;
      return okResult(call, {
        summary,
        content: [{ type: "text", text: summary }],
        data: { activityId, cancelled: true }
      });
    }
  };
}

async function waitForStartedProcess(activityId: string, activeProcess: ActiveProcess): Promise<{ exitCode: number; signal?: string }> {
  runningBashProcesses.set(activityId, activeProcess);
  try {
    return await activeProcess.wait();
  } finally {
    runningBashProcesses.delete(activityId);
  }
}

async function activityIsCancelled(io: { getActivity(id: string): Promise<ActivityRecord | undefined> }, activityId: string): Promise<boolean> {
  return (await io.getActivity(activityId))?.status === "cancelled";
}

function createLiveOutputSink(channel: OutputChannelHandle, presenter: ToolOutputPresenter, kind: OutputKind): (text: string) => Promise<void> {
  return async (text) => {
    presenter.observeChunk?.({ kind, text });
    await channel.append({ text });
  };
}

async function closeLiveOutputs(...channels: OutputChannelHandle[]): Promise<void> {
  await Promise.allSettled(channels.map((channel) => channel.close()));
}

function activityCommand(activity: ActivityRecord): string | undefined {
  const state = activity.activityState;
  return isRecord(state) && typeof state.command === "string" ? state.command : undefined;
}

function compactJson(input: Record<string, JsonValue | undefined>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Record<string, JsonValue>;
}

function presentationData(data: JsonValue): Record<string, JsonValue> {
  return isRecord(data) ? data : { output: data };
}

function okResult(call: ToolCall, input: {
  summary: string;
  content: ContentBlock[];
  data?: JsonValue;
  assetIds?: string[];
  artifactIds?: string[];
}): ToolResult {
  return {
    toolCallId: call.id,
    status: "ok",
    summary: input.summary,
    content: input.content,
    assetIds: input.assetIds ?? [],
    artifactIds: input.artifactIds ?? [],
    ...(input.data === undefined ? {} : { data: input.data })
  };
}

function requireRuntime(runtime: ExecutionRuntime | undefined): ExecutionRuntime {
  if (!runtime) {
    throw new Error("Tool requires an execution context");
  }
  return runtime;
}

function requireRecord(value: JsonValue): Record<string, JsonValue> {
  if (!isRecord(value)) {
    throw new Error("Tool input must be an object");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: JsonValue | undefined, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tool input ${key} must be a non-empty string`);
  }
  return value;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function assetBlockFor(assetId: string, mimeType: string, filename: string): ContentBlock {
  if (mimeType.startsWith("image/")) {
    return { type: "image_ref", assetId, alt: filename };
  }
  if (mimeType === "application/pdf") {
    return { type: "pdf_ref", assetId, filename };
  }
  return { type: "file_ref", assetId, filename, mediaType: mimeType };
}
