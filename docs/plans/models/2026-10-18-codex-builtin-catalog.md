# Restore the built-in Codex catalog

Status: Active

## Outcome and scope

Restore the maintained Codex roster without startup model discovery. Keep the
existing `config.models` additions and metadata/generation overrides. Remove the
superseded discovery implementation and dependencies rather than patching its
version negotiation. Commit, push and publish a patch release after validation.
Do not change local account data, credentials, configuration or running servers.

## Evidence and decisions

- The installed Local 0.8.0 server reports Codex authenticated/registered, catalog
  ready, zero models. Installed settings contain no Codex overrides.
- Commit `7789b37` introduced discovery using the Harness product version as the
  Codex `client_version`, then replaced the maintained roster with its response.
  Read-only requests with the same valid stored session reproduce HTTP 200 and
  zero models for `0.8.0`; `0.163.0` returns nine models. No credential refresh or
  paid inference request was made.
- Codex's upstream [request contract](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs)
  and [version source](https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/lib.rs)
  use its own version. The user selected restoration, not another version pin.
- The live October 18 catalog lists seven public models: GPT-6.1 Sol, GPT-6
  Astra/Sol/Luna and GPT-5.6 Sol/Terra/Luna. GPT-5.5 is absent after its announced
  October 14 retirement; two hidden internal models are not part of the built-in
  picker. Public entries accept images, recommend patches, and offer low through
  max reasoning. Sol 6.1/5.6 default to low; others default to medium. Ultra is
  Codex orchestration, not an individual Harness invocation effort.
- Runtime metadata remains provider-owned. Manual models keep conservative JSON
  input/replacement defaults unless configured. No probing, fallback registry,
  cache, retry or new configuration mechanism is needed.
- Preserve the existing documented operational capacity assumptions: 628,000
  input tokens for GPT-6.1 Sol and 400,000 for the others, with a 128,000 output
  reserve. The observed 500,000/272,000 working windows and 872,000 maximum-context
  fields do not independently establish hard input/output limits or justify
  changing shared compaction policy. No new hard-limit claim is made.

## Milestones and completion checks

- [x] Restore the factory and maintained roster; remove discovery-only code,
      helper and dependencies. Check no catalog/credential network request occurs
      during authenticated bootstrap, including a backend that would return an
      empty catalog.
- [x] Verify current metadata, built-in overrides and manual model configuration
      through provider/bootstrap tests and native request construction.
- [x] Synchronize subsystem, testing, root status and superseded delivery notes.
- [x] Pass focused checks, full `npm run check`, and three independent reviews
      covering behavior, architecture/failure risk and tests/docs/simplicity.
- [ ] Commit, push, run the standard patch-release workflow, verify signed public
      metadata and record publication evidence.

## Validation and remaining limits

The new stored-credential bootstrap regression fails before the fix: the empty
response leaves only the two configured IDs, losing the built-in roster. After
restoration it passes with all seven built-ins plus the manual model and no
network calls. Focused Codex/provider-bootstrap validation passes 12 tests.
The broader Codex/shared-OpenAI/bootstrap/named-provider check passes 175 tests
with two gated skips. A separate read-only bootstrap using the user's actual
stored account reports authenticated, registered, ready and seven models with
network access deliberately disabled; zero requests are attempted. This does not
alter the installed server, saved settings or credentials.

Full unrestricted `npm run check` passes typecheck, lint, formatting and 1,704
tests across 168 passing files, with 41 gated skips. Three independent reviewers
cover behavior, architecture/failure risk and tests/docs/scope, each including
simplicity. No code findings remain. The review's stale root-status reference to
Codex discovery is corrected. Deleting the discovery-specific tests accounts for
the lower total; the retained authentication and native transport tests still run,
and the new bootstrap regression exercises the original availability failure.

Live catalog diagnostics establish metadata and the original discovery
failure, not paid model execution, billing, or native installer/update behavior.
Capacity policy must distinguish advertised working windows from independently
verified hard input/output limits; do not invent new backend guarantees.
