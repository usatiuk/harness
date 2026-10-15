import { z } from "zod";
import { captureText } from "./docker-cli.ts";

const container = z.object({
  id: z.string(),
  environment: z.string(),
  project: z.string(),
  root: z.string(),
  state: z.string(),
});
export interface DockerWorkspace {
  id: string;
  workspaceRoot: string | null;
  running: boolean;
  containers: string[];
}

export async function dockerCommand(args: string[]): Promise<string> {
  const result = await captureText("docker", args);
  if (result.exitCode) throw new Error(`Docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Explicit inventory; list only public labels/state, never inspect credentials or race deleted IDs. */
export async function dockerInventory(scope: string): Promise<DockerWorkspace[]> {
  const format =
    '{"id":{{json .ID}},"environment":{{json (.Label "harness.environment")}},"project":{{json (.Label "com.docker.compose.project")}},"root":{{json (.Label "harness.workspace.root")}},"state":{{json .State}}}';
  const workspaces = new Map<string, DockerWorkspace>();
  for (const filter of [`label=harness.server=${scope}`, "label=com.docker.compose.project"]) {
    const output = await dockerCommand([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      filter,
      "--format",
      format,
    ]);
    for (const line of output.split("\n").filter(Boolean)) {
      const entry = container.parse(JSON.parse(line));
      const id = entry.environment || entry.project;
      if (!id.startsWith(`harness_${scope}_`)) continue;
      const workspace = workspaces.get(id) ?? {
        id,
        workspaceRoot: null,
        running: false,
        containers: [],
      };
      workspace.workspaceRoot = entry.root || workspace.workspaceRoot;
      workspace.running ||= ["running", "paused", "restarting"].includes(entry.state);
      if (!workspace.containers.includes(entry.id)) workspace.containers.push(entry.id);
      workspaces.set(id, workspace);
    }
  }
  const networks = await dockerCommand([
    "network",
    "ls",
    "--filter",
    "label=com.docker.compose.project",
    "--format",
    '{{.Label "com.docker.compose.project"}}',
  ]);
  for (const id of networks.split("\n").filter(Boolean)) {
    if (id.startsWith(`harness_${scope}_`) && !workspaces.has(id))
      workspaces.set(id, { id, workspaceRoot: null, running: false, containers: [] });
  }
  return [...workspaces.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function controlDockerWorkspace(
  scope: string,
  id: string,
  action: "stop" | "remove",
): Promise<void> {
  const workspace = (await dockerInventory(scope)).find((entry) => entry.id === id);
  if (!workspace) throw new Error("Docker environment is not owned by this Harness server");
  if (workspace.containers.length)
    await dockerCommand(
      action === "remove"
        ? ["rm", "-f", ...workspace.containers]
        : ["stop", ...workspace.containers],
    );
  if (action === "remove") {
    const networks = (
      await dockerCommand([
        "network",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${id}`,
      ])
    )
      .split(/\s+/)
      .filter(Boolean);
    if (networks.length) await dockerCommand(["network", "rm", ...networks]);
  }
}
