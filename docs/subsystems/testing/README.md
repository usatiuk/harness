# Testing subsystem

## Status

Harness uses TypeScript static checks, ESLint, Prettier, Vitest, shared contract
suites, platform-gated integration tests, and opt-in live provider tests. CI runs
the complete `npm run check` workflow on Linux and Windows.

Tests are co-located with implementation under `packages/*/src`. Shared fakes and
behavioral contracts live in `@harness/testkit`; they are used when more than one
implementation must satisfy the same observable boundary.

Command syntax and general testing rules live in [../../TESTING.md](../../TESTING.md).

## Test boundaries

### Protocol and pure policy

Focused tests cover item/model/tool/config schemas, usage/cost calculations,
request mappings, compaction-window selection, estimates, parsers, and reducers.

### Store contracts

The same conversation/store behavior runs against in-memory and SQLite
implementations. SQLite-specific tests add migrations, transactions, constraints,
duplicate-tool-result rejection, reopen behavior, and crash-reconciliation
prerequisites.

### Engine and service

Deterministic providers/tools exercise complete turns, streaming, delivery
intents, cancellation, tool batching, middleware, approvals, context, compaction,
rewind, configuration changes, usage, failures, and events. These tests prefer
canonical items/status/events over private call-sequence assertions.

### Plugins and execution

Package tests cover configuration and public plugin behavior. Process tests use
real child processes with bounded gates/timeouts. Docker tests control lifecycle
edges; native Bubblewrap integration is capability/platform gated. Workspace,
approval, agents, activities, output, and subagents also have cross-package
integration scenarios where their middleware order matters.

The parallel stdio scenario runs a separate real server process with SQLite,
approval, activities, workspace, and local sandbox plugins. Docker ownership has
controlled lifetime regressions plus an opt-in live Compose test; the command
and capability requirements are in [../../TESTING.md](../../TESTING.md).

### Provider adapters

Request and stream adapters use representative native payloads and fake streams.
Opaque provider payload tests require byte-for-byte round-trip. Live provider
tests are skipped unless their credential environment variables are explicitly
present.

### TUI

Pure transcript reduction is tested separately from Ink rendering. Component and
application tests cover composer input, completion/history, commands, overlays,
approvals, session lifecycle, streaming/static scrollback, and verbose rendering.

### Desktop

The desktop session is regression-tested through the public in-process RPC and
real service, including failed replacement/attach recovery while another root
remains usable. Native Playwright tests launch the actual Windows Tauri app and
bundled server through WebView2 CDP. They exercise router actions, independent
turns/approvals/drafts, history/diffs/output, settings/auth restart, crash recovery,
database exclusion, and real process cleanup. They also suspend the server to
prove that forced shutdown exits unsuccessfully. Only the external model network
edge is substituted where command output needs deterministic control.
Auto-review E2E verifies global reviewer model/preset changes in an already-loaded
conversation, actual command output, disabling review, restart, and clearing the
reviewer. Public service/core/server regressions cover selective policy refresh,
pending activation, preserved model/backend selections, and settings IO drainage
before SQLite closes.

Commands, profile isolation, artifacts, and release qualification are described
in [../../TESTING.md](../../TESTING.md). Native tests are opt-in and separate from
the ordinary repository CI checks.

## Platform matrix

- **Windows:** PowerShell tool shape, process-tree termination, DPAPI, terminal
  behavior, Docker where available, and Windows path semantics.
- **Linux:** Bash tool shape, Bubblewrap/native sandbox behavior, process groups,
  Docker where available, and POSIX path semantics.
- **macOS:** Code paths use the POSIX local/backend shape, but CI/support evidence
  is not currently equivalent to Windows and Linux.
- **External capabilities:** live providers, Docker daemon/devcontainers, OS
  keyrings, and Bubblewrap namespaces are explicit skip/gate conditions rather
  than simulated support claims.

## Evidence principles

- Test observable completion and durable state at the highest practical boundary.
- Use fakes for providers, clocks, processes, credentials, or OS state only when
  deterministic control is required.
- Avoid fixed sleeps; use gates, events, fake clocks, or bounded polling.
- Preserve cancellation, partial failure, output ordering, and provider payloads
  when crossing abstractions.
- A fallback or retry test also proves classification and the resulting canonical
  state.
- Coverage count is supporting evidence, not a design goal.

## Known gaps

- No transient model-retry implementation or classification matrix exists yet.
- Native mutation does not yet have an adversarial atomic containment test because
  the operation still crosses the documented host validation/IO race.
- Provider live tests are opt-in and cannot gate normal CI.
- macOS execution, credentials, and terminal behavior lack the same CI evidence
  as Windows/Linux.
- There is no packaged-install or clean-machine CLI scenario.
- Desktop native/installer evidence currently targets Windows. macOS/Linux
  desktop packaging, a clean-machine install, and live external OAuth sign-in are
  not covered by the local native suite.

## Source map

- `packages/testkit`: shared fakes and contracts.
- Co-located `*.test.ts` / `*.test.tsx`: focused and integration regressions.
- `vitest.config.ts`, root TypeScript/ESLint/Prettier configuration: validation
  entrypoints.
- `.github/workflows`: CI execution matrix.
- `packages/desktop/tests/native`: actual native app fixtures and E2E tests.
