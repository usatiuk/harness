import { Command } from "commander";
import { launch } from "./index.tsx";
import { runLogin, runLogout, runStatus } from "./auth.ts";

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
const providerOption = ["--provider <id>", "auth provider", "openai-codex"] as const;
auth
  .command("login")
  .description("sign in to a model provider via OAuth")
  .option(...providerOption)
  .action(async (opts: { provider: string }) => {
    await runLogin(opts.provider);
  });
auth
  .command("status")
  .description("show whether you are signed in")
  .option(...providerOption)
  .action(async (opts: { provider: string }) => {
    await runStatus(opts.provider);
  });
auth
  .command("logout")
  .description("sign out and clear stored credentials")
  .option(...providerOption)
  .action(async (opts: { provider: string }) => {
    await runLogout(opts.provider);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
