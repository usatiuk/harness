# Custom model providers via configuration

**Status:** In progress — schema, factory (`packages/custom-providers`), CLI wiring, presets, and `fileTools` all landed; built-in auth seeding is the open thread. The config schema was refactored to per-model scope on 2026-08-09 — see the deviation note and `2026-08-09-custom-provider-model-scope.md`.
**Created:** 2026-08-08
**Updated:** 2026-08-09
**Area:** cross-cutting (config, cli, protocol, custom-providers)

## Goal

Allow users to register custom model providers (local LLMs, self-hosted endpoints, third-party APIs) through configuration without recompiling Harness. Each custom provider declares its API shape (OpenAI-compatible, Anthropic-compatible) and named presets that map to generation parameters (temperature, topP, maxTokens, etc.).

**Completion condition:** A user can add a custom provider to `~/.harness/settings.json`, select it via `model`, and have it stream through the existing agent loop with the same cancellation, persistence, tool dispatch, and middleware behavior as built-in providers.

## Current behavior

- Providers are **hardcoded** in `packages/cli/src/auth.ts` via `authRegistry()`.
- Each built-in provider is a compiled `Plugin` produced by a factory function (`createOpenAIPlugin`, `createAnthropicPlugin`).
- The OpenAI API provider already accepts `baseURL` for custom endpoints (`packages/openai-api/src/index.ts:7-8`).
- The config schema (`settingsDocSchema`) has an opaque `plugins: Record<string, unknown>` field but no structured custom provider schema.
- `ModelConfig` is minimal: `{ provider, model, effort? }`. Generation parameters (temperature, topP) do not exist in the core protocol.
- The `effort` field is provider-opaque — it is a string resolved by the provider factory into SDK-specific parameters.

## Chosen approach

Extend the config system with a structured `customProviders` section. Each entry declares its API compatibility shape and named presets. A factory layer in the CLI reads these entries at composition time and produces `Plugin` objects, which are wired into `HarnessService` alongside built-in providers.

### Config schema

> **Superseded:** the example and Slice 1 below describe the original _fused_
> shape (one entry = one endpoint = one model). On 2026-08-09 this was refactored
> to per-model scope: an entry owns only `endpoint`/`apiKey`/`type`
> (`sendInstructionsAsSystem` on responses) and serves `models.<id>`, each entry
> with its own `fileTools`, `contextWindow`, `maxOutputTokens`, and `presets`. The
> old shape is no longer accepted (see the deviation note above and
> `2026-08-09-custom-provider-model-scope.md`).

```jsonc
{
  "customProviders": {
    "my-llm": {
      "type": "openai-responses-compatible",
      "endpoint": "http://localhost:8080/v1",
      "apiKey": "sk-custom-key",
      "model": "llama-3.1-8b",
      "contextWindow": 262144,
      "maxOutputTokens": 16384,
      "fileTools": "string_replace",
      "sendInstructionsAsSystem": true,
      "presets": {
        "fast": { "temperature": 0.7, "topP": 0.9 },
        "creative": { "temperature": 1.0, "topP": 0.95, "maxTokens": 4096 },
        "precise": { "temperature": 0.2, "topP": 0.5 },
      },
    },
  },
  "model": { "provider": "my-llm", "model": "llama-3.1-8b", "preset": "fast" },
}
```

`fileTools` is the file-editing dialect the workspace plugin's roster is selected from. Its default is `string_replace` for `openai-responses-compatible` (and the later `openai-completions-compatible`) and `text_editor` for `anthropic-compatible`, because freeform "custom" tools (only emitted by the `apply_patch` profile) are rejected by function-only local backends (e.g. MediaPipe/OVMS returns `400: Only function tools are supported`).

### Preset semantics

A preset is a named collection of generation parameters. The preset name is provider-opaque in `ModelConfig` — it is simply a string key that the custom provider factory resolves into SDK-specific parameters. This mirrors the existing `effort` pattern:

| Existing (`effort`)                              | New (`preset`)                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `{ low, medium, high }` maps to reasoning effort | `{ fast, creative, precise }` maps to temperature/topP/maxTokens |
| Provider factory maps string → single SDK param  | Provider factory maps string → multiple SDK params               |
| `ModelSpec.efforts` lists available values       | `models.<id>.presets` defines per-model presets with params      |

Unknown preset names fail fast (no silent fallback). The core protocol never exposes generation parameters — they live exclusively in the custom provider config.

### Protocol boundary

```
User config ──► customProviders.{id} ──► factory ──► Plugin { providers: () => [...] }
                                            │
ModelConfig: { provider, model, preset? }   │
                  │                        │
                  └── preset string ────────┘
                             ↓
              factory looks up preset in customProviderSpec.presets
                             ↓
              maps to SDK parameters during request construction
```

The core types (`ModelConfig`, `ModelRequest`, `ModelProvider`) are **unchanged**. The preset is an opaque string resolved at the provider boundary.

## Deviations from this plan (as built)

- The factory lives in a dedicated **`custom-providers`** workspace package (`src/factory.ts`), not `packages/cli/src/custom-provider-factory.ts`.
- `apiKey` is inline in the custom provider settings entry and validated at parse time; the planned secrets-store indirection (Slice 4) is not implemented. The keyless-local case uses an explicit dummy key.
- The provider's registry id is the config key (`customProviders.<id>`).
- Core's `modelSchema` renamed the reasoning axis from `effort` to `preset`; custom providers additionally expose `fileTools` (see above).
- OpenAI-compatible entries accept an opt-in `sendInstructionsAsSystem` flag: some backends (e.g. OVMS) accept the Responses request shape but silently drop the top-level `instructions` field, so the flag renders `ModelRequest.instructions` as a leading `system` input message instead. Off by default; backends honoring `instructions` natively are unchanged. (`customProviderSchema`, `CustomOpenAIProvider`, `packages/custom-providers/src/factory.ts`.)
- On 2026-08-09 the fused single-model entry was split into provider vs per-model scope: an entry now owns only `endpoint`/`apiKey`/`type` (plus responses-only `sendInstructionsAsSystem`), and each served model lives under `models.<id>` with its own `fileTools`, `contextWindow`, `maxOutputTokens`, and `presets`. `capabilities(model)` and preset/limit resolution are per model. The old single-model shape (provider-level `model`/`contextWindow`/`maxOutputTokens`/`fileTools`/`presets`) is no longer accepted; local config is migrated manually. Full design in `2026-08-09-custom-provider-model-scope.md`.

## Invariants

- Custom providers share the same `ModelProvider` interface and streaming contract as built-in providers.
- The agent loop, tool dispatch, persistence, cancellation, and middleware apply identically to custom and built-in providers.
- Custom provider configuration is validated at parse time; invalid configs fail the settings resolution.
- Unknown preset names are rejected (fail fast).
- The file-editing dialect defaults to a profile whose tools a typical local backend can send (function-only: `string_replace` for OpenAI-compatible, `text_editor` for Anthropic-compatible). MediaPipe/OVMS rejects the freeform `apply_patch` custom tool.
- The kernel does not import custom provider packages; custom providers are plugins wired at the CLI composition root (`packages/cli/src/index.tsx` reads `customProviders` from global settings).

## Non-goals

- Automatic model discovery or catalog fetching from custom endpoints.
- Provider-native execution tools (tools still run through Harness-owned tool plugins).
- A generic "universal provider" that tries to auto-detect API shapes.
- Per-request temperature overrides (can be added later via per-conversation settings or middleware).
- Custom provider hot-reload without restart (settings are read at composition time).

## Implementation slices

### Slice 1: Config schema and resolution

**Packages:** `@harness/config`

- Extend `settingsDocSchema` with `customProviders: z.record(z.string(), customProviderSchema).optional()`.
- Define `customProviderSchema`: `{ type, endpoint, apiKey, models.<id>: { fileTools?, contextWindow?, maxOutputTokens?, presets? } }` where `type` is `"openai-responses-compatible"`, `"openai-completions-compatible"`, or `"anthropic-compatible"`, and each `presets` is a record of named generation-parameter sets. (The pre-refactor descriptions below predate the 2026-08-09 per-model scope; `model`/`contextWindow`/`maxOutputTokens`/`fileTools`/`presets` live under each model id now.)
- The schema validates at settings parse time. Unknown types, malformed presets, empty model maps, and (on completions/anthropic) `fileTools: "apply_patch"` are rejected.

### Slice 2: Factory layer

**Packages:** `@harness/custom-providers` (new)

- Read `customProviders` from resolved settings during `buildHarness()`.
- Map each entry through a factory that produces `Plugin` objects.
- `type: "openai-responses-compatible"` → subclass `CustomOpenAIProvider` (OpenAI Responses) with custom `baseURL`.
- `type: "anthropic-compatible"` → subclass `CustomAnthropicProvider` (Messages API) with custom `baseUrl`.
- Resolve preset names into generation parameters during request construction.
- Provide `capabilities()` honoring the configured `fileTools`, so the workspace plugin picks a compatible editor roster for function-only backends.

### Slice 3: Composition root wiring

**Packages:** `@harness/cli`

- Modify `buildHarness()` in `packages/cli/src/index.tsx` to read `customProviders` from `readGlobalSettings(defaultHome())`.
- Call `createCustomProviderPlugins` to produce `Plugin[]` from custom provider entries.
- Push custom plugins into the `plugins` array before constructing `HarnessService`.
- Custom providers are tried concurrently; a failed custom provider logs a warning but does not prevent other providers from loading.
- Schema validation is strict (fail-fast) at parse time: a malformed `customProviders` entry anywhere in a settings file fails that file's resolution for all providers — like a stray `auth`, there is no per-entry warn-and-skip. Runtime failures (unreachable endpoint, non-200) surface per-request, not as load-time warnings.

### Slice 4: API key handling for custom providers

**Packages:** `@harness/cli`, `@harness/secrets`

- Custom provider API keys are stored in the secrets store (same as built-in providers).
- The config references the key via env var name or a stored-key identifier.
- The factory retrieves the key from the secrets store when building the plugin.

### Slice 5: Documentation and validation

- Update `docs/subsystems/models/README.md` to document custom provider behavior.
- Add unit tests for schema validation, factory output, and error cases.
- Update `PLAN.md` to reflect the new capability in the subsystem index.

## Affected boundaries

| Package                                  | Change                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/config/src/settings.ts`        | Add `customProviders` schema (`fileTools`, limits, presets)                   |
| `packages/config/src/settings.ts`        | Validate at parse time                                                        |
| `packages/custom-providers/src/**` (new) | Providers + factory (`factory.ts`, `custom-openai.ts`, `custom-anthropic.ts`) |
| `packages/cli/src/auth.ts`               | No change (custom providers are config-driven, not auth-registry-driven)      |
| `packages/cli/src/index.tsx`             | Wire custom plugins in `buildHarness()` (`createCustomProviderPlugins`)       |
| `docs/subsystems/models/README.md`       | Document custom provider behavior (pending)                                   |
| `PLAN.md`                                | Update subsystem status (pending)                                             |

## Validation

### Unit tests

- Schema rejects unknown provider types, missing required fields, and malformed presets.
- Factory produces a valid `Plugin` with a working `ModelProvider` for each supported type.
- Preset lookup returns correct generation parameters; unknown preset throws.
- OpenAI-compatible factory maps `baseURL` correctly to the SDK client.
- Anthropic-compatible factory maps `baseUrl` correctly to the SDK client.

### Integration tests

- A custom provider configured in settings.json streams through the full agent loop (send → tool calls → completion).
- Cancellation of a custom provider stream behaves identically to built-in providers.
- A custom provider with an unreachable endpoint fails gracefully without blocking other providers.
- Custom provider usage and cost tracking works (if pricing is specified in the config).

### Failure scenarios

- Missing `endpoint` field → rejected at schema validation.
- Missing `apiKey` field → rejected at schema validation (it is a required key, so the whole settings file fails loudly).
- Unknown preset name in `model.preset` → rejected at settings resolution.
- Custom provider endpoint returns non-200 → normalized error surface, no retry for deterministic failures.

## Documentation impact

- Update `docs/subsystems/models/README.md` with custom provider section.
- Update `PLAN.md` subsystem index to reflect custom provider capability.
- No changes to `docs/DEFERRED.md` (custom providers are the feature being added, not deferred).

## Unresolved

- Should preset resolution happen at settings resolution time (early validation) or at request time (lazy, allows runtime changes)?
- Should custom providers support model catalogs (auto-discovery of available models on the endpoint)? Deferred for now.
- Should per-request generation overrides be added to `ModelRequest` or handled via middleware? Deferred.
