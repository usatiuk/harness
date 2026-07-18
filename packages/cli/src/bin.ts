import { Command } from "commander";
import { launch } from "./index.tsx";
import { runLogin, runLogout, runStatus } from "./auth-app.tsx";
import { runSandboxShell, runSandboxStop } from "./sandbox-cli.ts";

const program = new Command();

program
  .name("harness")
  .description("an agent harness with an Ink TUI")
  .version("0.0.0")
  .option("--model <id>", "model id override")
  .option("--cwd <dir>", "working directory for the session")
  .action(async (opts: { model?: string; cwd?: string }) => {
    await launch({ model: opts.model, cwd: opts.cwd });
  });

program
  .command("resume [id]")
  .description("resume a conversation (omit the id to pick from a list)")
  .action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
    const globals: { model?: string; cwd?: string } = cmd.optsWithGlobals();
    await launch({ resume: true, conversationId: id, model: globals.model, cwd: globals.cwd });
  });

const auth = program.command("auth").description("manage model-provider sign-in");
auth
  .command("login")
  .description("sign in to a model provider (interactive picker by default)")
  .option("--provider <id>", "provider to sign in to (skips the picker)")
  .option("--store <backend>", 'where to keep the key: "keyring" or Unix-only "file"')
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
  process.exitCode = 1;
});
