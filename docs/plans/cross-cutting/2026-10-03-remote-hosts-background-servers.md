# Remote hosts and background servers

Date: 2026-10-03. Status: Complete. Scope corrected and delivered: 2026-10-04.

## Outcome and scope

Desktop and TUI connect to the same background server in each execution
environment/account: Local, a WSL distribution, or an SSH destination. Initially
show Local; a switcher selects one host while the others keep running. Keep
presentation independent of selection so a combined list can be added later.

Each account uses its normal Harness directory. Saved connections do not choose
alternative homes, profiles, Node executables, or installation directories.
HARNESS_HOME predates this change and remains an installation/test override;
it is not a connection-management feature. Do not change credential storage to
support multiple homes. client.json sits beside the controlling machine's
existing settings.json; server settings and credentials stay on the executing
host.

Connection forms contain a name, WSL distribution/optional user or SSH
destination, and managed/development runtime choice. SSH uses non-interactive
OpenSSH authentication; ports, keys and host verification belong in .ssh/config.
Development assumes Node on the target's PATH: build current local code, transfer
the built JavaScript and locked runtime metadata, and reuse target dependencies.
Managed provisioning supplies verified portable Node for Linux x64 glibc.
Stage complete builds and activate updates through explicit server restart.

Each saved connection owns its own observer and presentation. Two aliases can
observe the same server independently; they do not share client session ownership.
SQLite exclusion and authenticated discovery reuse the background owner.
Disconnect removes an observer, while accepted work and pending approvals remain
server-owned. Reconnect reads fresh state without replaying missed partial text
or resubmitting a mutation whose response was lost.

Keep both Local browser OAuth and device-code sign-in. WSL/SSH use device codes.
Do not forward browser callbacks. Use only the current protocol and disposable
database format; no compatibility adapters or migrations. Default desktop exit
keeps the owner alive, with an explicit stop action and remembered Local exit
preference. Tray, notifications and autostart are not required for this delivery.

## Milestones and completion checks

- [x] **Shared authority.** Server composition owns work and resources; clients
      observe/control it. Public RPC tests cover disconnected accepted/queued
      work, pending approvals, concurrent clients, explicit stop and drainage.
- [x] **Background server and adapters.** Authenticated discovery, singleton
      startup, disposable bridges and explicit stop. Real process tests cover
      startup races, authentication, bridge exit, reconnect and shutdown.
- [x] **Simple registry and provisioning.** Local-first client.json and WSL/SSH
      routes, built-bundle deployment, dependency reuse, managed Node and explicit
      update/restart. Representative real WSL and SSH flows pass after removing
      the home/path controls.
- [x] **Desktop/TUI host interaction.** Equivalent editors, selection, server
      controls, host-scoped conversation state and selected-host settings/auth.
      Local and real WSL native/rendered-TUI flows verify conversation selection,
      host switching, client exit and fresh attachment to the same owner.
      A pending turn completes after a decision from the reattached client.
- [x] **Final validation and handoff.** Full local checks, affected native/remote
      checks, documentation and independent correctness/simplicity review pass.
      Coherent implementation and scope-cleanup increments are committed.
      Earlier unreproduced validation observations remain recorded below.

## Evidence

- Scope cleanup is committed as 3f042d7. Additive device sign-in alongside browser
  OAuth is 2f31ca0. Earlier increments implement shared authority, discovery, deployment,
  client interaction and current-format cleanup. The branch was rebased on
  latest primary branch main, 0282afc, after both user rebase requests.
- Before scope cleanup, npm run check passed 112 files / 975 tests, with 35
  existing opt-in/platform skips. Four real WSL/SSH cases passed: provisioning,
  cached source-only updates, bridge failure/reconnect, and non-interactive SSH
  authentication/host-key rejection.
- Fourteen native desktop cases passed, including both Local OAuth choices,
  device-code cancel/retry and DPAPI storage. Four native connection cases
  covered editing, shared exit policy, native owner capture and actual WSL
  cancellation. After fixing bridge backpressure, five affected native cases
  passed (51.3 seconds).
- Public RPC and rendered TUI sign-in tests substitute provider HTTP while
  preserving the real auth/store/client boundaries. Browser regressions remain.
  Live vendor-account authorization is credential-dependent and is not required
  to establish these client/server contracts.
- A real authenticated paused receiver reproduced bridge EOF starvation under
  backpressure. Bounded input consumption and transport discard fixed it;
  independent review reran the original reproduction successfully. Accepted
  server work survives transport disposal.

## Scope reflection and correction

The implementation promoted exploratory recommendations into requirements:
configurable homes became profiles, alias detection became shared client
ownership, and a broad failure/credential matrix became a completion gate.
Tests then reinforced those additions, including redirecting Local to a second
home. Correctness reviews checked the expanded design without challenging why
those product features existed. The result was a chain of work supporting
assumptions the user had never requested.

The user's correction rejects that expansion. Removed the uncommitted
credential-per-home changes, saved home/runtime-path controls, extra client-home
setting, home-aware presentation and alias-sharing bookkeeping. Existing server
identity still scopes presentation so changing targets cannot restore another
server's view, and metadata edits preserve drafts. Test isolation
belongs at the OS/process edge, not in user-facing configuration. Preserve the
requested lifecycle and connection behavior; evaluate further work against the
scope above before adding code or a new gate.

Scope cleanup passes typecheck, lint, formatting and the full Vitest suite
(112 files / 976 tests, 35 existing skips),
four real WSL/SSH cases and four rebuilt native desktop connection cases
(39.0 seconds), including actual WSL cancellation. Existing meaningful
regressions stay; profile-specific assertions and speculative completion
requirements are removed. Final real WSL interaction qualifies desktop and TUI:
remote turns and approvals survive host switching and client exit, fresh
attachment keeps the same server, and the turn completes after approval. Five
native connection tests passed in 1.1 minutes; five actual WSL/SSH/TUI cases
passed in 48.9 seconds. The final refreshed remote run also passes all five cases
(48.5 seconds), including the TUI's canonical turn completion and owner cleanup.
Final npm run check passes typecheck, lint, formatting and 112 files / 976 tests,
with 36 platform/opt-in skips. Temporary diagnostic logging is removed. Three
independent reviewers inspected behavior, lifecycle and qualification/simplicity;
their actionable findings are resolved. The ship-change skill now requires scope
reflection and the requested two-work/one-cleanup commit cadence.

## Unresolved validation observations

An earlier full run returned generic RPC internal errors in the first background
process scenario and the TUI same-owner/draft scenario. The original exceptions
were not retained. Focused reruns passed all ten tests, and three later full suites
passed all 976 tests. Fixture failures now include the startup log before cleanup.
Independent review found no reproducible ownership race. The cause remains open;
these passing runs do not establish a fix. An unchanged QuickJS limits test also
hit its default test timeout once during a parallel full run and passed later;
no timeout or assertion was weakened.

A separate final run was blocked before test execution by Vite's Windows path
initialization spawning a subprocess (EPERM). Retrying outside the sandbox passed
the full check. This explains that runner failure, not the earlier RPC errors.
