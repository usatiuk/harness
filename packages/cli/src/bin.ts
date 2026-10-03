import { Command } from "commander";
import { launch, runStdioServer } from "./index.tsx";
import { runLogin, runLogout, runStatus } from "./auth-app.tsx";
import { runSandboxShell, runSandboxStop } from "./sandbox-cli.ts";
import { runBackgroundServer } from "@harness/server/background";
import { runLocalBridge } from "@harness/connections/node";
import { defaultHome } from "@harness/config";

const program = new Command();

program
  .name("harness")
  .description("an agent harness with an Ink TUI")
  .version("0.0.0")
  .option("--model <id>", "model id override")
  .option("--cwd <dir>", "working directory for the session")
  .option("--connect-stdio", "run the server as a local stdio child process")
  .option("--ssh <destination>", "add/select and provision an SSH connection")
  .option("--host <id>", "select a saved host from client.json")
  .action(
    async (opts: {
      model?: string;
      cwd?: string;
      connectStdio?: boolean;
      ssh?: string;
      host?: string;
    }) => {
      await launch({
        model: opts.model,
        cwd: opts.cwd,
        connectStdio: opts.connectStdio,
        ssh: opts.ssh,
        host: opts.host,
      });
    },
  );

program.hook("preAction", (_command, action) => {
  if (action.parent?.name() !== "auth" && action.parent?.name() !== "sandbox") return;
  const flags: { host?: string; ssh?: string; connectStdio?: boolean } = action.optsWithGlobals();
  if (flags.host || flags.ssh || flags.connectStdio)
    throw new Error(
      "These local utilities do not accept host flags. Use the TUI agent command center for the selected host.",
    );
});

program
  .command("resume [id]")
  .description("resume a conversation (omit the id to pick from a list)")
  .action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
    const globals: {
      model?: string;
      cwd?: string;
      connectStdio?: boolean;
      ssh?: string;
      host?: string;
    } = cmd.optsWithGlobals();
    await launch({
      resume: true,
      conversationId: id,
      model: globals.model,
      cwd: globals.cwd,
      connectStdio: globals.connectStdio,
      ssh: globals.ssh,
      host: globals.host,
    });
  });

program
  .command("server")
  .description("run the headless Harness server")
  .option("--stdio", "serve an isolated connection-owned server over stdin/stdout")
  .option("--background", "run the shared server independently of clients")
  .option("--bridge", "attach stdin/stdout to the shared background server")
  .action(async (opts: { stdio?: boolean; background?: boolean; bridge?: boolean }) => {
    if ([opts.stdio, opts.background, opts.bridge].filter(Boolean).length !== 1)
      throw new Error("Choose --stdio, --background or --bridge");
    if (opts.background) await runBackgroundServer();
    else if (opts.bridge)
      await runLocalBridge(defaultHome(), {
        executable: process.execPath,
        args: [...process.execArgv, process.argv[1]!, "server", "--background"],
      });
    else await runStdioServer();
  });

const auth = program.command("auth").description("manage model-provider sign-in");
auth
  .command("login")
  .description("sign in to a model provider (interactive picker by default)")
  .option("--provider <id>", "provider to sign in to (skips the picker)")
  .option(
    "--store <backend>",
    process.platform === "win32"
      ? 'where to keep credentials: "dpapi"'
      : 'where to keep credentials: "keyring" or "file"',
  )
  .action(async (opts: { provider?: string; store?: string }) => {
    await runLogin({ provider: opts.provider, store: opts.store });
  });
auth
  .command("status")
  .description("show sign-in status (all providers, or one with --provider)")
  .option("--provider <id>", "limit to one provider")
  .action(async (opts: { provider?: string }) => {
    await runStatus(opts.provider);
  });
auth
  .command("logout")
  .description("sign out and clear stored credentials")
  .option("--provider <id>", "provider to sign out of")
  .action(async (opts: { provider?: string }) => {
    await runLogout(opts.provider);
  });

const sandbox = program.command("sandbox").description("manage the dev-container sandbox");
sandbox
  .command("shell")
  .description("open an interactive shell inside the workspace's dev container")
  .action(async (_opts: unknown, cmd: Command) => {
    const globals: { cwd?: string } = cmd.optsWithGlobals();
    await runSandboxShell(globals.cwd);
  });
sandbox
  .command("stop")
  .description("stop the workspace's dev container")
  .action(async (_opts: unknown, cmd: Command) => {
    const globals: { cwd?: string } = cmd.optsWithGlobals();
    await runSandboxStop(globals.cwd);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error);
  process.exitCode =
    error instanceof Error && (error.cause as { code?: string } | undefined)?.code === "SQLITE_BUSY"
      ? 76
      : 1;
});
