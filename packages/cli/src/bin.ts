import { Command } from "commander";
import { launch } from "./index.tsx";

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

program.parseAsync().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
