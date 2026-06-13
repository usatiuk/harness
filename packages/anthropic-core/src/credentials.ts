import type Anthropic from "@anthropic-ai/sdk";

/** Auth seam: returns a client per call so an OAuth impl can refresh tokens. */
export interface AnthropicCredentials {
  client(): Promise<Anthropic>;
}
