# Deferred work

This file records known repository-wide work that is intentionally outside the
current change. Keep entries concrete: state the limitation, consequence, reason
for deferral, and the condition that should reopen it. Package-local follow-up may
instead live in the owning execution plan or an issue.

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

Shipped providers map model requests and outputs but do not contribute hidden
provider-executed tools. File, command, sandbox, approval, activity, and subagent
execution stays under Harness control. Supporting provider-owned execution would
otherwise create a second path for approval, project instructions, output,
cancellation, and transcript semantics.

Reopen only for a specific provider capability whose value justifies defining
honest authorization, observability, and continuation behavior outside the
Harness tool dispatcher.

## Stable database compatibility

Harness is pre-release and the SQLite store is disposable. Schema migrations may
clear conversation-scoped data when preserving an obsolete shape would add
compatibility machinery or weaken invariants. This keeps current development
simple but means the database is not yet a stable user-data format.

Reopen before a release promises conversation preservation across versions; from
that point, retain migration fixtures for every supported schema.
