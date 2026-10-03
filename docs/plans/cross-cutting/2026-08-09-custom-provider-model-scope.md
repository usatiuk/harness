# Custom providers: per-model scope

**Status:** Complete — implemented and validated 2026-08-09. The endpoint/model
scope remains current; its configuration envelope and factory construction were
superseded by [named provider instances](../models/2026-10-03-dynamic-provider-catalogs.md).

## Outcome

One custom endpoint can serve several models without duplicating endpoint/auth
configuration. Model-trained behavior and capacity remain attached to the model
that owns them.

| Concern                                     | Scope    |
| ------------------------------------------- | -------- |
| `endpoint`, `apiKey`, transport `type`      | Provider |
| Responses `sendInstructionsAsSystem`        | Provider |
| `fileTools`, capacity limits, named presets | Model    |

Models are keyed by id rather than stored in an array, making duplicate ids
structurally impossible and matching the provider registry's identity lookup.
The provider catalog, capability lookup, preset lookup, and request shaping all
resolve through the same selected model entry. Unknown models and presets throw;
there is no family-default fallback.

The pre-refactor fused shape is not migrated. Harness is pre-release, so affected
global settings must be rewritten under `models.<id>`.

## Evidence

Tests cover multi-model catalogs, per-model capacities/tool dialects/presets,
unknown model/preset rejection, empty catalogs, strict field validation,
pre-refactor rejection, and public-boundary execution through `HarnessService`.
