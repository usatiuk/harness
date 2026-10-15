# Provider and MCP settings fixes

Status: Complete. Implemented and validated; commit, push and release authorized.

## Scope and design

- Add a LiteLLM setup form (stable ID, label, gateway URL, API key) in desktop
  Settings. Persist through the existing server settings and credential boundaries;
  validate using the contributed provider schema. Existing restart lifecycle applies.
  No new provider registry, preference store or generic schema-form framework.
- Selected text needs a distinct highlight from user-message bubbles. Fix shared
  theme styling and verify user-message selection in the browser; native Windows
  rendering remains separately qualified.
- MCP uses a compact server list and selected-server editor. Endpoint/local command
  and auth basics come first. Advanced sections contain headers/environment sources,
  secret references, OAuth client metadata/scopes and permission overrides. Bearer
  tokens use a password field bound to the existing secret reference; OAuth needs
  no unrelated credential-slot fields. Preserve existing expert configurations.
- Keep Test, Sign in and Restart feedback explicit. Preserve safe classified failure
  context (stage/HTTP status/process code), never remote bodies, tokens or raw URLs.
  No automatic retries, polling, hot catalog replacement or GitLab-specific auth code.
- Gemini gateway issue is resolved upstream (LiteLLM PR #38284 merged). User
  explicitly declined a Harness compatibility workaround; upgrading the gateway
  is the resolution. No provider output transformation or new compatibility flag.

## Milestones

- [x] Provider setup RPC/form: schema validation, global persistence, credential
      isolation, duplicate rejection, restart feedback, real RPC/browser tests.
- [x] Selection styling: visible highlight on user bubbles in both themes.
- [x] MCP diagnostics/editor: preserve expert config, basic bearer/OAuth setup,
      safe failure classification, explicit restart flow, fixture/browser tests.
- [x] Gemini: identify merged upstream fix; omit local workaround per user direction.
- [x] Owning docs, focused tests/browser checks, `npm run check`, three independent
      read-only correctness/architecture/simplicity/evidence reviews.

## Evidence

Current GUI lists configured provider instances but has no creation RPC/form.
Selection uses `--surface-subtle`, identical to user bubbles. MCP drops classified
errors to a generic unavailable message; OAuth stores tokens but does not replace
the startup catalog. User reports DCR succeeds for both GitLab and Atlassian,
GitLab then appears unavailable. Exact enterprise failure remains unobserved.
Gemini is routed through LiteLLM; upstream issue BerriAI/litellm#38223 reports the
same `$ref`/`$defs` media-reference error. Do not infer a specific GitLab cause.

Validation so far: 29 focused real RPC/MCP/OAuth tests and six isolated browser
regressions pass. Reviews identified and fixed shared bearer/advanced credential
drafts and stale recovered HTTP challenge diagnostics. Added mixed-credential
regression; separate tool-discovery-stage coverage also passes. Full check, documentation and final reassessment are complete. Native Windows selection and the
actual enterprise GitLab deployment remain unqualified.

A temporary Gemini gateway experiment was removed when the user declined a local
workaround. It did not establish a vendor reproduction: the container could not
reach its controlled upstream. No workaround, new provider option or test relying
on that experiment remains. Existing LiteLLM fixtures/config are unchanged.

## Final evidence and limits

- `npm run check`: typecheck, lint and formatting pass; 1,376 tests pass and 38 skip.
- 29 focused server/MCP/OAuth tests and six affected browser tests pass. The three
  MCP browser cases pass again under actual Settings grid rules after compacting
  action rows and applying the shared checkbox styling. Screenshot inspected.
- Three independent read-only reviews covered correctness, boundary/simplicity and
  tests/scope. Identified credential-draft sharing and stale challenge diagnostics
  were fixed and rechecked; no blockers remain.
- Provider setup tests use temporary homes and memory credentials with inherited
  vendor API-key environment variables cleared. No real dev profile was altered.
- Native Windows rendering and actual enterprise GitLab connectivity are not
  established by these fixtures. This delivers useful GitLab failure diagnostics,
  not a claim that an unobserved enterprise/server-side problem is repaired.
- No new provider form framework, registry, auth lifecycle, hot catalog refresh or
  Gemini workaround. Global settings and credentials retain their existing owners.
