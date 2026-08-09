# Custom providers: per-model scope refactor

**Status:** Active

**Goal:** Decouple model-scoped configuration from provider-scoped configuration in
the config-defined custom provider system, so one endpoint can serve many models
each with its own `fileTools`, capacity limits, and presets. Defer a full
`opencode-go` preset axis to a follow-up slice.

## Background

Since 2026-08-08 the `customProviders` schema has fused three lives into one
entry: a config key is a registry id, an endpoint/auth pair, AND exactly one
model with its capacity, file-editing dialect, and presets. Consequences:

- One endpoint cannot be shared by several models; adding `gpt-oss-20b` beside
  `qwen3.6-35b` on the same OVMS server duplicated the whole entry, presets
  included (presets are model-specific knobs — gpt-oss uses only
  `chat_template_kwargs.reasoning_effort`, qwen uses `top_k`/`min_p`/etc.).
- `fileTools` selects the entire tool roster per turn
  (`packages/workspace/src/index.ts`), so it is a per-model trained dialect, not
  an endpoint attribute.
- `capabilities(model)` on the `ModelProvider` contract (`packages/protocol`)
  exists exactly to be model-dependent, but every custom class and built-in
  implements a parameterless version that ignores the argument. Only
  `opencode-go` honors it.
- Presets are per-model knobs; the current per-provider map forces each custom
  provider to describe one model's presets.

## Approach

Keep the `ModelProvider`/`ModelInfo`/`ModelConfig` protocol contracts unchanged
(preset stays a provider-opaque string). Restructure only the config schema and
the custom-provider runtime:

```jsonc
"customProviders": {
  "ovms": {
    "type": "openai-completions-compatible",
    "endpoint": "http://127.0.0.1:8000/v1",
    "apiKey": "unused",
    "models": {
      "qwen3.6-35b": { "contextWindow": 262144, "maxOutputTokens": 16384,
                       "fileTools": "string_replace",
                       "presets": { "deep": { "temperature": 1, "extraBody": {} } } },
      "gpt-oss-20b": { "contextWindow": 131072, "maxOutputTokens": 8192,
                       "fileTools": "string_replace",
                       "presets": { "high": { "temperature": 1, "extraBody": {} } } }
    }
  }
}
```

### Ownership split

| Concern                                     | Scope                             |
| ------------------------------------------- | --------------------------------- |
| `endpoint`, `apiKey`                        | provider                          |
| `type` (transport)                          | provider                          |
| `sendInstructionsAsSystem` (responses only) | provider (endpoint wire behavior) |
| `fileTools`                                 | model                             |
| `contextWindow`, `maxOutputTokens`          | model                             |
| `presets`                                   | model                             |

Keyed-by-model record (not an array): the model id is the unique key, so a
duplicate id is structurally impossible — important because
`findModel(listModels(), model)` (`protocol/src/model.ts:60`, `find()` first
match) and capacity/pricing lookups in `core/src/engine.ts` rely on one entry per
id. Errors also cite the model name (`models.gpt-oss-20b.contextWindow`) and it
mirrors opencode's `models.<id>` config shape.

### Non-goals (this change)

- No `opencode-go` preset axis yet; its `validateConfig` keeps rejecting presets.
  Full per-family variants (chat `reasoning_effort`, responses `reasoning.effort`,
  messages `thinking`, incl. the `thinking`+`reasoning_effort` mutual-exclusion 400)
  are a follow-up.
- No migration shim for the old single-model shape (pre-release; the local config
  is migrated here).
- No changes to built-in providers or the protocol.

### Preset/key details

- Preset schemas are unchanged (`openaiPresetSchema`, `anthropicPresetSchema`).
- `apply_patch` refusal stays on `openai-completions-compatible` only: chat is
  function-only (`buildChatParams` throws on custom tools, `openai-core/request.ts:192-197`),
  so `apply_patch` is unrepresentable and fails fast at schema time on any model
  of the completions branch. Responses transports it natively, so responses
  stays free.

## Slices

1. **Config schema** (`packages/config/src/settings.ts`): `customProviderBase`
   becomes `{ endpoint, apiKey }`; add `customModelBase` =
   `{ contextWindow?, maxOutputTokens?, fileTools? }`; each union branch adds a
   `models.<id>` record whose entries carry per-model `fileTools`, capacity, and
   presets. The completions and anthropic branches wrap their model schema with an
   `apply_patch` refine (both transports are function-only); every `models` record
   must be non-empty. Parse-time `fileTools` defaults stay in the provider classes.
2. **Custom factory + classes** (`packages/custom-providers/src/`): one plugin per
   entry; each custom class carries a model map (shared `model-scope.ts` helpers
   emit `listModels()` and run `validateConfig`), `capabilities(model)` resolves
   `fileTools`, `validateConfig` checks the model exists and its chosen preset,
   and request preset/capacity resolution uses the selected model.
3. **Tests** (`config` + `custom-providers`): new per-model catalog, capabilities,
   preset-isolation, unknown-model/preset, empty-catalog, and old-shape-rejection
   coverage.
4. **Docs**: `docs/subsystems/models/README.md`, this plan, sibling plan status.
5. **Local config migration**: `~/.harness/settings.json` rewritten to the new
   shape with `ovms` serving both `qwen3.6-35b` and `gpt-oss-20b` (applied to the
   local machine file; outside the repo, so not in the commit).

## Validation (as shipped)

- Schema parses a multi-model entry; rejects a completions **or anthropic** model
  with `fileTools: "apply_patch"`, rejects an empty `models` map, rejects the
  pre-refactor provider-level shape, and rejects malformed presets.
- Factory builds one plugin whose `listModels()` returns every model.
- `capabilities(model)` returns that model's `fileTools`; unknown models fall
  back to the family's function-only default.
- Preset and capacity resolution are per model; an unknown preset for the chosen
  model rejects, and a model lacking a preset is unaffected by presets that
  exist on sibling models.
- Local settings parsed end-to-end with the shipped schema.
- `npm run check` green (688 tests passing).
