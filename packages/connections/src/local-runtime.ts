import { basename } from "node:path";
import { z } from "zod";
import { CacheUse } from "@harness/native";
import { canonicalHome } from "./local.ts";
import type { ServerLaunch } from "./connect.ts";
import { serverCacheEntrySchema } from "./selection.ts";

/** Native preparation owns these complete immutable paths until consumers take use guards. */
export const preparedServerSchema = z.strictObject({
  node: z.string().min(1),
  entry: z.string().min(1),
  payload: z.string().min(1),
  keys: z.tuple([z.string().min(1), z.string().min(1)]),
});
export type PreparedServer = z.infer<typeof preparedServerSchema>;

/** Consume the verified installation directly; never copy it into another cache. */
export async function prepareLocalRuntime(
  prepared: PreparedServer,
  requestedHome: string,
): Promise<{ home: string; launch: ServerLaunch }> {
  const home = await canonicalHome(requestedHome);
  const selection = serverCacheEntrySchema.parse(basename(prepared.payload));
  return {
    home,
    launch: {
      executable: prepared.node,
      args: [prepared.entry, "--background"],
      selection,
      env: { HARNESS_SERVER_CACHE_KEYS: JSON.stringify(prepared.keys) },
      retainUse: () => new CacheUse(home, prepared.keys),
    },
  };
}
