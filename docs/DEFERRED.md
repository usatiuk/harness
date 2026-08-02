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
