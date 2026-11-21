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

## Milestone 1: native sandbox migration

The [MXC migration plan](../../plans/execution/2026-11-21-mxc-native-sandbox.md)
replaces the handwritten Linux launcher with one native backend across Linux,
macOS, and Windows. It owns delivery of the structured-file containment fix
and removal of the superseded host-side mutation check.

## Deliberately deferred

- Provider-owned execution tools.
- LSP/edit diagnostics until selected over MCP callable tools as the next vertical
  plugin.
- Additional execution substrates without a concrete product workflow.
- Parsing arbitrary shell commands to infer exact file targets or permissions.
- Durable background processes across Harness restarts.
- A policy language beyond existing tool rules and request middleware.
