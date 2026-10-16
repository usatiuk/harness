import { z } from "zod";
import type { ModelCallContext } from "./model.ts";

const reserved = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "content-type",
  "content-length",
  "x-api-key",
  "x-goog-api-key",
]);

/** A routing header must not replace authentication or HTTP framing. */
export const sessionIdHeaderSchema = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "invalid HTTP header name")
  .transform((name) => name.toLowerCase())
  .refine(
    (name) => !reserved.has(name),
    "session header cannot replace authentication or HTTP framing",
  );

/** Connection policy supplies the wire name; the host supplies the durable conversation ID. */
export function sessionIdHeaders(
  context: ModelCallContext,
  headerName?: string,
): Record<string, string> {
  return headerName === undefined ? {} : { [headerName]: context.conversationId };
}
