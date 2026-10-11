# Web search settings follow-up

Research date: 2026-10-11. Scope: expose existing search configuration in the
desktop GUI and make supported direct connections default to enabled.

## Repository evidence

- Six connection schemas already own `config.webSearch`: OpenAI API, Codex OAuth,
  Anthropic API, Gemini API, Mistral API and Mistral Vibe. Before this follow-up
  each schema defaulted to false. Factories already pass it into immutable
  `ModelProvider.providerOptions`; request builders already declare native search.
- `packages/server/src/auth.ts` composes built-in defaults and named global
  connections. Project/profile/conversation settings cannot configure providers.
  A configured built-in entry replaces its default config, so saving just a
  boolean would lose its environment credential source.
- `app.providers.list` and `app.settings.get` project safe application status.
  Desktop provider cards currently offer authentication only. React Router actions
  already refresh settings after successful writes; the server restart button
  already owns confirmation for active conversations.
- Providers are built at server startup. Credential/catalog edits require an
  explicit restart. Search can use that same lifetime without live reconfiguration.
- `packages/config/src/write.ts` already serializes writers by file and atomically
  replaces settings. New writes must run against the latest document inside that
  boundary to preserve concurrent model/plugin/auth changes.
- Compatible providers and LiteLLM use neutral transports. Making a transport
  default search-enabled would affect unrequested providers. Change connection
  schema defaults only; preserve adapter/helper defaults.

## Primary sources checked

- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search):
  Responses exposes hosted `web_search`; automatic tool choice permits optional
  search. Search has its own limits and charges. This confirms that On means
  available when needed, rather than a forced search on every request.
- [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool):
  the existing `web_search_20250305` remains a basic search version. Search executes
  through server tool blocks and has additional usage charges. Updating versions,
  filtering and search continuation is outside this GUI/default change.
- [Gemini grounding](https://ai.google.dev/gemini-api/docs/google-search) and
  [tool combination](https://ai.google.dev/gemini-api/docs/tool-combination):
  Google Search is a built-in tool, with search-specific pricing and protocol
  history requirements. The repository already owns the native mapping/history;
  this change does not modify that implementation or qualify its live acceptance.
- [Mistral web search](https://docs.mistral.ai/studio/agents/agent-tools/websearch):
  `web_search` is available through Conversations/Agents, rather than Chat
  Completions. Both existing Harness Mistral types already use Conversations.
  Keep that transport and their distinct credentials unchanged.

## Generic settings revision

The user requested generic provider-specific GUI settings after rejecting a
search-specific core field. Generic provider schemas already exist; GUI projection
does not. [Zod metadata](https://zod.dev/metadata) offers explicit field opt-in on
the existing schema; metadata must be attached after defaults/refinements.
[Zod JSON Schema conversion](https://zod.dev/json-schema) can inspect selected
fields without converting or exposing credential and opaque config schemas.

Use `.meta({ harnessSetting: true, title, description })` on exposed top-level
fields. Only opted-in descriptors and schema-derived values cross application RPC.
Never infer exposure from a field name, title, type or scalar value. Generic writes
allow only exposed keys, merge into the latest original config, validate the full
provider schema and persist raw merged config, preserving unrelated defaults and
credentials. The initial implemented field shape is a defaulted boolean; another
fixture boolean proves the generic path without shipping speculative controls.
An explicitly exposed unsupported shape is a provider-definition error.

## Decision

Keep the existing provider-owned boolean. Expose one On/Off control in the existing
provider cards. Default supported connection schemas to true, preserving explicit
false. Use a generic provider settings projection and patch in server composition;
add no provider-specific member to the core protocol. Use existing atomic persistence
and explicit restart. No new dependencies, recursive schema renderer, capability
framework, conversation setting, search implementation or compatibility fallback.

Vendor docs establish API shape, not real entitlement or billing with the user's
credentials. Existing fixture evidence remains distinct from live qualification.
