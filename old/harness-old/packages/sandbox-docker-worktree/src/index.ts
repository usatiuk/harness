import type { ExecutionContextRecord } from "@harness/protocol";
import type { ExecutionProvider, ExecutionRuntime } from "@harness/core";

export const SOURCE_FIRST_MARKER = "sandbox-docker-worktree:src";

export class DockerWorktreeExecutionProvider implements ExecutionProvider {
  public readonly kind = "docker-worktree";

  public async resolve(_context: ExecutionContextRecord): Promise<ExecutionRuntime> {
    throw new Error("docker-worktree execution provider is a v0 skeleton and is not implemented yet");
  }
}

export function createDockerWorktreeExecutionProvider(): DockerWorktreeExecutionProvider {
  return new DockerWorktreeExecutionProvider();
}
