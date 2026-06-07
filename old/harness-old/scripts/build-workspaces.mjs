import { spawn } from "node:child_process";

const workspaces = [
  "@harness/protocol",
  "@harness/ui-protocol",
  "@harness/core",
  "@harness/auth-openai",
  "@harness/model-openai-common",
  "@harness/model-openai",
  "@harness/model-openai-chatgpt",
  "@harness/model-ai-sdk",
  "@harness/plugin-control",
  "@harness/plugin-mcp",
  "@harness/plugin-tasks",
  "@harness/plugin-subagents",
  "@harness/sandbox-host",
  "@harness/sandbox-docker-worktree",
  "@harness/service",
  "@harness/store-sqlite",
  "@harness/tools-basic",
  "@harness/testkit",
  "@harness/harness-cli"
];

for (const workspace of workspaces) {
  await run("npm", ["run", "build", "--workspace", workspace]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "unknown status"}`));
    });
  });
}
