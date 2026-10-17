# Subagent communication through existing delivery

Research date: 2026-10-17. Source: the working tree before messaging implementation, including the
uncommitted subagent inspection feature. Repository investigation only; no external messaging
framework or dependency is needed. Delivery plan:
[subagent follow-up](../plans/interface/2026-10-17-subagent-inspection.md).

## Findings

- [Subagent tools](../../packages/subagents/src/tool.ts) currently provide spawn,
  not list/send. Durable spawn marks already contain the parent, name and slug.
  Scoped plugin-state queries already support bounded direct-child listing.
- [Tool profiles](../../packages/subagents/src/config.ts) constrain available
  tools. The built-in explore profile has an explicit allowlist, so adding tools
  globally alone would not let that profile communicate.
- [Delivery](../../packages/core/src/delivery.ts) uses one inbox for send, queue,
  steer and interrupt. [The engine](../../packages/core/src/engine.ts) starts an
  idle recipient's loop; steer joins running work at an after-tool-result
  boundary. Finished turns do not make conversations permanently unaddressable.
- [Activity consumption](../../packages/activities/src/consume.ts) already calls
  `ctx.deliver` on background completion. The engine stamps plugin provenance and
  uses steer. This can wake an idle subagent that owns an activity; peer messages
  need the same behavior, not another wake policy.
- `ctx.deliver` currently addresses only its calling conversation.
  [The runner](../../packages/protocol/src/runner.ts) exposes text delivery via
  [the service](../../packages/service/src/service.ts), which stamps user
  provenance. Cross-conversation plugin delivery therefore needs a narrow
  source-aware seam; forwarding through user delivery would mislabel the input.
- [Subagent activities](../../packages/subagents/src/activity.ts) settle on the
  first terminal child turn. [ActivityManager](../../packages/activities/src/manager.ts)
  intentionally never reuses settled handles. These describe submitted work,
  not a permanent ban on later conversation turns. Keep this distinction.
- Engine root membership is activation-local and currently registered at child
  creation. Explicitly delivering to a historical child must preserve its root
  ownership before loading; otherwise it could run outside ordinary tree teardown.
- [Inspection](../../packages/server/src/subagents.ts) currently exposes only a
  direct-parent breadcrumb and mixed child rows. Running counts reuse live and
  persisted turn state. The desktop refreshes from activity changes, which alone
  cannot represent every message-driven turn.
- Activity events already carry the owning conversation ID.
  [Transcript reduction](../../packages/client-features/src/transcript-reducer.ts)
  drops that field, explaining the missing ownership label. Keep the existing
  wire contract and preserve the field for presentation.

## Result

Use family-scoped `subagent_list` / `subagent_send`, existing plugin input and
ordinary wake-on-delivery for every permitted recipient. Activities keep their
existing work-handle semantics. No messaging framework, durable outbox or separate
agent lifecycle is justified by this request. These findings are the initial code research; implementation and final
qualification are recorded in the linked delivery plan.
