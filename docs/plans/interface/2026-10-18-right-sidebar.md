# Desktop right sidebar

Status: Complete

## Scope and design

Implement the approved right sidebar with Changes and Subagents tabs and an
icon-only sidebar toggle. Changes has a changed-file folder tree with matching
folder/file rows and chevrons, above one continuous all-file diff in a narrow panel and to its right
in a wide panel. Clicking a file jumps to its section. Subagents shows a connected tree rooted at the main parent and
the selected live, read-only transcript, without duplicate identity headings.
There are no new open-on-right/open-in-main actions, editors, Git write actions,
or base-branch configuration.

Comparisons are Uncommitted (including untracked), Unstaged (including untracked),
Staged, Against the repository default branch, and Unpushed against upstream.
Branch/upstream comparisons include committed changes only, from their merge
base. Resolve the remote default HEAD, falling back to existing main/master;
show the actual reference and explain unavailable comparisons. No implicit fetch.

Git reads run on the selected server against the main conversation's current
checkout, through worktrees-owned typed plugin requests. Separate file listing
from bounded per-file diffs. Reuse the existing client attachment, transcript,
history paging and subagent ancestry APIs. Keep presentation state in the desktop;
do not add another conversation runtime, store, watcher service or package.

## Milestones and completion checks

- [x] Git reads and public contract: implement bounded cancellable comparisons,
      file listing and per-file diff in worktrees; wire server requests and client
      methods. Real Git and RPC tests establish modes, untracked/binary files,
      missing refs, current worktree selection and unsafe-path rejection.
- [x] Desktop integration (depends on contract): add sidebar/tabs, file tree and
      diff, rooted subagent tree and reused side transcript. Browser checks cover
      tree ancestry, side selection/live content, no composer/Fork actions,
      independent scroll, responsive file placement and icon toggling.
- [x] Validation and handoff (depends on both): run focused checks, full
      `npm run check`, independent reviews and affected browser checks; update
      subsystem architecture, roadmap, PLAN and testing guidance with evidence.

## Evidence and limits

Initial inspection: desktop already caches live ConversationViews and attaches
through the public client. TranscriptCell depends on route loader data for Fork
visibility; remove that implicit dependency for side rendering. The current
subagent control lists children of the selected conversation and groups roots
into Running/Finished; replace its presentation with one stable family hierarchy.
Worktrees already owns server-side Git and plugin client contracts.

Implementation and validation complete:

- `npm run check`: typecheck, lint and formatting pass; Vitest reports 1,678
  passed, 45 skipped and one failure in the existing
  `packages/server/src/worktrees.test.ts` eligibility precondition. An invalid,
  protected `/tmp/.git` causes repository discovery to fail before that test's
  feature assertions. The same original test fails against a HEAD source archive,
  within the sandbox. Final unrestricted validation below supersedes that result.
  The new Changes RPC regression passes
  independently, including current-worktree selection after switching.
- Focused real Git/RPC checks pass all nine cases, including index-removed
  symlinks, Git CRLF conversion, literal patch names, missing tracking refs,
  non-origin remote HEAD, preview byte/line limits and atomic-save recovery.
- Seven focused Chromium cases pass: family-root/live read-only side transcript,
  narrow/wide icon toggling, continuous diff and file jumps, slow reads surviving
  list polls, tab-position retention, automatic second-page loading, and compact
  existing title geometry. Screenshots were inspected after actual transcript
  visibility, rather than only DOM attachment.
- The broader Chromium run passes 113 cases and fails three existing checks:
  automatic history prepend drifts 12px (reproduced against HEAD); an elapsed-time
  assertion observes 13s instead of 12s; and a native-scrollbar test times out
  waiting for its animation-start promise. The latter two both pass a separate
  focused rerun. Their intermittent broad-run causes remain unproven; assertions
  and timeouts were preserved. The focused pagination case was added after this
  broader run and passes independently.
- `npm run build --workspace @harness/desktop` passes. The generated public
  protocol schema includes both Changes requests. `git diff --check` passes.
- Three independent read-only review lenses cover Git correctness/boundaries,
  UI lifetime/architecture, and scope/tests/documentation. Findings corrected:
  rename source paths, conflict/index-removal deduplication, literal filenames,
  line-ending and symlink semantics, slow-read starvation, and classified
  atomic-save recovery. No required sidebar behavior remains open.

The Git file-list buffer is capped at 4 MiB; file previews at 512 KiB / 10,000
lines. Large/binary/unavailable states are explicit. This is a read-only viewer,
not an editor or Git write workflow. Native desktop and actual SSH/WSL execution
were not exercised; remote behavior is established at the shared RPC/ownership
boundary, not claimed as platform qualification. Initial implementation did not
commit, push or deploy; commit/push was authorized at final handoff. The pre-existing untracked `tmp/` directory was preserved.

## Viewer follow-up

Requested scope: compact connected file-tree branches below folder chevrons;
per-file green addition/red deletion counts; comparison selector at the top of
the file tree; automatic unified/split diff layout based on the diff pane width;
and a non-selectable main-conversation root in Subagents.

- [x] Add bounded Git line-count metadata to the existing listing contract,
      preserving rename/binary/untracked/index-removal semantics.
- [x] Render aligned old/new lines from the existing patch, switch layout with a
      diff-pane ResizeObserver, and retain continuous scrolling/file jumps.
- [x] Tighten the tree, move the selector, and make the subagent root static.
- [x] Verify Git/parser/browser behavior, review proportionally, synchronize
      contracts/docs, and run `npm run check` with known limitations reported.

Initial implementation choice (superseded by CodeView below): use `react-diff-view` 3.3.3 for patch parsing, line numbers
and unified/split rendering, retaining existing Virtuoso file virtualization.
Remove the superseded custom parser/renderer. Native disclosure elements and
Lucide remain sufficient for the read-only folder/conversation trees; introducing
an editable or drag-and-drop tree framework would add unused ownership.
Library references: https://github.com/otakustay/react-diff-view and
https://diffs.com/docs (evaluated alternative).

Follow-up verification:

- All 12 focused real Git/RPC cases pass, including line counts for native,
  renamed, empty, binary, untracked and literal-name files. Binary reconciliation
  returns unavailable counts and previews instead of zero counts or temporary
  paths. Synthetic and reconciled patch headers quote literal paths.
- All 10 focused Chromium cases pass: the sidebar cases plus literal-name/EOF
  rendering, existing tool-preview mounting/dark colors and streaming performance.
  Unified/split tests assert old/new line numbers and paired multiline replacements
  after resizing only the diff pane. The comparison remains inside the tree;
  root-label selection is absent. Split-layout screenshots were inspected.
- Desktop production build passes. Generated worktrees v4 schema and documentation
  include nullable addition/deletion counts. Three review lenses were resolved;
  the subsequent library-integration review verified alignment, CSS isolation,
  EOF visibility and literal filename handling with no remaining findings.

- Final `npm run check`: typecheck, lint and formatting pass; Vitest reports
  1,681 passed, 45 skipped and the same previously reproduced environment failure
  in `packages/server/src/worktrees.test.ts` caused by protected invalid `/tmp/.git`.
  No assertion, timeout or product discovery behavior was changed for that failure.
  `git diff --check` passes. Native and real SSH/WSL qualification remain unchanged.

Width/guide follow-up: remove the fixed 900px/65% sidebar ceiling. Bound resizing
by the measured conversation layout, reserving 320px for the main conversation
and reconciling on layout changes. Folder guides extend through the full children
container with no horizontal branches or last-child truncation.

Six focused Chromium cases and the desktop production build pass for this follow-up.
The new resize scenario exceeds 1,400px, preserves 320px for the main conversation,
then shrinks the window and verifies the limit reconciles. It also checks full-height
vertical guides and the absence of horizontal branches; its screenshot was inspected.

## Loading and transcript follow-up

Requested scope: preload diffs ahead and behind scrolling; resize the file-tree
height when stacked above the diff; hide raw arguments/output for successful custom
edit previews; show feedback only on assistant text without action spacing in tools
or thinking; remove the obsolete structured editor tool throughout maintained code.

- [x] Replace file-level virtualization with CodeView anchoring; keep comparison-owned
      patches and bounded fetching of rendered files and neighbors in both directions.
- [x] Add pointer/keyboard tree height and width resizing, retaining dimensions across
      comparisons and layout changes.
- [x] Keep successful custom previews concise, preserve failure/generic details, and
      remove tool/thinking feedback rows while retaining assistant action placement.
- [x] Remove obsolete tool-specific handling and migrate provider fixtures while
      preserving boundary assertions.
- [x] Run focused Git/UI/provider checks, full validation and three independent
      reviews; record actual results and qualification limits below.

### Diff navigation research and selection

User reported unstable file jumps and requested delegated research before choosing
an implementation. Three read-only research passes considered the current viewer,
existing library capabilities and simpler alternatives. An 800px render buffer does
not establish navigation stability; the initial follow-up preload regression
failed its offscreen-position expectation. Prefetch alone did not solve the jump.

Options: retain the existing stack with comparison-owned patches and explicit
anchoring; use a dedicated multi-file line virtualizer such as `@pierre/diffs`
CodeView; or use ordinary DOM, whose aggregate rendering cost requires evidence.
Published CodeView 1.5.2 has item-ID navigation, versioned item updates and scroll
anchoring, but requires application-owned initial fetching. Delayed preceding-file
updates and responsive reflow were qualified before adoption. Performance claims
require independent measurements; Codex behavior is not a performance endorsement.

The initial follow-up failures were investigated before changes: prefetch did not
solve delayed-height navigation; the resize test assumed the old stacked-only
layout; the tool-tail identity test marked a transient Virtuoso measurement probe.
The current test waits for the actual visible summary before marking its DOM node,
retaining its identity assertion (three isolated passes).

Selection/copy uses native browser selection. Split selection excludes the opposite
column from the side where dragging begins; inline selection includes selected
visible old/new lines. Gutters are excluded. Two-line native mouse selection and
real clipboard reads pass in both modes. Continuous selection across virtualized
scrolling remains unqualified; no custom selection engine was added.

Performance research caveat: CodeView has no general disable-highlighting option;
`lang: "text"` and `lineDiffType: "none"` skip syntax/intra-line work, but its cold
path still initializes Shiki/themes. Workers require explicit integration and
assets. No comparative speed improvement has been measured or claimed.

The approved CodeView trial became the retained implementation after the checks
below. It replaces file-level Virtuoso/react-diff-view with one multi-file CodeView,
keeping Git ownership/RPC unchanged. Patches outlive virtual rows, bounded reads
prioritize selected files, and comparison polling/cancellation remain unchanged.
Combined patches retain raw output and unavailable states remain explicit.

### Final CodeView evidence

CodeView 1.5.2 replaces the superseded renderer. Comparison-owned requests/cache
survive virtual unmounts; at most four requests run concurrently, clicked files
have priority, and polling retains the existing cancellation/error behavior.
Sticky scope/file headers share one 45px metric derived from the measured 32px
control plus 12px padding and 1px border. Default viewer padding/gaps are zero;
the divider hit area overlaps its seam without consuming layout space.

All 18 focused Chromium cases pass, including delayed 8,000-line preceding-file
updates without losing the target, sticky headers, responsive reflow, revisiting
cached files, native copy in both modes, tree resizing, pagination, successful
preview details, assistant-only feedback and streaming isolation. The delayed
large-file scenario keeps fewer than 1,000 rendered code rows. No comparative
startup/scrolling speed improvement is claimed. The production build passes,
with a main chunk about 489 KiB gzip; CodeView still initializes Shiki/themes.

Focused migrated provider/tool/execution checks pass all 74 cases. Three independent
read-only reviews resolved retry-error clearing, obsolete dependencies/comments,
and the tool-tail measurement prerequisite. Full validation reports 1,680 passed,
45 skipped and the same independently reproduced `/tmp/.git` environment failure
above; typecheck, lint and formatting pass. Paid provider calls, native desktop,
real SSH/WSL and cross-scroll text selection remain unqualified.

## Production cleanup and file controls

Requested scope: animate file-tree folders, allow individual diff files to collapse,
show status/addition/deletion metadata in file headers, truncate tree filenames to
one line while retaining their existing full-path hover, and remove obsolete
sidebar implementation/fixture leftovers.

- [x] Reuse CollapsibleDetails for folder bodies and existing reduced-motion styling.
- [x] Use CodeView collapsed items with version changes, retaining sticky headers,
      state through polling, and reopening files selected from the tree. Animate
      chevrons; body-height animation is intentionally excluded because CodeView
      immediately reconciles virtual heights and removes collapsed code.
- [x] Share file status/count presentation between headers and tree rows; use current
      list metadata and preserve unavailable counts. Apply single-line truncation.
- [x] Remove unused subagent-control CSS and unused diff-completion fixture state;
      correct large-file fixture counts. No old viewer dependency remains.
- [x] Verify folder animation/reduced motion, file collapse/keyboard/tree navigation,
      raw combined patches and list removal, then rerun focused/full checks and build.
- [x] Finish independent review and record final evidence.

Final production follow-up: all 22 focused Chromium cases pass, including the new
normal/reduced-motion folder cases, independent file collapse and keyboard/tree
reopening, polling retention, header metadata, raw combined output and unavailable
counts after file-list replacement. The updated screenshot was inspected. Three
read-only reviews of the final implementation found no outstanding issues.
Desktop production build and `git diff --check` pass. `npm run check` passes
TypeScript, ESLint and formatting, with 1,680 Vitest cases passed, 45 skipped and
the same previously reproduced `/tmp` Git-discovery failure. No assertion or timeout
was relaxed and no external state was changed. Native/platform qualifications and
cross-scroll selection limits remain as recorded above.

## Persistent diff display preferences

Requested scope: persistent word wrap/line number settings in a diff right-click
menu and one shared custom context-menu primitive. Reuse installed Radix and
existing themed menu styles; retain current enabled defaults. Preferences remain
local to this desktop client, alongside appearance/composer preferences.

- [x] Add shared ContextMenu root/trigger and themed content/checkbox controls.
- [x] Validate/save diff preferences and map them to CodeView overflow/line-number
      options without changing Git reads or comparison state.
- [x] Verify actual wrapping/gutter changes, menu keyboard behavior, persistence,
      existing navigation/copy behavior and full local checks.

Related refinements requested during validation: restore the horizontal scrollbar
when wrapping is off; keep `@@` metadata readable with one visible label; shrink
rename and place it immediately after the title; prevent worktree icon shrinking.
The prior zero scrollbar-gutter override affected horizontal height as well as
spacing. Wrapped mode retains zero; scroll mode uses 8px with a visible thumb.
Metadata uses native rows and paint-only CSS. Wrapped labels span the diff;
unwrapped split panes retain independent scrolling and the label spans the left
pane. A true cross-pane unwrapped header is unsupported by CodeView's public
separator API and would require a larger renderer change, so none was introduced.
Rename is 20px with a 13px icon; the worktree icon is fixed at 12px and only its label
shrinks. Existing coarse-pointer rename visibility is preserved.

Validation investigation: the preference test initially accessed the fixture
before app initialization, then incorrectly expected the whole number gutter to
hide. It now waits for the visible sidebar toggle and checks the actual number
text; CodeView intentionally retains a narrow spacer. Radix typeahead focuses
on a queued task, so the test waits for focus before Enter. Hunk width assertions
compare against the scrollport client width, excluding the split border. Product
behavior, assertions and timeouts were not relaxed to bypass these prerequisites.

Native-bar qualification: ordinary headless Playwright passes `--hide-scrollbars`,
so a computed 8px pseudo-element alone cannot prove painting. The settings
regression now launches a browser without that argument and requires positive
allocated scrollbar height, an opaque thumb and actual horizontal scrolling. The
screenshot shows the thumb. Exploratory axis/width CSS changes were removed after
identifying that test-environment cause. The retained 8px bar fits CodeView's
existing 8px bottom spacing rather than increasing virtual file height. The hunk
matrix also waits for the sidebar's measured resize limit after viewport changes
before dragging; the split assertion remains intact.

Final settings/header verification: all 26 focused Chromium cases pass in one run,
including the native-scrollbar-enabled settings case and the complete hunk layout
matrix. Four preference unit cases pass. Typecheck, ESLint and formatting pass;
the full check reports 1,681 passed, 45 skipped and the same previously reproduced
`/tmp` Git-discovery failure. Focused lint was rerun after test qualification edits.
The production build and `git diff --check` pass. Three read-only review lenses
found no outstanding product defects; native desktop/SSH/WSL qualifications and
cross-scroll selection remain unchanged. This was the sandboxed validation result;
final unrestricted qualification follows.

## Final commit qualification

The user authorized final cleanup, commit and push. A fresh unrestricted
`npm run check` passes all phases with **1,686 passed and 41 skipped**. The sandbox
shows a read-only mode0555 `/tmp/.git` marker; unrestricted `stat /tmp/.git` reports
that it does not exist. That sandbox-only marker caused Git discovery to probe
`/tmp` as a repository. The earlier direct `git -C /tmp rev-parse` failure outside
the sandbox was expected for a non-repository and did not establish a failing
unrestricted test. No Git behavior or test expectation was changed.

The 26 focused Chromium cases and production build remain passing; native-bar
qualification and all platform/selection limits above remain explicit. Delivery
is split into server/public Changes support and desktop integration/presentation
cleanup commits. The pre-existing untracked `tmp/` file remains excluded.
