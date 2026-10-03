import type OpenAI from "openai";

/** Auth seam: returns a client per call so an OAuth impl can refresh tokens. */
export interface OpenAICredentials {
  client(signal: AbortSignal): Promise<OpenAI>;
}
