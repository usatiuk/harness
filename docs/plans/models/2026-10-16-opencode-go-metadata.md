# OpenCode Go metadata discovery

Status: Complete

## Outcome and design

Use the community-contributed Models.dev `opencode-go` catalog at server boot
instead of maintaining a hand-written roster. Reuse `ModelProvider.refreshModels`
and the server's ten-second discovery budget. Synchronous catalog reads and model
calls use one validated in-memory snapshot. Failed refreshes retain that snapshot;
new processes start from a bundled October 16 upstream snapshot. No disk cache or
periodic refresh is needed for this change: the bundled snapshot provides offline
startup without introducing another persistence lifetime.

Sources: [Models.dev API](https://models.dev/api.json),
[maintainer README](https://github.com/anomalyco/models.dev), and
[Go docs](https://opencode.ai/v2/docs/console/go/), inspected October 16, 2026.
The API advertises limits, reasoning controls, per-model SDK and endpoint metadata;
the old August 9 roster has 25 models versus 31 upstream rows (two deprecated).

Map known OpenAI-compatible, Responses and Anthropic routes explicitly, with fixed
trusted Go credential endpoints. Never use fetched URLs as credential destinations.
Skip unsupported transports and deprecated/non-tool models with bounded safe
diagnostics. Google generateContent support is outside this metadata change: the
existing Gemini provider uses Interactions. Do not infer a new transport from a
model-name prefix. Map the documented OpenAI SDK marker to Responses (including Grok/Muse),
and openai-compatible to Chat. Keep Luna's medium default explicit. Only expose
native reasoning controls whose mapping is established;
metadata does not by itself establish a new wire control. Keep Go usage cost null.

## Milestones and checks

- [x] Implement bounded fetch, boundary validation and catalog normalization; check
      fixture tests for supported/unsupported rows, limits and reasoning controls.
- [x] Connect provider-local snapshots and startup refresh; check public provider
      behavior, actual SDK requests, failed refresh retention and cancellation.
- [x] Update architecture, roadmap and testing guidance; run focused tests and
      `npm run check`, inspect the live API through the production parser.
- [x] Independent review for correctness, architecture/simplicity, and evidence;
      resolve findings and record final checks.

## Validation and limits

Focused validation passes: 32 tests across OpenCode Go and server bootstrap,
with five credential-gated live inference tests skipped. Local HTTP fixtures use
real SDK transports to verify discovered limits, session headers and request
controls. The live Models.dev API passes the production fetch/parser: 28 supported
models, with a diagnostic for the Google route; two deprecated rows are omitted.

Three independent reviews covered correctness, architecture/simplicity and
validation/scope. Correctness review caught the old Grok/Muse Chat assumption:
the official Go endpoints table maps their OpenAI SDK marker to Responses. The
mapping and HTTP regressions are corrected; follow-up review reports no remaining
actionable findings. The old bounded thinking-budget convention is intentionally
retained. Typechecking, lint and formatting passed under the initial shell runtime.
That Node 26 full-test attempt was stopped after SQLite ABI mismatch failures;
the installed dependency was compiled for the repository's pinned Node 24.21.0.
The matching Node 24 run reproduced documented macOS temporary-path alias
assertions, the copied Homebrew Node `libnode` failure and child watcher `EMFILE`.
A focused canonical-temp rerun eliminates the worktree assertion; the copied Node
failure persists. Final full validation uses pinned Node 24, canonical
`TMPDIR=/private/tmp`, two workers and execution outside the desktop sandbox,
without rebuilding shared dependencies. This follows the existing platform
qualification guidance in `docs/TESTING.md`.

Final `npm run check -- --maxWorkers=2` passes typechecking, lint and formatting.
The suite completes with **1,382 passed, 63 skipped and three failures**: the
unchanged TUI OAuth fixture never reaches its overlay, the QuickJS runaway-loop
case exceeds its existing five-second deadline, and the copied Homebrew Node
cannot load `libnode.137.dylib`. These are documented host/test limitations;
none touches Go discovery. The OAuth/QuickJS causes remain unresolved by this
scoped change. No assertions, timeouts or product code were changed to hide them.
All 32 focused Go/bootstrap tests pass again on pinned Node 24.21.0; the final
diff and formatting checks pass.

No authenticated live inference was run. The user subsequently authorized
committing, pushing and releasing this change through the existing patch-release
workflow.
