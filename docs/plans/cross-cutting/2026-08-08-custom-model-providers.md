# Custom model providers via configuration

**Status:** Complete — implemented 2026-08-08; hardened 2026-08-09.

## Outcome

Global settings can register OpenAI Responses-compatible, OpenAI
chat/completions-compatible, and Anthropic Messages-compatible endpoints. Each
entry becomes a normal provider plugin at the CLI composition root, so engine,
middleware, persistence, cancellation, usage, and Harness-owned tool behavior are
shared with compiled providers.

```json
{
  "model": { "provider": "local", "model": "qwen", "preset": "fast" },
  "customProviders": {
    "local": {
      "type": "openai-completions-compatible",
      "endpoint": "http://127.0.0.1:8000/v1",
      "apiKey": "unused",
      "models": {
        "qwen": {
          "contextWindow": 262144,
          "maxOutputTokens": 16384,
          "fileTools": "string_replace",
          "presets": { "fast": { "temperature": 0.2, "maxTokens": 4096 } }
        }
      }
    }
  }
}
```

`apiKey` is intentionally an inline literal in `~/.harness/settings.json` in
this pre-release implementation; it does not use `@harness/secrets`. Keyless
local endpoints require a dummy value. Users must protect the settings file and
its backups accordingly. Built-in provider credentials continue to use their
environment/secure-store auth paths.

## Final design

- The settings key is both plugin id and provider registry id.
- Endpoint, API key, transport type, and Responses instruction compatibility are
  provider-scoped. Catalog limits, file-tool dialect, and presets are model-scoped
  under `models.<id>`.
- Configuration is strict. Empty catalogs, unknown fields/types, unsupported
  `apply_patch` on function-only transports, unknown models, and unknown presets
  fail before capability-dependent work. Output limits must fit the model's
  declared context/output capacity.
- Presets are provider-opaque names. Explicit invocation output limits override
  preset caps. `extraBody` may add backend extensions but cannot replace
  Harness-owned request structure or standard shaped fields.
- Responses-compatible endpoints may opt into `sendInstructionsAsSystem` for
  servers that ignore the native top-level `instructions` field.
- Chat is function-only and round-trips plaintext `reasoning_content`;
  Anthropic uses its native function-tool and thinking-payload mappings.

## Evidence

- Schema/resolution tests cover all branches, strict model fields, reserved
  extension fields, and model-scoped validation.
- Provider tests cover catalogs, capabilities, preset isolation and precedence,
  request shaping, and factory composition.
- A public-boundary integration test reads a real settings file, creates plugins,
  runs `HarnessService` through a controlled SDK stream and tool call, verifies
  durable usage, and proves cancellation reaches the SDK signal.
- Full repository validation is recorded in the follow-up hardening plan.

## Remaining boundary

Live local/third-party compatibility is endpoint-specific. The generic transports
intentionally do not discover models or normalize arbitrary backend extensions.
The integration regression reproduces the production settings-to-plugin bridge
but does not invoke the private interactive CLI bootstrap itself.
