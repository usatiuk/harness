import { z } from "zod";

// Node timers use signed 32-bit milliseconds. Reserve room for process cleanup.
export const timeoutSecondsSchema = z.number().min(0.001).max(2_147_478);
export const hostTimeoutsSchema = z.strictObject({
  hostStartupSeconds: timeoutSecondsSchema.default(1800),
  shellSeconds: timeoutSecondsSchema.default(60),
  providerDiscoverySeconds: timeoutSecondsSchema.default(60),
  codeCpuSeconds: timeoutSecondsSchema.default(5),
});
export const defaultHostTimeouts = hostTimeoutsSchema.parse({});
