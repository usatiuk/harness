import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

/** Preserve only daemon selection; never reuse the user's Docker config/credentials/cache. */
export async function dockerTestEnvironment(directory: string) {
  const context = process.env["DOCKER_CONTEXT"];
  const host =
    !context && process.env["DOCKER_HOST"]
      ? process.env["DOCKER_HOST"]
      : (
          await promisify(execFile)("docker", [
            "context",
            "inspect",
            ...(context ? [context] : []),
            "--format",
            "{{.Endpoints.docker.Host}}",
          ])
        ).stdout.trim();
  await mkdir(directory, { recursive: true });
  return { DOCKER_HOST: host, DOCKER_CONTEXT: undefined, DOCKER_CONFIG: directory };
}
