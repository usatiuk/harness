# Deferred work

This file records known repository-wide work that is intentionally outside the
current change. Keep entries concrete: state the limitation, consequence, reason
for deferral, and the condition that should reopen it. Package-local follow-up may
instead live in the owning execution plan or an issue.

## Restore a child's recorded parent on direct attachment

After a server restart, attaching to a child before its parent can treat the
child as a runtime root. This was reproduced with a child created via
`createConversation({ parentId })` without a subagent spawn mark: the stored
parent was correct, but RPC attachment used subagent metadata to find the root.
No stored parent changed.

- [ ] Restore attachment ancestry from the conversation records’ `parentId`
      links. Verify with a fresh service over the same store: attach the child
      first and assert the attached root is the original parent. Preserve
      subagent inspection and read-only rules; no reparenting API is needed.

## Workspace output directory races

The host-side output store rejects existing links below the selected workspace
and creates log files exclusively. Its path-based checks do not pin directory
handles against concurrent directory replacement by another process. Treat
artifact placement in a concurrently hostile checkout as unqualified until
the substrate can enforce containment throughout creation on all supported hosts.

## Unresolved Windows CLI mapped-image sharing violation

During 0.9.3 source CI `39477863987`, the unchanged
`replacement_protects_a_running_previous_image_until_it_exits` native test fails
its first replacement with Windows error32 at `native/launcher/src/update.rs:140`.
The child has printed/flushed its application-readiness sentinel; the saved
error does not identify the failing filesystem operation. Native updater source
and invocation are unchanged by this tool/desktop patch and prior CI passes.
One unchanged debug rerun passes the exact test (Windows job `118825952927`).
That establishes non-reproduction, not a root cause or fix.

Consequence: the mapped-image CLI update path has an unexplained sharing-violation
observation; do not assume it is test-only or add retry/wait workarounds. Raw
failure and passing evidence are retained under `.harness/desktop-20261020/`;
the [delivery plan](plans/interface/2026-10-20-provider-tools-and-desktop-corrections.md)
records both outcomes. This unrelated native diagnostic remains open rather than
expanding the scoped TS/CSS patch without evidence. Reopen on the next Windows
CLI-update qualification or any recurrence, capturing operation/path/error context
or a Windows filesystem trace before changing replacement semantics or assertions.

## Upstream Rust glib iterator advisory in the Linux desktop stack

GitHub reports [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)
(medium) for unsound `Iterator`/`DoubleEndedIterator` implementations on
`glib::VariantStrIter`. The desktop Cargo lock retains `glib` 0.18.5, exactly as
in published 0.8.1; the advisory lists 0.20.0 as fixed. This is the Rust GTK
dependency, not the GNU libc target distinction.

Consequence: Linux desktop releases retain the upstream advisory; this entry
does not claim a Harness exploit or prove absence of risk. The ARM64/desktop
follow-up does not change that dependency. Reopen with a compatible Tauri/GTK
dependency-stack upgrade and native desktop qualification, rather than forcing
an incompatible transitive major version into this scoped release.

## Desktop updates after backend startup failure

Desktop updates currently live in Settings, which is unavailable when initial
backend startup fails. The broken v0.1.2 packaged build therefore needs a manual
v0.1.3 installer download. The user explicitly deferred changing this startup flow
on October 11. Reopen when adding recovery actions to the startup-error screen;
offer the existing native updater without requiring a connected server.

## Alternate home and natural-home project discovery

With `HARNESS_HOME` pointing elsewhere, a workspace below the user's normal home
can treat `~/.harness` as a project marker. Global-only fields such as `auth` then
fail project validation. Code-mode native qualification reproduced this with an
unmarked temporary project; an explicit project marker isolates the fixture.
`findProjectRoot` currently compares the configured home with `defaultHome()`,
which resolves to that same configured path under the environment override.

Reopen with configuration-discovery work: keep the natural user home separate
from the configured home and regression-test temporary/alternate profiles.
This existing settings issue is outside the evaluator change.

## Durable live-work recovery

Model streams, approvals, processes, activities, and subagent runtime handles are
process-local. Conversation items and completed usage survive restart; in-flight
work is reconciled to a legal failed/aborted history and does not resume. Building
durable leases, process adoption, or stream continuation now would add a scheduler
and recovery subsystem without a demonstrated workflow that needs it.

Reopen when a concrete long-running workflow must survive Harness process or
machine restart, with explicit ownership and external-resource recovery semantics.

## Provider-owned execution tools

Shipped direct providers support configurable native web search, enabled by default.
File, command, sandbox, approval, activity, and subagent
execution stays under Harness control. Supporting provider-owned execution would
otherwise create a second path for approval, project instructions, output,
cancellation, and transcript semantics.

Reopen only for a specific provider capability whose value justifies defining
honest authorization, observability, and continuation behavior outside the
Harness tool dispatcher.

The [search and assistant-phase delivery](plans/models/2026-10-10-native-search-and-assistant-phases.md)
records that scoped exception: provider-specific enablement, display-only hints
and finalized native context in provider metadata. Hosted-search resumption and
other provider-owned execution remain outside scope.

## Stable database compatibility

The earlier pre-release decision selected one current protocol and disposable
historical database formats. The current SQLite v6 initializer includes explicit
additive upgrades from v3/v4/v5; unsupported formats fail with compatible-upgrade
guidance without changing the database. Broad historical adapters and an older-
protocol compatibility layer remain outside scope.

The [draft release plan](plans/cross-cutting/2026-10-10-release-installation-updates.md)
defines preservation beginning with the first public baseline; private/pre-release
compatibility stays outside scope. Concrete forward migrations and private backups
are required when a later public release changes a format, rather than as a
historical migration project before the initial release. Public-baseline handling
remains an open delivery task, not an implemented compatibility promise.

## Project discovery with a custom Harness home

With `HARNESS_HOME` pointing elsewhere, an unmarked workspace below the real user
home can mistake that user's `.harness/` directory for a project marker. Project
validation then rejects global-only settings such as `auth`, preventing conversation
creation. An isolated server regression reproduced this before reaching its
settings mutation; the lifecycle test is projectless. Reopen when refining workspace
discovery or supporting custom-profile workspaces beneath the user home; project
discovery must exclude the actual user settings directory as well as the selected
profile. This follow-up changes approval settings, not project-root discovery.

## Zod dependency refresh

Keep the lockfile on Zod 4.4.3 until the MCP wire preprocessing schema works with
newer pipe semantics. Zod 4.6.5 continues through `unrecognized_keys` issues and
allows invalid MCP settings past client validation; the existing RPC regression
correctly fails. Retain that assertion when revisiting the upgrade. See the
[Node 24 refresh evidence](plans/cross-cutting/2026-10-11-node24-dependencies.md).
