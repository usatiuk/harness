import OpenAI from "openai";
import type { OpenAICredentials } from "@harness/openai-core";

export interface ApiKeyOptions {
  apiKey: string;
  baseURL?: string;
}

/** Credentials backed by a single API-key client. */
export function apiKeyCredentials(opts: ApiKeyOptions): OpenAICredentials {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  return { client: () => Promise.resolve(client) };
}

export * from "./provider-type.ts";
