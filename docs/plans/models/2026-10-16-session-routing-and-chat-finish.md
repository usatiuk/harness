# Session routing and repeated chat finishes

Status: Active

## Outcome and design

Use the durable conversation ID for OpenAI-compatible `prompt_cache_key` and
provider session headers. Add a narrow `sessionIdHeader` setting to compatible
connections; no arbitrary interpolation. Go and Mistral retain their existing
wire names through the same helper; LiteLLM defaults to `x-litellm-session-id`.
Configure the user's non-development OpenRouter connection with `x-session-id`.
Keep provider credentials and unrelated settings unchanged.

The shared chat parser currently finalizes every terminal choice and clears its
pending tool map. Repeating an empty `tool_calls` finish in the usage tail then
reports an empty malformed call after emitting the valid call. A regression test
fails with the user's exact error. Actual failing upstream SSE is unavailable;
this proves the parser defect, not the exact payload of the user's failed run.
Finalize once, consume usage tails, and reject later output/conflicting finishes.

Sources: [OpenRouter sticky routing](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
[OpenAI cache keys](https://developers.openai.com/api/docs/guides/prompt-caching),
[LiteLLM session headers](https://docs.litellm.ai/docs/proxy/request_headers).
Existing Go and Mistral implementations/tests establish their current wire behavior.

## Delivery

- [x] Ground request boundaries and reproduce the repeated-finish failure.
- [x] Add the shared session-header primitive, configuration, and provider mappings.
      Verify real HTTP or SDK-boundary headers and stable per-conversation keys.
- [x] Fix repeated terminal handling; verify single dispatch, usage, and errors.
- [x] Synchronize architecture/testing docs and validate with focused/full checks.
- [x] Complete read-only independent reviews and resolve findings.
- [ ] Update non-development OpenRouter settings and report activation limits.

No paid generation or claimed cache-hit improvement is required for this change.
Source checks do not install a newly built application into the non-dev runtime.

## Evidence and activation

Three independent read-only reviews covered correctness, architecture/simplicity,
and tests/docs. Findings resolved: reject preset overrides of the Harness-owned
cache key and reject HTTP framing header names. The compatible wire fixture was
corrected to emit named Anthropic SSE events, matching the SDK contract. Focused
provider/parser checks pass; the new regression failed with the original exact
malformed-tool error before the parser change. Final validation used pinned Node 24.21.0 outside the desktop sandbox with
`TMPDIR=/private/tmp npm run check -- --maxWorkers=2`. Typechecking, lint and
formatting pass. Vitest: 1,408 pass, 63 skip, two fail. The remaining failures are
the previously documented QuickJS runaway-loop timeout and TUI OAuth overlay
fixture. The initial Node 26 run had an SQLite ABI mismatch; the initial sandbox
runs additionally hit canonical temp-path and server-process restrictions. No
assertions or timeouts were weakened. Parser fix commit: `c870955`.

The installed non-development server remains 0.1.20 and does not understand
`sessionIdHeader`. Do not insert that setting into its strict settings document
before upgrading the runtime. After installation, set
`providers.openrouter.config.sessionIdHeader` to `x-session-id`. Source changes
are not a claim that the installed server or upstream cache behavior is verified.
No application installation, release publication, or paid generation was performed.
