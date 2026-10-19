# Execution and safety subsystem plan

## Objective

Keep one Harness-controlled execution path across tool dialects and substrates,
make authorization and confinement observable, and strengthen security claims
only with matching implementation evidence.

## Shell and startup environment follow-up

The [cross-cutting follow-up](../../plans/cross-cutting/2026-10-19-agent-desktop-and-shell-follow-up.md)
delivers supported Bash/zsh selection and target-owned startup environment,
preserving native confinement and shared-owner lifetime without login/interactive
startup on each command. Real Bash/zsh, Bubblewrap and cached-image Docker
regressions pass; remote/other-platform qualification limits are recorded there.
This does not close the mutation race below.

## Milestone 1: native mutation containment

- [ ] Move built-in write, edit, patch, and remove operations fully inside the
      Bubblewrap boundary.
- [ ] Ensure path resolution and mutation occur within one confined namespace so
      host symlink replacement cannot race the operation.
- [ ] Preserve workspace-write and approved-host-escape semantics without adding
      a second file-tool implementation.
- [ ] Add adversarial symlink/replacement integration coverage on supported Linux
      hosts.

### Acceptance

- Native mutation security no longer depends on a host-side check followed by a
  separate host operation.
- README isolation claims and `docs/DEFERRED.md` are updated from demonstrated
  behavior.

## Deliberately deferred

- Provider-owned execution tools.
- LSP/edit diagnostics until selected over MCP callable tools as the next vertical
  plugin.
- Additional execution substrates without a concrete product workflow.
- Parsing arbitrary shell commands to infer exact file targets or permissions.
- Durable background processes across Harness restarts.
- A policy language beyond existing tool rules and request middleware.
