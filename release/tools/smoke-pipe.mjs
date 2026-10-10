import { createRequire } from "node:module";
import { cp, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";

if (process.platform !== "win32") throw new Error("This qualification requires native Windows");
const output = resolve("release/output/windows-x64");
await mkdir(output, { recursive: true });
const binding = resolve(output, `harness-native-${randomUUID()}.node`);
if (!process.env.HARNESS_NATIVE_BINDING)
  throw new Error("Run this check through the managed development bootstrap");
await cp(process.env.HARNESS_NATIVE_BINDING, binding);
process.env.HARNESS_NATIVE_BINDING = binding;
const { PipeListener, adoptPipe } = createRequire(import.meta.url)(
  resolve("packages/native/index.cjs"),
);
const deadline = setTimeout(() => {
  console.error("Windows pipe qualification exceeded its 30-second deadline");
  process.exit(1);
}, 30_000);

async function exchange(listener, name, text) {
  const accepting = listener.accept();
  const client = createConnection(name);
  await once(client, "connect");
  const descriptor = await accepting;
  assert.equal(typeof descriptor, "number");
  assert.ok(descriptor > 2);
  const server = adoptPipe(descriptor);
  try {
    const received = once(server, "data");
    client.write(text);
    assert.equal((await received)[0].toString(), text);
    const returned = once(client, "data");
    server.write("reply");
    assert.equal((await returned)[0].toString(), "reply");
  } finally {
    const closed = [once(client, "close"), once(server, "close")];
    client.destroy();
    server.destroy();
    await Promise.all(closed);
  }
}

const name = `\\\\.\\pipe\\harness-${randomUUID()}`;
const listener = new PipeListener(name);
try {
  await exchange(listener, name, "first");
  await exchange(listener, name, "replacement");
  const departed = createConnection(name);
  await once(departed, "connect");
  const departure = once(departed, "close");
  departed.destroy();
  await departure;
  assert.equal(await listener.accept(), null);
  await exchange(listener, name, "after early disconnect");
  const pending = listener.accept().then(
    () => {
      throw new Error("Closed listener admitted a connection");
    },
    (error) => {
      assert.equal(error.code, "Cancelled");
    },
  );
  await listener.close();
  await pending;
  // FIRST_PIPE_INSTANCE proves no pending listener handle keeps the name alive.
  const reopened = new PipeListener(name);
  await reopened.close();
  // Covers cancellation before the worker has started its accept wait.
  for (let index = 0; index < 20; index++) {
    const candidate = new PipeListener(name);
    const closed = candidate.accept().catch((error) => assert.equal(error.code, "Cancelled"));
    await candidate.close();
    await closed;
  }
  {
    // More pending listeners than the default libuv pool must leave filesystem
    // work and closure of an idle listener able to complete.
    const waiting = Array.from(
      { length: 6 },
      () => new PipeListener(`\\\\.\\pipe\\harness-${randomUUID()}`),
    );
    const accepts = waiting.map((entry) =>
      entry.accept().catch((error) => assert.equal(error.code, "Cancelled")),
    );
    const idle = new PipeListener(`\\\\.\\pipe\\harness-${randomUUID()}`);
    try {
      await Promise.all([cp(binding, `${binding}.copy`), idle.close()]);
    } finally {
      await Promise.all(waiting.map((entry) => entry.close()));
      await Promise.all(accepts);
    }
    console.log(
      "Windows pipe adoption, duplex I/O, replacement, cancellation and worker-pool independence passed.",
    );
  }
} finally {
  await listener.close();
  clearTimeout(deadline);
}
