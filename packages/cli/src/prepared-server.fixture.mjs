import { Buffer } from "node:buffer";
import process from "node:process";

// The test controls the real helper's output and retirement through IPC. The
// production boundary still reads ordinary stdout and closes ordinary stdin.
let remainder = Buffer.alloc(0);
process.stdin.resume();
process.stdin.on("end", () => process.send("eof"));
process.on("message", (message) => {
  if (message.kind === "fragment") {
    const wire = Buffer.from(message.wire);
    const split = message.split ?? Math.floor(wire.length / 2);
    remainder = wire.subarray(split);
    process.stdout.write(wire.subarray(0, split));
  } else if (message.kind === "complete") {
    process.stdout.write(remainder);
  } else if (message.kind === "write") {
    process.stdout.write(message.wire);
  } else if (message.kind === "exit") {
    if (message.diagnostic) process.stderr.write(message.diagnostic);
    process.exit(message.code ?? 0);
  } else if (message.kind === "write-and-exit") {
    process.stdout.write(message.wire, () => process.exit(message.code ?? 0));
  } else if (message.kind === "alive") {
    process.send("alive");
  } else {
    throw new Error("Unknown fixture command");
  }
});
process.send("ready");
