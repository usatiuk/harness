# Deferred work

This file records known repository-wide work that is intentionally outside the
current change. Keep entries concrete: state the limitation, consequence, reason
for deferral, and the condition that should reopen it. Package-local follow-up may
instead live in the owning execution plan or an issue.

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

## Native sandbox filesystem race

Harness currently validates built-in filesystem mutation paths before performing
the host operation. That validation and operation are not atomic if another
process replaces a validated path with a symlink. Moving those mutations fully
inside the Bubblewrap boundary would close the race. Native v1 explicitly does
not claim protection against it; see the execution-backend section of
`README.md`.

Reopen when native mutation containment becomes the active execution milestone
or before making stronger sandbox-isolation claims. The owning roadmap is
`docs/subsystems/execution/PLAN.md`.

## Durable live-work recovery

Model streams, approvals, processes, activities, and subagent runtime handles are
process-local. Conversation items and completed usage survive restart; in-flight
work is reconciled to a legal failed/aborted history and does not resume. Building
durable leases, process adoption, or stream continuation now would add a scheduler
and recovery subsystem without a demonstrated workflow that needs it.

Reopen when a concrete long-running workflow must survive Harness process or
machine restart, with explicit ownership and external-resource recovery semantics.

## Provider-owned execution tools

Shipped providers support opt-in native web search. File, command, sandbox, approval, activity, and subagent
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
