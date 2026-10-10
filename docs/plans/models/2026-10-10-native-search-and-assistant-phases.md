# Native web search and assistant message phases

Status: Complete. Native search, Mistral connections and conversation routing
are consolidated on current main and verified.

## Outcome

Enable native web search through OpenAI API, Codex OAuth, Anthropic, Gemini and
Mistral using provider-owned configuration. Preserve finalized assistant messages,
reported phases and exposed reasoning through the existing immutable conversation
log and public client protocol.

## Contract

- Supported provider types own `webSearch: boolean`, default false. The selected
  connection copies safe `providerOptions` data onto the request and existing
  context-build trace. There is no generic hosted-tool registry or metadata hook.
- Tool declarations follow provider settings independently of `toolChoice`.
  Adapters forward tool choice to the native API; Harness adds no search-specific
  suppression rule.
- Native search runs inside an ordinary provider invocation. Its visible Harness
  activity is display-only text such as "Searched the web." A `provider_output`
  hint may be persisted for transcript display, but has no provider payload and
  never enters model context, compaction summaries or loop control.
- There are no search continuation flags, turn identities, stored continuation
  tokens or Harness search-resumption loops. An incomplete provider
  invocation uses the existing terminal-error path and preserves reported usage.
- Deltas are ephemeral previews. Each finalized message or reasoning block
  replaces its preview and is appended once. Graceful interruption preserves
  partial readable content without an incomplete signed payload; a hard crash
  can lose an unfinalized preview.
- Messages preserve reported phase strings, null and absence. Phase is output
  metadata and does not control execution. Reasoning is a separate item containing
  provider-exposed text or summaries, with opaque-only blocks allowed to be empty.
- Assistant messages and supported reasoning/local-function metadata can use the
  existing provider/model/type/version sidecar. This sidecar is never attached to
  search hints. Clients receive canonical content and phase, never raw sidecars.
- Gemini stateless Interactions and Anthropic Messages require finalized native
  search history on subsequent requests. Native steps/blocks are kept in the
  sidecar of the next finalized reasoning/message/local-call item (or the previous
  item for trailing history). This is conversation context, not executable search
  or resumption state.
  No bundle contains later canonical messages/calls hidden from its selected item.
  Incomplete or invalid responses preserve readable output without these bundles.
  Complete search pairs are correlated across the finalized response, preserving
  any intervening canonical output. Request rendering excludes unmatched entries
  from a selected prefix. An unanswered search beside a local call is excluded
  instead of resumed by a later ordinary request.
- Model changes apply next turn. Foreign reasoning is omitted; canonical assistant
  text and local call/result history remain readable. Historical raw-string calls
  use a narrow text fallback where the target API requires object arguments.
  There is no block conversion framework, rewritten history or forced compaction.
- Normal instructions ask models to cite Markdown links. Answers are unchanged;
  there is no citation converter or Search Suggestions parsing/display framework.
- Existing cancellation and token accounting remain. Safe reported billing counts
  are retained; costs are marked incomplete when native search fees are unpriced.
  Received finalized content and terminal accounting may drain after cancellation;
  no local tool executes afterward. Interrupted Anthropic streams preserve closed
  and open readable blocks without incomplete native metadata, and retain cumulative
  usage when reported. The authoritative terminal event ends the native request.
- Completion is authoritative: further normalized events fail rather than replace
  its first accounting or permit local execution. Billing input from internal native
  requests is marked ineligible as a context checkpoint through one normalized
  boolean. Totals remain intact and the existing unknown-context/estimate paths apply.
  Checkpoint reuse requires unchanged provider options as well as instructions/tools.
- Automatic compaction retains existing local-tool continuation; manual compaction
  and auto-approval use `toolChoice: "none"`. Search hints cannot continue either.

## Provider boundaries

| Provider                   | Native API                                                         |
| -------------------------- | ------------------------------------------------------------------ |
| OpenAI API and Codex OAuth | Existing Responses transport with `web_search`                     |
| Anthropic                  | Existing Messages transport with `web_search_20250305`             |
| Gemini                     | Native Interactions, direct model, `google_search`, `store: false` |
| Mistral                    | Native Conversations, direct model, `web_search`, `store: false`   |

Gemini adds a small provider plugin using its official SDK. Mistral reuses the
existing API/Vibe plugin and OpenAI HTTP/SSE client, with one streaming
Conversations mapper. Both Mistral connections use that transport regardless of
search settings, preserving their separate credentials/catalogs and model-derived
temperature/reasoning controls in `completion_args`. Every call retains the
calling conversation's `x-affinity` and Harness User-Agent. No remote Agent is created.

Conversations emits indexed message/function fragments and terminal usage without
individual entry-completion events. The adapter owns that response-local assembly;
live previews finalize in content order. Only terminal completion authorizes native
message/function replay and local calls. A complete native group is anchored on its
last canonical item and replayed only when every member is selected. Hosted execution
is excluded from the bundle. Existing signed Mistral reasoning/argument sidecars
remain valid native input. There is no second transport, SDK client, remote session,
model allowlist or Chat fallback.

Primary sources checked on 2026-10-10:

- [OpenAI reasoning and phases](https://developers.openai.com/api/docs/guides/reasoning)
  and [web search](https://developers.openai.com/api/docs/guides/tools-web-search).
- [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool).
  [Tool-use troubleshooting](https://platform.claude.com/docs/en/agents-and-tools/tool-use/troubleshooting-tool-use)
  explains why an unanswered server call is pending work and cannot be ordinary
  finalized history.
- [Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview)
  and [Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search).
- [Mistral Conversations](https://docs.mistral.ai/studio/agents/agents-api)
  and [web search](https://docs.mistral.ai/studio/agents/agent-tools/websearch).

[Google grounding terms](https://ai.google.dev/gemini-api/terms) are deployment
information. This change adds no terms interpretation or implementation approval gate.

## Milestones and verification

- [x] Consolidate both Mistral connections on streaming Conversations in the existing
      plugin. Preserve credentials, catalog controls, signed reasoning, exact local
      calls, affinity, cancellation and unknown accounting. Remove the Chat path,
      duplicate package and intermediate implementation.
- [x] Verify the combined delivery against current main, including native stream
      fixtures, public connection tests and conversation routing. Run the full
      check, actual bundle and three independent reviews; update final evidence.

- [x] Establish explicit finalization, assistant phases and display-only hint types.
      Completion: every shipped adapter produces finalized messages; hints cannot
      carry provider payloads or request search continuation.
- [x] Wire provider-owned search options for the five requested provider families.
      Completion: supported factories expose the setting; request builders declare
      search from that setting and forward `toolChoice` independently.
- [x] Verify display/context separation, phases, reasoning, interruption, switching,
      local tool control, cancellation and usage through regression tests.
      Depends on the first two milestones. Completion: focused tests pass, including
      reloaded history and every native request builder ignoring search hints.
- [x] Synchronize subsystem and testing documentation and resolve independent review.
      Depends on regression evidence. Completion: docs describe final behavior and
      reviewers' material findings are addressed with evidence.
- [x] Run `npm run check` and inspect final diff. Depends on all prior milestones.
      Completion: checks pass and remaining live-provider limits are stated precisely.
- [x] Resolve the requested fresh review of code cleanliness and abstraction boundaries.
      Completion: actionable findings are fixed or assessed with evidence and the
      resulting implementation passes affected checks.

## Evidence and limits

The final combined `npm run check` passes all TypeScript projects, ESLint,
Prettier and Vitest: 128 files passed, nine skipped; 1,154 tests passed,
36 skipped (test phase 51.47s). All 57 affected integration tests pass, including
Mistral requests/real HTTP/SSE, public server connection RPC, OpenCode session
routing, LiteLLM native finalization and core call-context identity.
Protocol schema generation, the actual server payload bundle and its syntax
check pass. Three independent read-only reviews report no remaining material
findings across behavior, architecture/simplicity and integration/scope.

The combined review corrected nullable native model/agent fields, later readable
content after unsupported media, exact Conversations call IDs, an empty provider
error being treated as success, and outdated gateway finalization fixtures.
Reasoning assembly now appends native fragments and projects readable output at
finalization, removing repeated growing projections and duplicate display state.
The current-main baseline retains all three Mistral/session-routing commits.

The pre-integration native-search snapshot passed the full check: 1,132 tests,
36 skipped, plus protocol schema generation, actual server bundle/syntax and
three independent reviews. The earlier Mistral/routing delivery is recorded in
[its historical plan](2026-10-10-mistral-support.md). These results do not qualify
the combined tree.

Review regressions cover assistant-only phase schemas, provider-option checkpoint
compatibility, authoritative completion/accounting, malformed historical arguments
and cumulative native billing input. SQLite migration/store contracts, public RPC
and transcript tests cover those shared boundaries. An earlier pre-integration
server-process exclusivity test timed out at its unchanged 20s deadline and did
not reproduce in targeted/full reruns; its cause remains open. Assertions, timeouts
and product behavior were not weakened.

Mistral uses the already pinned OpenAI 7.27.0 HTTP/SSE client and provider-local
native schemas. The duplicate Mistral package, Chat transport, Mistral SDK and
OpenTelemetry peer dependency are removed. The combined tree uses Anthropic
0.104.2 and Google GenAI 2.28.0.

Controlled transport tests establish request and normalization behavior, not live
vendor signature acceptance, OAuth entitlement, actual billing/cache-hit rates,
Vibe-key Conversations acceptance or GLM hosted-search acceptance. Native vendor
responses determine model/key support; no speculative restrictions are added.

## Scope

No additional hosted tools, remote sessions, durable search resumption, native
citation UI, automatic provider fallback, general block conversion or new
conversation store. Search status is presentation data; only finalized native
protocol history belongs in provider metadata.
