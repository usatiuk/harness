# OpenCode Go and OpenAI chat/completions transport

**Status:** Complete — implemented 2026-08-08; corrected and hardened 2026-08-09.

## Outcome

Harness supports an API-key-authenticated `opencode-go` provider over the Go
gateway and a reusable OpenAI chat/completions transport for config-defined local
or third-party backends.

## Final architecture

- `OpenAIChatProvider` owns chat request construction, function-tool mapping,
  plaintext reasoning round-trip, streaming normalization, terminal validation,
  cancellation, context-overflow mapping, and nullable usage.
- `OpenCodeGoProvider` presents one provider id and delegates each rostered model
  to chat/completions, Responses, or Anthropic Messages according to the gateway's
  documented endpoint table. Grok 4.5 is chat; GPT 5.6 Luna is Responses;
  MiniMax/Qwen models use Messages. Unknown ids fail validation.
- OpenAI SDK clients use `https://opencode.ai/zen/go/v1`. The Anthropic SDK uses
  `https://opencode.ai/zen/go` because it appends `/v1/messages`.
- The gateway model endpoint returns ids but not transport/capacity metadata, so
  the package keeps a compiled roster. Inert deprecation metadata is not modeled.
- Go Responses requests remain stateless (`store: false`) and request encrypted
  reasoning content so multi-step continuation can replay provider fidelity.
- Go Messages requests obtain `max_tokens` from the compiled roster and omit
  unsupported built-in Claude thinking/effort configuration.

## Chat semantics

Instructions and durable context become one leading system message. Each model
generation reconstructs as one assistant message carrying its text,
`reasoning_content`, and function calls. Tool results are native tool messages.
Freeform custom tools fail before the request is sent.

The stream translator buffers fragmented calls, emits them in numeric index
order only after a valid `tool_calls` finish, and rejects missing ids/names.
`length`, `content_filter`, unfinished calls, and unsupported finish reasons are
terminal errors. Partial text is preserved; reported or explicitly unknown usage
is recorded before the logical turn fails. A clean terminal finish without a
usage tail records `usage: null`, never fabricated zeros.

## Authentication and composition

`OPENCODE_API_KEY` or the selected secure credential store enables the compiled
provider. `OPENCODE_MODEL` may select its auth-login default, but the id must exist
in the roster. Config-defined chat providers use the separate global-settings
path documented in the custom-provider plan.

## Evidence and remaining live boundary

Unit tests cover roster/family selection, all transport delegates, request/event
mapping, tool-call fragmentation and malformed terminals, nullable usage,
reasoning reconstruction, cancellation-facing errors, and context overflow.
Opt-in `OPENCODE_API_KEY` tests exercise one request per family and DeepSeek's
reasoning/tool-call continuation shape. They remain outside normal CI; a
two-request live Responses reasoning replay is still credential-gated evidence.

See [chat reasoning round-trip](2026-08-09-chat-reasoning-round-trip.md) and
[provider follow-up hardening](2026-08-09-provider-follow-up-hardening.md).
