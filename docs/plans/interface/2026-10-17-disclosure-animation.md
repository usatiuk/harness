# Disclosure animation and bounded work groups

Status: Complete (local implementation and validation; native qualification remains unverified)

## Scope

Use one shared grid-height/opacity animation for sidebar groups and conversation
disclosures. Keep native details/summary interaction and reduced-motion support.
Persistent bodies preserve activity polling lifetimes; previously lazy bodies use
Radix Presence to remain mounted through the closing CSS animation. No JavaScript
height measurements or animation timers.

Earlier Work groups over three entries collapse completely. The latest group has
a five-entry/five-line peek, including after completion, and an outer disclosure
only above five entries. Peek and expanded rows share rendering; reasoning retains
its compact plain-text tail. Native named details enforce one open outer Work
and one open inner conversation disclosure. Only the outer Work container scrolls,
within a 40vh limit. Transparent soft shadows on that container and sidebar
navigation indicate content above/below without covering native sidebar material.

## Delivery

- [x] Add and adopt the shared animation/presence wrapper, preserving lifetimes.
- [x] Simplify thresholds, shared rows, exclusivity and outer-only scrolling.
- [x] Add shared scroll-shadow observation and top/middle/bottom/collapse coverage.
- [x] Finish full checks and independent review; record actual qualification.

## Evidence

Focused Chromium checks pass actual grid height/opacity closing animation,
reduced motion, inline/latest/earlier Work behavior, exclusivity and final 40vh
height. Both sidebar and Work scroll-shadow edge/collapse checks pass. A keyboard
test failure was traced to Virtuoso's hidden measurement copy: waiting for the
visible summary before Enter restores real focus/activation, independently
reproduced three times. No product keyboard workaround was added.

Native selectors were updated for the shared wrappers and inline groups. Native
Windows/macOS execution is not established here. WebKit initially lacked system libraries on this host. Later selection checks
used libraries extracted under the system temporary directory; these engine
checks do not qualify native translucency.

Existing local transcript-spacing/sidebar-contrast edits are preserved.

Final validation: `TMPDIR=/var/tmp npm run check` passes typechecking, lint,
formatting and 1,477 tests (41 gated skips). The final full Chromium run passes 72
of 73 cases; the remaining idle-history-anchor check fails with 34px drift. An
independent in-memory build of committed HEAD reproduces anchor drift twice
(60px), so this existing canvas issue remains outside the disclosure change.
The production history-loader anchor and child-parent anchor cases pass in the
final run. No anchor assertion was weakened and no canvas workaround was added.

Three independent review lenses covered behavior, simplicity/lifetimes and
validation/scope. Findings resolved: visible keyboard prerequisites, final rather
than intermediate animation height, stale native disclosure selectors/completion
waits, collapsed-content visibility, and current contract documentation. Native
Playwright discovery succeeds (28 tests); this is compilation/discovery evidence,
not Windows execution. Changes remain uncommitted and unpushed.

Work shadow layering correction: code blocks covered the original background
shadow. A pointer-transparent overlay on the Work frame now paints the same
shadow above the scroll content. Five focused Chromium cases pass, including a
pixel comparison over opaque tool output with/without the overlay. The existing
edge-state and outer-only scrolling checks remain intact. The full local check
passes again after this correction (1,477 tests, 41 gated skips).

Work spacing trial: shared Work rows now use a faint left guide and small indent
below their heading, with 4px paragraph spacing. Compact thought tails collapse
blank lines; expanded Markdown keeps the original paragraphs. Four focused
Chromium cases pass, including bounded peeks, aligned thought/tool rows and
original paragraph preservation on expansion. Screenshot inspection confirms the
compact guide/spacing presentation.

Intermediate message actions: Copy/feedback now sit in a separate grid column to
the right of intermediate assistant text, removing the reserved action row. Final
assistant and user actions remain below. Phase labels take precedence; unphased
messages use existing turn/content order and active-turn state. Focused Chromium
checks pass wide/narrow positioning, hover/focus, Copy, phase classification and
feedback submission.

Selection policy: the desktop is nonselectable by default. Actual message bodies,
expanded thinking, code/output, errors and editable fields opt into native text
selection; action bars remain excluded inside selectable content. Static Worked
labels and history markers no longer select on double-click.

Selection paint regression: the issue is highlight spilling into empty rows and
outside the bubble, not selecting the sentence. Restoring the old selectable
transcript/action styles reproduces the stray blue row in GTK WebKit. The
nonselectable desktop default removes it; `overflow: clip` on the user-text
bubble also removes native selection paint extending past its right edge. Both
failures were observed before their fixes. No custom click/selection handler was
added.

The browser regression selects whole paragraphs and compares pixels in the empty
action row and beside the user bubble before/after selection. It also verifies
actual selected content and nonselectable Work/history labels. GTK WebKit checks
use an isolated X display and temporary dependency extraction, without installing
system packages or editing user configuration; this does not qualify the native
Harness runtime itself.

User-bubble highlight height: only an inline span opts into selection; the padded
bubble remains nonselectable. This keeps selection out of its bottom padding,
while the existing clip still prevents horizontal spill (removing it fails the
side-paint regression). Pixel comparisons cover padding, blank action rows and
outside edges while preserving selected paragraph content. Six Chromium and five
GTK WebKit cases pass, including action placement and native document/draft
selection. No custom selection handlers are used.

Final follow-ups restore a plain Working row before the first agent output and
put a compact Stop icon beside each activity's running label. Activity disclosures
use a shared native name for exclusive expansion. Browser regressions cover the
initial waiting indicator, cancellation before output, exclusive expansion,
stopping a collapsed activity without toggling it, polling lifetime and disconnect.
All four affected browser cases pass. The final full check passes typecheck,
lint and formatting, with 1,476 tests passing and one real-Docker glob test
timing out; all 11 tests in that Docker suite pass when run alone. The cause of
the full-run timeout remains unestablished; no timeouts or assertions were changed.
