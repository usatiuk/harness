import type { ExecutionContextRecord } from "@harness/protocol";
import type { HarnessStore } from "./store.ts";

export interface ExecutionCommandInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecutionCommandOutput {
  exitCode: number;
  signal?: string;
}

export interface ExecutionOutputSinks {
  stdout(text: string): Promise<void>;
  stderr(text: string): Promise<void>;
}

export interface ActiveProcess {
  pid?: number;
  wait(): Promise<ExecutionCommandOutput>;
  cancel(): Promise<void>;
}

export interface ExecutionRuntime {
  context: ExecutionContextRecord;
  readFile(path: string): Promise<{
    kind: "text" | "binary";
    text?: string;
    uri?: string;
    mimeType: string;
    byteSize: number;
    sha256?: string;
  }>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<Array<{ path: string; kind: "file" | "directory"; byteSize?: number }>>;
  grep(input: { pattern: string; path?: string; limit?: number }): Promise<Array<{ path: string; line: number; text: string }>>;
  runCommand(input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ExecutionCommandOutput>;
  startCommand?(input: ExecutionCommandInput, sinks: ExecutionOutputSinks): Promise<ActiveProcess>;
}

export interface ExecutionProvider {
  kind: string;
  resolve(context: ExecutionContextRecord): Promise<ExecutionRuntime>;
}

export class ExecutionContextRegistry {
  private readonly providers = new Map<string, ExecutionProvider>();

  public constructor(private readonly store: HarnessStore) {}

  public register(provider: ExecutionProvider): void {
    this.providers.set(provider.kind, provider);
  }

  public async getActiveContext(conversationId: string): Promise<ExecutionContextRecord | undefined> {
    const conversation = await this.store.getConversation(conversationId);
    if (!conversation?.executionContextId) {
      return undefined;
    }
    return this.store.getExecutionContext(conversation.executionContextId);
  }

  public async resolveRuntime(conversationId: string): Promise<ExecutionRuntime> {
    const context = await this.getActiveContext(conversationId);
    if (!context) {
      throw new Error(`Conversation ${conversationId} has no active execution context`);
    }
    const provider = this.providers.get(context.providerKind);
    if (!provider) {
      throw new Error(`No execution provider registered for ${context.providerKind}`);
    }
    return provider.resolve(context);
  }
}
