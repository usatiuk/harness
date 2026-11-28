import type { HarnessClientService } from "@harness/client";
import type { HarnessEvent } from "@harness/protocol";

const unexpected = (): never => {
  throw new Error("Unexpected client operation in CLI fixture");
};

/** Presentation tests exercise the client API, not the server's runner API. */
export function testClientService(
  overrides: Partial<HarnessClientService> = {},
): HarnessClientService {
  return {
    availableModels: () => [],
    subscribe: unexpected,
    deliver: unexpected,
    send: unexpected,
    compact: unexpected,
    forkBefore: unexpected,
    setModel: unexpected,
    setPreset: unexpected,
    setPluginConfig: unexpected,
    ...overrides,
  };
}

export function testEventClient(overrides: Partial<HarnessClientService> = {}) {
  let listener: ((event: HarnessEvent) => void) | undefined;
  const service = testClientService({
    subscribe: (_id, next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    ...overrides,
  });
  return {
    service,
    emit: (event: HarnessEvent) => {
      if (!listener) throw new Error("Cannot emit a fixture event without a mounted subscriber");
      listener(event);
    },
  };
}
