import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Substitute only the remote process environment, keeping the real SSH/WSL command. */
export async function remoteProcessFixture(directory: string, prefix: string): Promise<string> {
  const preload = join(directory, "remote-process-environment.mjs");
  await writeFile(
    preload,
    `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (Array.isArray(args) && ((command === 'wsl.exe' && args.at(-4) === '--exec' && args.at(-3) === 'sh' && args.at(-2) === '-c') || (command === 'ssh' && args.at(-1)?.startsWith('sh -c ')))) {
    args = [...args];
    args[args.length - 1] = ${JSON.stringify(prefix)} + args.at(-1);
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
`,
  );
  return preload;
}
