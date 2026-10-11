# Mistral configured models

Status: Complete

## Outcome and design

Mistral API/Vibe connections accept optional `config.models.<exact-model-id>`
entries with `label`, `contextWindow`, and `maxOutputTokens`. Explicit fields
override discovered metadata; missing IDs become selectable models using the
existing native transport and file-tool capabilities. Discovery still runs at
boot. Configured entries survive failed discovery; the existing bootstrap reports
a degraded catalog with its original diagnostic. Credentials remain required.

Before this follow-up, the Mistral schema accepted only credentials and web search,
and the provider validated IDs against its discovered map. This change extends
that boundary without introducing a shared model registry, transport, or UI. Preserve
discovered reasoning presets and temperatures. Do not invent controls for manual
entries, propagate alias overrides, change other connectors, or configure an
unverified vendor model/limit on the user's machine.

Capacity values must be positive integers and output cannot exceed context when
both are known, including after merging discovery. Keep the existing 5,000-model
limit over the combined catalog and publish complete snapshots atomically.
Limits describe capacity; the existing advisory request-output cap is unchanged.

## Completion checks

- [x] Implement strict config validation, initial configured catalog, and atomic
      discovery merge. Verify additions, per-ID overrides, retained native controls,
      discovery failure, malformed limits, and catalog bounds in focused tests.
- [x] Exercise a configured-only model through saved settings, startup discovery,
      public RPC selection, and real local HTTP/SSE generation. Verify exact ID,
      catalog metadata, affinity, and unchanged usage/history behavior.
- [x] Update user instructions, models architecture, product status, and testing
      coverage. Run `npm run check`, inspect the diff, and resolve independent
      correctness, architecture/simplicity, and test/scope reviews.

## Evidence

The initial worktree was clean. The user authorized committing and pushing this
change to main on 2026-10-11, rebasing first if needed.
Vendor acceptance and billing are outside the local fixture's evidence.

Focused validation passes all four Mistral/config/RPC files (58 tests) on Windows,
Node 24.19.0. Dependency installation and Vitest cache renames require unsandboxed
execution after observed EPERM failures. The first typecheck identified inferred
optional fields incompatible with exact optional public types; explicit presence
projection fixes that boundary. The first RPC assertion selected the built-in
default because sign-in intentionally resets it; the fixture now selects the
manual model explicitly through public conversation overrides, preserving auth
behavior. The corrected original generation assertion passes.

Three independent read-only reviewers report no material findings across
correctness, architecture/failure/simplicity, and tests/docs/scope. Typechecking,
repository formatting, affected-file ESLint, and `git diff --check` pass.
The full test suite passes 1,240 tests, skips 36, and fails two unchanged MCP OAuth
cases: unanswered sign-in expiry times out and admitted-refresh logout reports
`MCP connection unavailable`. Both reproduce in the isolated, unchanged OAuth
file (five other cases pass); their causes remain unestablished and no MCP code,
assertions, or timeouts were changed. All four Mistral test files pass in the full
run, including public selection after failed discovery.

On the initial base, `npm run check` passed typechecking but stopped at two existing
`no-undef` lint errors for `process`/`console` in unchanged
`scripts/check-desktop-package.mjs` (lines 6/14). Formatting and the full tests were
therefore run separately. The subsequent rebase onto main at `6e88d9d` incorporated
the upstream correction of those lint errors; all 58 focused tests pass again on
the rebased change (product version 0.1.3), and repository lint and formatting pass.
The unrelated MCP failures remain open;
no required Mistral implementation or local fixture integration remains unfinished.
No vendor calls were made.
