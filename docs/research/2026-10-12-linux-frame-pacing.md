# Linux WebKit frame-pacing investigation

## Question and baseline

The user reports that disabling `PreferPageRenderingUpdatesNear60FPS` in v0.1.11
has no noticeable effect after restarting the desktop. Released source is
`61bc28d`; release evidence is `8ca2f0c`. The checkout was clean before this
investigation. No production code, profile, credentials or OS settings were changed.

The startup helper sets and verifies the preference through WebKit's public API;
that establishes the configured value, not actual display cadence. The
[WebKit scheduler](https://raw.githubusercontent.com/WebKit/WebKit/webkitgtk-2.52.6/Source/WebCore/page/RenderingUpdateScheduler.cpp)
can fall back to a timer. Neither that source nor an old 60-FPS bug report proves
this user's current bottleneck.

## Experiments on October 12, 2026

Temporary Python/PyGObject probes used GTK 3.24.52 and WebKitGTK 2.52.6. Each used
an ephemeral WebContext and a new temporary HOME/config/cache/data directory.
They loaded only generated content or the existing desktop browser fixture,
built with Vite and served from a temporary localhost server. No real Harness
server, sign-in, keyring or developer profile was involved.

The display reported approximately 120 Hz (2560 × 1440). JavaScript sampled
requestAnimationFrame timestamps; these are callback intervals, **not actual
presentation times**. Continuous sampling also creates activity while nominally
idle. Samples discard their first second. Average rates are descriptive, not
proof of an effect from a single on/off run.

| Sample                              | Preference | Callback FPS | Median interval | 95th percentile |
| ----------------------------------- | ---------- | -----------: | --------------: | --------------: |
| Simple page animation               | enabled    |        118.1 |            8 ms |           10 ms |
| Simple page scripted scroll         | enabled    |        109.3 |            8 ms |           15 ms |
| Simple page animation               | disabled   |         99.6 |            9 ms |           16 ms |
| Simple page scripted scroll         | disabled   |        115.6 |            8 ms |           11 ms |
| Harness fixture, manual sample idle | disabled   |        110.9 |            8 ms |           16 ms |
| Harness fixture, manual scrolling   | disabled   |         98.6 |            9 ms |           17 ms |

The user manually scrolled the real ConversationCanvas/Markdown fixture and
confirmed it felt similarly sluggish to the app. That sample recorded 1,031
scroll events and 845 wheel events. Intervals above 1.5 × their phase's median
occurred in 382/1,443 scrolling callbacks and 201/2,702 idle callbacks.

The first probes inherited `GDK_BACKEND=x11` from the agent's environment. This
was discovered during trace inspection, so they must not be represented as
qualification of the real app's backend. A later minimal-environment comparison
explicitly selected X11 and Wayland. Both reached approximately 120 callbacks/sec
while idle and showed uneven scrolling intervals (83.1 and 75.2 callbacks/sec,
respectively). These short samples included scripted scrolling **and** incidental
manual wheel input (188 and 195 events); they do not establish a controlled
performance ranking or that Wayland is worse. Switching backend is not a
verified solution.

## Built-in tracing

WebKit supports marks/counters through
[Sysprof](https://webkitgtk.org/2025/11/26/webkitgtk-2.50.html). A ten-second fixture
capture used installed Sysprof 50 with `--use-trace-fd --gtk --no-perf
--no-sysprofd --no-debuginfod`; no privileged stack sampling was requested.

The capture contained WebKit UI/Web process marks. Most layout/paint marks were
short: PerformLayout p95 0.501 ms, RenderLayerTree p95 0.630 ms, RenderingUpdate
p95 1.933 ms. Occasional outliers included RenderingUpdate 68.256 ms and
StyleRecalc 73.522 ms. These are whole-capture statistics, include startup, and
can overlap; their totals must not be added as exclusive CPU time. Mouse-event
marks include asynchronous latency and are not CPU execution measurements.
Profiler overhead and mixed scripted/manual input prevent direct comparison of
its callback rate with the unprofiled manual run.

The capture succeeded despite missing optional `eglinfo`/`glxinfo` diagnostics.
It was exported with `sysprof-cat` for mark analysis. Raw captures contain process
and environment metadata: keep them local and inspect/sanitize before sharing.

Temporary evidence locations for this session:

- `/tmp/harness-webkit-frame-probe-te9yg7qf`: simple-page on/off samples.
- `/tmp/harness-webkit-manual-6hc45ryq`: user-controlled conversation sample.
- `/tmp/harness-webkit-sysprof-cm3gazid/webkit.syscap`: built-in WebKit trace.
- `/tmp/harness-webkit-backends-byipirzz`: explicit backend comparison.

## Conclusion and next boundary

A hard 60-FPS ceiling is not reproduced: the enabled-preference sample already
exceeds 60 callbacks/sec. The startup change remains an unproven experiment, not
a qualified scrolling fix. The isolated Harness renderer reproduces the user's
subjective problem, narrowing investigation away from credentials/server work,
but does not identify its cause.

Next useful work is a repeatable manual-scroll trace correlated with actual frame
presentation/input timestamps, separating steady scroll from startup and testing
comparable input on each backend. Do not stack graphics flags, change backend
requirements or blame React/virtualization based on these measurements alone.
Actual AppImage rendering and updater execution remain unqualified by this probe.

## Cleanup decision

The user authorized removing the workaround, committing and pushing the cleanup.
Remove the startup helper/FFI and its unit test, direct WebKit and pkg-config
dependencies, and the experiment's explicit 2.42 build/runtime requirement. Keep
Tauri's normal transitive dependencies and WebKit defaults. This withdraws an
unproven workaround; it does not claim to fix the remaining scrolling problem.

Cleanup validation: six native library/binary tests pass against the locked
offline dependency graph. The full repository check passes with 1,327 tests and
38 existing skips. No replacement rendering workaround or permanent tracing API
was added. Only the evidence is retained in the repository.

The removal is delivered in `10e5e84` and published in
[v0.1.12](https://github.com/usatiuk/harness/releases/tag/v0.1.12). Its release
workflow passes clean-install checks, Windows/Linux/macOS native builds and
artifact signature verification. The remaining frame-pacing question stays open.
