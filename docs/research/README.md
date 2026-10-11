# Research notes

Research notes preserve evidence, experiments, API findings, production-project
comparisons, alternatives, and unresolved questions. They inform implementation
and decisions but are not automatically current project truth.

Use a dated descriptive filename such as
`2026-08-02-provider-context-limits.md`. A useful note states:

- The question and why it matters.
- Versions, platforms, and assumptions.
- Primary sources or reproducible experiments.
- Findings, counterexamples, and uncertainty.
- Consequences for the current plan.
- Any resulting decision record.

Current exploration:

- [Auto-approval context and denials](2026-10-11-auto-approval-context.md):
  current request projection, missing instruction evidence, public reviewer
  comparisons, and diagnostics needed to classify reported excessive denials.

- [Headless tests and Windows console windows](2026-10-10-headless-testing.md):
  standard console suppression, inherited test-worker consoles, and the limits
  of hiding native GUI tests. Native tests remain visible and approved; Windows
  Sandbox is optional. No runner infrastructure is planned.

- [Product releases, installation, and updates](2026-10-10-release-installation-updates.md):
  repository packaging gaps, GitHub artifact hosting, on-demand shared Node,
  native bootstrap, Tauri activation, cross-version server management and safe
  cache retention. Delivery is tracked in the linked draft plan.

- [Remote hosts and background servers](2026-10-03-remote-hosts-and-background-servers.md):
  desktop/TUI host selection and connection editors, client/server configuration,
  shared background servers, WSL/SSH provisioning, and proposed lifecycle changes.
  Delivered with narrowed scope in [the completed plan](../plans/cross-cutting/2026-10-03-remote-hosts-background-servers.md).

When later evidence supersedes a note, retain the historical result and link to
the newer note or decision instead of silently rewriting the investigation.
