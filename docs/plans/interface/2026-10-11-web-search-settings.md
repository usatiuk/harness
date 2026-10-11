# Desktop web search settings

Status: Implemented, independently reviewed and integrated into main with protocol 5. Combined Node 22 source checks, headless browser tests and the production
desktop build pass. Earlier verification failures are recorded below.

Expose provider-owned native web search in Settings → Providers and enable it by
default for supported direct connections. Explicit `webSearch: false` remains an
opt-out. Compatible providers and gateways keep their existing behavior.

## Design and boundaries

Grounding: [repository and primary-source research](../../research/2026-10-11-web-search-settings.md).

- Change only the six existing provider-type schema defaults. Lower adapter and
  helper defaults remain unchanged, protecting neutral compatible/gateway paths.
- Provider-owned config schemas explicitly expose safe top-level fields through
  final-node Zod metadata `{ harnessSetting: true, title, description }`.
  Application status projects only these descriptors and schema-derived values.
  No provider-name list, search-specific status field, or core capability member.
  Initial exposed fields are defaulted booleans; unsupported annotated shapes fail
  as provider-definition defects. Unannotated complex config remains valid.
- Retain each prepared connection's original effective config in the server's
  internal entry. Built-in defaults must survive when first persisted; named
  entries retain their labels, endpoints, credential source and model overrides.
- One generic `app.providers.config.update` request accepts connection ID and a
  patch of exposed fields. Reject unknown/unexposed keys and invalid values before
  writing. Resolve the latest raw config inside the existing atomic global writer,
  merge submitted fields, validate the full original provider schema, and persist
  raw merged config. Preserve sibling updates and existing operation drainage.
- The existing provider card, route action, fetcher feedback and restart control
  implement the UI. Read refreshed server settings after save; avoid a second
  client copy of provider configuration. Show failures without claiming success.
- Providers keep startup lifetime. Saved choices apply after explicit restart;
  no hot reload, generations, or conversation overrides.

This design adds no dependencies, search engines, recursive configuration UI,
capability registry, model allowlist, citation changes, retry rules or live vendor
qualification. A local handoff commit is authorized for integration by the
coordinating thread; this worktree does not push or edit main. Local GUI tests and
installed Harness install/update execution are excluded from that handoff.

## Milestones

- [x] Research and review the plan. Completion: three independent read-only lenses
      cover behavior, architecture/simplicity and validation/scope; reconcile
      material findings before continuing implementation.
- [x] Implement provider defaults, safe status projection, atomic persistence and
      the production GUI control. Depends on plan review.
      Completion: typecheck and focused checks pass, with no core search capability.
- [x] Verify supported/default/named connections, opt-outs, unsupported writes,
      builtin environment source and named credential/endpoint/model preservation,
      concurrent sibling writes, persisted settings after recreation and production
      GUI On/Off save/error/reload behavior with the existing restart affordance.
      Prove generic dispatch with a test-only differently named exposed boolean;
      confirm credential values and unexposed fields cannot be read or patched.
      Depends on implementation; completion: focused tests pass.
- [x] Synchronize docs, inspect the diff, resolve independent review and run
      `npm run check`, affected headless browser tests and `git diff --check`.
      Depends on focused verification; record actual evidence and distinguish
      headless/browser checks from native/live-provider qualification.
- [x] Main integration: advance the exact application protocol version from 4 to
      5 and synchronize protocol docs, schema and fixture references. Completion:
      incompatible peers fail initialization before exchanging strict provider
      statuses. The existing RPC initialization regression covers rejection of
      the previous version; the combined full check passes.

## Validation

Repository and official provider research is recorded. Core `ProviderInstance`
search metadata in the early draft was rejected by the user and removed. Broader
adapter-constructor default changes were removed to limit this to configured
connections. Three independent initial plan reviews found no material gaps.
Following the user's generic-settings steering, all three reviewed the revised
schema opt-in, generic safe projection/patch, boolean-only initial renderer and
credential exclusion. Their requirements are incorporated above; this supersedes
the early search-specific status/RPC plan. No extra framework was recommended.
Implementation verification replaced stale draft assertions with constructed
provider options and reconciled documentation. The six focused files pass 43 tests,
including generic settings, RPC persistence and constructed provider options.
The production route headless browser scenario passes with both web search and a
differently named setting, changed-field patches, explicit opt-out and save errors.
Three final implementation reviews covered behavior, abstraction boundaries and
evidence/scope. Their two findings are corrected: generic control names are prefixed
to avoid hidden form routing fields, and RPC fixtures clear inherited built-in keys
so they cannot make real vendor catalog calls. The original collision is covered
in the existing browser case; both provider/default-settings cases pass after the
correction, and all three RPC cases pass after isolation. The abstraction reviewer
found no remaining material leaks or unnecessary framework. Typechecking, repository
lint, formatting and `git diff --check` pass. The browser result is two passing
cases; its rendered provider controls and restart feedback were visually inspected.

`npm run check` completed with 1,243 passing tests, 36 skipped and three failures:
the two unchanged MCP OAuth failures already recorded in the
[Mistral configured-model delivery](../models/2026-10-11-mistral-configured-models.md),
plus the unchanged server-process safe-settings/graceful-quit case reaching its
20-second timeout. An isolated rerun of both affected files reproduced the same
two OAuth failures, while all three server-process tests passed. The timing cause
remains unestablished; this delivery does not claim a green full gate. No unrelated
code, assertions, retries or timeouts were changed.

Existing provider request/transport tests continue to cover native search
declaration and execution; this change does not alter provider wire protocols.

The worktree started without dependencies. Sandboxed npm workspace symlinks failed;
the prescribed unsandboxed retry installed pinned dependencies and built the native
binding. No package dependency or lockfile changes are intended.

## Integration handoff

The required `settings` field changes both `app.providers.list` and the providers
in `app.settings.get`. The previous provider status schema is strict: an old client
rejects the new extra field, and a new client rejects the old missing field.
Before integration both revisions advertised protocol version 4, so the
exact-version initialize guard did not detect this mismatch. A direct schema
assertion confirmed both status failures and acceptance of a v4 initialize
request. This required advancing the shared protocol references without a
compatibility shim.

Main integration completes that gate: protocol 5, updated initialize fixture,
current protocol documentation and regenerated schema including the new update
request. Both agents' overlapping fixture changes are preserved. The combined
Node 22 full check passes 1,251 tests with 36 skipped using two workers; all 17
headless browser cases and the production desktop build pass. An earlier full
run passed 1,250 tests but the unchanged real-container Docker glob case exceeded
its five-second deadline. Its whole file then passed all 11 tests in isolation
(glob: 866 ms). The timing cause remains unestablished; no assertions, retries or
timeouts were changed. These checks do not establish live-provider or native GUI
behavior, and no installed Harness execution ran on the user's PC.
