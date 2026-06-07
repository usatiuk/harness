import { spawn } from "node:child_process";

const workspaces = [
    "@harness/protocol",
    "@harness/core",
    "@harness/auth-openai",
    "@harness/model-openai-common",
    "@harness/model-openai",
    "@harness/model-openai-chatgpt",
    "@harness/service",
    "@harness/store-sqlite",
    "@harness/testkit",
    "@harness/cli",
];

for (const workspace of workspaces) {
    await run("npm", ["run", "build", "--workspace", workspace]);
}

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: "inherit",
            cwd: new URL("..", import.meta.url),
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `${command} ${args.join(" ")} exited with ${code ?? "unknown status"}`,
                ),
            );
        });
    });
}
