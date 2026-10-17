# Desktop streaming performance

Status: Complete (local source/browser validation; native frame presentation unmeasured)

## Outcome and scope

Implement the approved desktop React refactor in the main checkout. Limit text
and reasoning presentation to one publication per 100 ms while preserving every
canonical event and prompt control/final-state publication. Keep unrelated
conversations, sidebar and app shell out of token-driven updates. Preserve
existing drafts, approvals, history, scroll and disclosure behavior.

Use the existing session, reducer, router and virtualizer. No new state library,
event framework, worker, Markdown parser, settings control or provider/server
streaming change. Component extraction must establish a real rendering boundary.
The concurrent ask_questions change owns question semantics and components; this
change owns desktop publication and integrates its minimal UI wiring by agreement.

## Grounding and design

See [research](../../research/2026-10-17-desktop-streaming-performance.md).
The session remains the single owner. Connection/global settings, sidebar and
individual conversation notifications have distinct consumers. Published
conversation snapshots retain immutable values/references; canonical reducer
state continues to advance in event order. One pending timer per conversation
publishes the latest state, with no raw-event queue or second reducer.

Only text/reasoning deltas use the 100 ms cap. Other semantic events publish
immediately including any preceding text. Disconnect flushes the latest state;
detach/removal cancels pending work. Stream-only updates must not escape the cap
through unrelated component renders. Derived transcript rows are built at
publication time and reuse unchanged row/group references. Keep whole-history
projection simple initially; do not build incremental indexes without evidence.

Memoized messages and work rows consume stable inputs. Composer/header controls
receive only their relevant fields. Expanded tool bodies own diff preparation;
existing Presence closing animation and activity polling lifetimes remain.

## Milestones and completion checks

- [x] 1. Scoped publication and lifecycle (no dependency).
      Add connection/sidebar/conversation subscriptions; stop forwarding content
      changes through the host manager. Add 100 ms latest-state publication with
      immutable cached snapshots and safe teardown. Verify bounded publications,
      complete final text, urgency, background isolation and snapshot stability.
- [x] 2. Transcript and rendering boundaries (depends on 1).
      Reuse unchanged rows/groups without mutating old snapshots; memoize message/work
      rendering, stabilize relevant props, isolate composer/header, and prepare diffs
      only while mounted. Verify row/step identity, timing, nested Eval, prepend,
      disclosure/polling lifetimes, drafts and stream completion.
- [x] 3. Evidence and handoff (depends on 1 and 2).
      Compare representative long-history/bursty-stream publication and render work
      before/after. Run focused unit/browser regressions and npm run check. Review
      independently for behavior, architecture/simplicity, and tests/scope; resolve
      material findings. Synchronize subsystem/testing docs and record actual
      limitations. Native runtime/frame presentation remains distinct from browser
      and operation-count evidence. The initial delivery did not authorize commits/pushes.

## Validation and evidence

Focused validation passes 37 tests across conversation publication, transcript,
real RPC session, host manager and manager lifetimes. Chromium performance checks
pass 3/3, covering rendering work, memoized disconnect guards and current-state
restart confirmation. Existing focused conversation regressions pass 23/24;
automatic history prepend drifts 12 px, identically reproduced using committed
HEAD desktop sources. The full sweep also exposes idle regrouping drift,
independently reproduced at 34 px using committed sources. No assertion or timeout was weakened. The coordinated
question chat separately verifies root/child question presentation.

[Research measurements](../../research/2026-10-17-desktop-streaming-performance.md)
record 500 → 1 projections per burst and 0 → 1,000 reused history row references.
These synthetic CPU/work measurements do not qualify native frame presentation.
The shared reducer still copies the cells array per delta and projection is
linear per publication; more complex indexing is not justified by this evidence.

Three independent read-only reviews covered behavior/lifetimes,
architecture/simplicity and tests/scope. Two findings were fixed: memoized
Rename/Fork subscribe to disconnect changes, and Restart reads current activity
state at click time rather than subscribing more broadly. Browser regressions
exercise both fixes. Review found no need for additional infrastructure.

Final combined `npm run check` passes typechecking, lint, formatting and 1,518
tests (41 gated skips; 162 test files passed, 10 skipped), including the coordinated
question change. The full Chromium sweep passes 87/89 cases: only the two
baseline-reproduced history-anchor cases fail (34 px idle regrouping, 12 px
automatic prepend). All new performance/control and root/child question cases
pass. These existing defects remain open outside the approved performance scope;
no new scroll behavior is claimed. Follow-up independent review confirms both
findings resolved and no remaining material issue. `git diff --check` passes.

No native runtime/frame presentation qualification or pushes were performed.
After validation, the user authorized committing this refactor together with the
coordinated async-questions change in the main checkout. Both changes share the
desktop session/snapshot integration and are recorded in one coherent commit.
