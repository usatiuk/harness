import { expect, it, expectTypeOf } from "vitest";
import { randomUUID } from "node:crypto";
import { HARNESS_PROTOCOL_VERSION } from "@harness/protocol";
import {
  connectionCommandSchema,
  hostConnectionTargetSchema,
  LOCAL_HOST,
  parseConnectionCommandResult,
  defaultClientConfig,
  type ClientConfig,
} from "./contracts.ts";

it("rejects impossible Local provisioning and remote stop/bridge prerequisites at the boundary", () => {
  const remote = {
    id: "work",
    label: "Work",
    kind: "ssh",
    destination: "work",
    runtime: { source: "managed" },
  };
  const identity = {
    serverId: randomUUID(),
    instanceId: randomUUID(),
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    home: "/home/user/.harness",
    pid: 1,
    platform: "linux",
    buildId: "fixture",
  };
  expect(
    connectionCommandSchema.safeParse({ type: "runtime.prepare", host: LOCAL_HOST }).success,
  ).toBe(false);
  expect(
    connectionCommandSchema.safeParse({
      type: "server.stop",
      host: remote,
      identity,
      runtime: null,
    }).success,
  ).toBe(false);
  expect(hostConnectionTargetSchema.safeParse({ host: remote, runtime: null }).success).toBe(false);
  expect(hostConnectionTargetSchema.parse({ host: LOCAL_HOST, runtime: null })).toEqual({
    host: LOCAL_HOST,
    runtime: null,
  });
});

it("validates native command results once and exposes the corresponding result type", () => {
  const config = parseConnectionCommandResult({ type: "config.read" }, defaultClientConfig());
  expectTypeOf(config).toEqualTypeOf<ClientConfig>();
  const distros = parseConnectionCommandResult({ type: "wsl.list" }, ["Ubuntu"]);
  expectTypeOf(distros).toEqualTypeOf<string[]>();
  expect(distros).toEqual(["Ubuntu"]);
  expect(() => parseConnectionCommandResult({ type: "wsl.list" }, [1])).toThrow();
  expect(() =>
    parseConnectionCommandResult(
      {
        type: "server.stop",
        host: LOCAL_HOST,
        identity: {
          serverId: randomUUID(),
          instanceId: randomUUID(),
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          home: "fixture",
          pid: 1,
          platform: "linux",
          buildId: "fixture",
        },
        runtime: null,
      },
      {},
    ),
  ).toThrow();
});
