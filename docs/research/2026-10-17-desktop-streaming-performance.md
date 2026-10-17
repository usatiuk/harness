# Desktop streaming update investigation

## Source baseline

Inspected main checkout at d0bb433 on October 17, 2026. The worktree was clean.

- DesktopSession reduces each domain event, rebuilds DesktopTranscript, then
  calls one global changed(). Layout, ConversationPage and Settings subscribe to
  that revision. DesktopHosts forwards the same updates to the top-level app.
- appendDelta copies the cells array while preserving unchanged cell objects.
  DesktopTranscript discards all row objects and reconstructs groups over the
  loaded history after every changed cells array. ConversationPage scans cells
  again to classify intermediate assistant messages.
- Virtuoso bounds mounted transcript rows. It does not bound reducer/projection
  work over loaded history or prevent fresh row/callback props from reaching
  mounted messages. Message and work components are not memoized.
- ToolCall prepares editPresentation, maps all diff lines, and serializes arguments
  before its lazy disclosure decides whether to mount its body.
- Composer eagerly evaluates its localStorage draft read on every render.

These are demonstrated code paths, not a measured explanation of actual native
scrolling latency. The earlier [Linux frame-pacing investigation](2026-10-12-linux-frame-pacing.md)
did not establish React as the cause or graphics flags as a fix.

## Design evidence

[React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)
requires cached immutable snapshots, and compares snapshots by Object.is.
A mutable view plus a revision passed through memoized components is insufficient:
old props would refer to newly mutated data. Publish stable immutable presentation
values while retaining live record ownership for attachment/history/actions.

[React memo](https://react.dev/reference/react/memo) compares props shallowly;
unchanged cell/row references are therefore useful existing inputs. Keep component
identity stable and avoid custom deep comparators over conversation history.

[React useDeferredValue](https://react.dev/reference/react/useDeferredValue)
is not a fixed publication-rate limiter. Use an explicit 100 ms desktop
publication interval, as approved; do not alter provider delivery or accounting.

## Measurements on October 17, 2026

Linux, Node 24.21.0, committed baseline d0bb433. An isolated temporary TypeScript
probe seeded 1,000 immutable assistant cells and applied 500 text deltas through
the same shared reducer. Baseline used committed DesktopTranscript after each
delta; new code used ConversationView.publish(true), awaited its publication,
and counted/timed projection separately from ingestion. No server/profile data.

| Work                                         |         Baseline |      Refactor |
| -------------------------------------------- | ---------------: | ------------: |
| Transcript projections per 500-delta burst   |              500 |             1 |
| Unchanged history row references retained    |        0 / 1,000 | 1,000 / 1,000 |
| Ingestion plus projection CPU, three samples | 104.10–122.64 ms |  0.98–1.61 ms |

New samples spent 0.55–0.89 ms ingesting and 0.43–0.72 ms projecting. Timings
exclude the intentional publication wait and are descriptive microbenchmarks,
not native latency/frame-rate promises. The deterministic unit regression uses
2,000 mixed text/reasoning deltas over one simulated second and verifies exactly
10 notifications/projections with complete final content. Each individual shared
reducer delta still copies the cells array; projection remains linear per
publication. No incremental history indexes were added.

The production-route Chromium regression seeds 1,000 history messages, a stable
visible message and a closed 5,000-line write diff, then delivers 500 deltas.
Test-only bundler counters verify no Composer, ConversationHeading, Layout or
ToolBody execution during that burst, at most two TranscriptCell executions
(including virtualizer measurement), and at most two projection calls. Opening
the diff mounts its body; finishing publishes trailing text and preserves the
draft. Other cases verify memoized Rename/Fork disconnect guards and restart's
current-work check. The fake session edge does not prove production subscription
isolation; a real service/RPC regression independently verifies that boundary.

The final full browser run passed 87/89 cases, including all three new
performance/control regressions. A focused existing browser run passed 23/24 cases; the automatic history-prepend
anchor drifted 12 px against a 1.5 px assertion. A temporary Vite loader replayed
committed HEAD routes/session/transcript/subagent controls/composer fixture without
changing checkout sources. The exact case also drifted 12 px there. The full sweep additionally exposed the
idle-regrouping anchor case; a second committed-source baseline reproduced 34 px
drift. These existing anchor defects are not fixed or hidden by this change;
assertions are unchanged. The temporary baseline spec in the checkout was removed;
the later standalone baseline lives only under the system temporary directory.

Native runtime/frame presentation has not been measured by these checks. The
previous Linux frame-pacing investigation remains valid; this work does not change
graphics preferences or claim to resolve its undiagnosed native scrolling cause.
