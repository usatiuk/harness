import { fileURLToPath } from "node:url";
import { build, type BuildOptions } from "esbuild";
import { describe, expect, it } from "vitest";

// Build scripts are JavaScript without declarations; import the production options,
// rather than duplicating the keepNames contract that this regression protects.
const buildScript = new URL("../../../scripts/build-payloads.mjs", import.meta.url).href;
const { payloadBundleOptions } = (await import(buildScript)) as {
  payloadBundleOptions: BuildOptions;
};
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const classifier = (name: string) => JSON.stringify(`${packageRoot}${name}/src/errors.ts`);

const fixture = `
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { classifyTransientFailure as openai } from ${classifier("openai-core")};
import { classifyTransientFailure as anthropic } from ${classifier("anthropic-core")};
import { classifyTransientFailure as gemini } from ${classifier("gemini-api")};
import { codexCredentials } from ${JSON.stringify(`${packageRoot}openai-codex/src/credentials.ts`)};

export async function run() {
  const results = [];
  for (const provider of ['openai', 'codex', 'anthropic', 'gemini']) {
    for (const mode of ['timeout', 'coded-timeout', 'connection', 'cancel', 'rate-limit', 'server', 'auth', ...(provider === 'codex' ? ['quota'] : [])]) {
      const controller = new AbortController();
      let calls = 0;
      const fetch = async () => {
        calls++;
        if (mode === 'timeout') {
          // These SDKs treat AbortError with a live caller signal as their own
          // timeout. GenAI instead recognizes the fetch TimeoutError directly.
          throw new DOMException('fixture', provider === 'gemini' ? 'TimeoutError' : 'AbortError');
        }
        if (mode === 'cancel') {
          controller.abort();
          throw new DOMException('fixture', 'AbortError');
        }
        if (mode === 'coded-timeout' || mode === 'connection') {
          // No timeout wording: classification must inspect the transport cause.
          const cause = Object.assign(new Error('fixture'), {
            code: mode === 'coded-timeout' ? 'ETIMEDOUT' : 'ECONNRESET',
          });
          throw new TypeError('fetch failed', { cause });
        }
        const status = mode === 'rate-limit' || mode === 'quota' ? 429 : mode === 'server' ? 503 : provider === 'codex' ? 403 : 401;
        return new Response(JSON.stringify({
          ...(provider === 'codex' ? { detail: 'Codex readable detail' } : {}),
          error: {
            message: 'fixture',
            type: mode === 'quota' ? 'billing_error' : mode === 'rate-limit' ? 'rate_limit_error' : mode === 'auth' ? 'authentication_error' : 'api_error',
            ...(mode === 'quota' ? { code: 'insufficient_quota' } : {}),
          },
        }), { status, headers: { 'content-type': 'application/json', 'retry-after': '2' } });
      };
      let request;
      let classify;
      const originalFetch = globalThis.fetch;
      if (provider === 'openai') {
        const client = new OpenAI({ apiKey: 'fixture', fetch, maxRetries: 0 });
        request = () => client.responses.create({ model: 'fixture', input: 'fixture' }, { signal: controller.signal });
        classify = openai;
      } else if (provider === 'codex') {
        globalThis.fetch = fetch;
        const client = await codexCredentials({
          getValidSession: async () => ({ accessToken: 'fixture', accountId: 'fixture' }),
        }).client(controller.signal);
        request = () => client.responses.create({ model: 'fixture', input: 'fixture' }, { signal: controller.signal });
        classify = openai;
      } else if (provider === 'anthropic') {
        const client = new Anthropic({ apiKey: 'fixture', fetch, maxRetries: 0 });
        request = () => client.messages.create({ model: 'fixture', max_tokens: 1, messages: [] }, { signal: controller.signal });
        classify = anthropic;
      } else {
        const client = new GoogleGenAI({ apiKey: 'fixture', httpOptions: { fetch } });
        request = () => client.interactions.create({ model: 'fixture', input: 'fixture' }, { signal: controller.signal, maxRetries: 0 });
        classify = gemini;
      }
      try {
        await request();
      } catch (error) {
        const failure = classify(error, controller.signal);
        results.push({
          provider, mode, calls,
          reason: failure?.reason,
          retryAfterMs: failure?.retryAfterMs,
          preservesCause: failure ? failure.cause === error : undefined,
          message: error.message,
          status: error.status,
          code: error.code,
          type: error.type,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  }
  return results;
}
`;

interface Result {
  provider: string;
  mode: string;
  calls: number;
  reason: string | undefined;
  retryAfterMs: number | undefined;
  preservesCause: boolean | undefined;
  message: string;
  status: number | undefined;
  code: string | undefined;
  type: string | undefined;
}

describe("payload-bundled model error classification", () => {
  it.each([false, true])("classifies real SDK errors (minify: %s)", async (minify) => {
    const output = await build({
      ...payloadBundleOptions,
      minify,
      write: false,
      // Match the payload's CJS bridge, using a file URL because this bundle
      // executes from a data URL rather than an on-disk payload entry.
      banner: {
        js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)});`,
      },
      stdin: { contents: fixture, resolveDir: packageRoot, sourcefile: "sdk-errors.mjs" },
    });
    expect(output.outputFiles).toHaveLength(1);
    const source = output.outputFiles[0]!.text;
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    const bundled = (await import(moduleUrl)) as { run(): Promise<Result[]> };
    const results = await bundled.run();
    expect(results).toHaveLength(29);
    for (const result of results) {
      const expectedReason = {
        timeout: "timeout",
        "coded-timeout": "timeout",
        connection: "connection",
        cancel: undefined,
        "rate-limit": "rate_limit",
        server: "server",
        auth: undefined,
        quota: undefined,
      }[result.mode];
      expect(result.reason, `${result.provider}/${result.mode}`).toBe(expectedReason);
      expect(result.calls).toBe(1);
      expect(result.preservesCause).toBe(expectedReason ? true : undefined);
      expect(result.retryAfterMs).toBe(
        result.mode === "rate-limit" || result.mode === "server" ? 2_000 : undefined,
      );
      if (
        result.provider === "codex" &&
        ["rate-limit", "server", "auth", "quota"].includes(result.mode)
      ) {
        expect(result.message).toContain("Codex readable detail");
        expect(result.status).toBe(
          result.mode === "server" ? 503 : result.mode === "auth" ? 403 : 429,
        );
        if (result.mode === "quota") {
          expect(result.code).toBe("insufficient_quota");
          expect(result.type).toBe("billing_error");
        }
      }
    }
  });
});
