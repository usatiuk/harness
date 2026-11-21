import { buffer } from "node:stream/consumers";
import { LocalFileOperations } from "@harness/execution";
import type { ByteRange } from "@harness/protocol";

export type FileOperation =
  | { kind: "read"; path: string; range: ByteRange | undefined }
  | { kind: "stat" | "write" | "remove"; path: string }
  | { kind: "list"; pattern: string };

try {
  const input = await buffer(process.stdin);
  const header = input.indexOf(10);
  if (header < 0) throw new Error("Missing native file operation");
  const { operation, workspace } = JSON.parse(input.toString("utf8", 0, header)) as {
    operation: FileOperation;
    workspace: boolean;
  };
  const io = new LocalFileOperations(workspace ? process.cwd() : null);
  switch (operation.kind) {
    case "read":
      process.stdout.write(await io.read(operation.path, operation.range));
      break;
    case "stat":
      process.stdout.write(JSON.stringify((await io.stat(operation.path)) ?? null));
      break;
    case "list":
      process.stdout.write(JSON.stringify(await io.list(operation.pattern)));
      break;
    case "write":
      await io.write(operation.path, input.subarray(header + 1));
      break;
    case "remove":
      await io.remove(operation.path);
      break;
  }
} catch (error) {
  const { message, code } = error as NodeJS.ErrnoException;
  process.stderr.write(JSON.stringify({ message, code }));
  process.exitCode = 1;
}
