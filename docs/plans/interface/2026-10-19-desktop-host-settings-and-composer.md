# Desktop composer and host-local settings corrections

Date: 2026-10-19. Status: Complete — reviewed, validated and published in 0.9.2 on 2026-10-20.

## Requested outcomes

1. Accepted messages clear their captured composer draft without waiting for
   unrelated settings reads; rapid input cannot submit the same draft twice.
2. Composer grows/shrinks correctly in dev and the shipped Linux AppImage.
3. “Keep server running” belongs to the selected execution host's Harness config,
   shared by all clients of that config, with a UI to change the remote value.
   **User-selected default: always stop** when the last desktop exits, without
   stopping an owner another client still uses.
4. Settings edits the selected host's actual `$HARNESS_HOME/AGENTS.md`, normally
   `~/.harness/AGENTS.md`, rather than duplicating it in JSON settings.

The user explicitly requires subagent-driven planning/review, KISS/DRY/YAGNI,
non-leaky ownership, minimal new logic and established libraries over hand-rolled
infrastructure. Do not modify installed apps, running servers, credentials or
saved hosts during development. The user subsequently authorized a patch release
after implementation/validation; use the existing workflow-owned version bump.

## Design decisions and boundaries

### A. Send: remove unnecessary work

Root loader revalidation after every send/stop rereads provider credentials and
settings. The action has already accepted delivery and cleared captured storage,
but the controlled composer waits for fetcher idle. Session subscriptions own
canonical transcript state and accepted sidebar touch; those mutations do not
change settings.

- Add a root `shouldRevalidate` exception only for send/stop submitted to the
  actual `/actions` route. Delegate every other decision to the router default.
- Keep existing action/fetcher acknowledgement, error and captured draft handling.
  Do not clear optimistically from transcript arrival or introduce another
  acknowledgement channel, retry, durable operation ID or submission generation.
- Baseline proves two Enter events in one event turn can call delivery twice
  before React renders pending state. Use one component-local admission ref,
  acquired immediately before `send.submit` and released by that existing
  submission promise. Fetcher still owns visible pending/error state. No queue,
  manager or protocol change is required for this correction.

### B. Growth: one maintained sizing implementation

Use `react-textarea-autosize` for the composer on every engine. Remove native-only
`field-sizing: content`; do not retain two code paths or add feature flags.
Preserve controlled value, refs/focus, IME, paste/images and keyboard behavior.
Keep the existing **52px floor** and **clamp(52px, 30vh, 320px) ceiling in CSS**,
with internal scrolling at the cap. Other settings textareas need not autosize.

The library owns height measurement and window/font remeasurement. Do not rebuild
it with scrollHeight calculations, observers plus animation frames, synthetic
window events or approximate row-based viewport caps. Keep measurement caching
off. Its current implementation does not observe arbitrary element-width changes:
first test actual sidebar-only resizing; add only a demonstrated width invalidation
using an existing narrow size mechanism if the current render path is insufficient.
That correction must trigger library measurement, not calculate height itself.

### C. Host-local keep-running: existing settings and exit ownership

- Store global-only `desktop.keepServerRunning` in the execution host's
  `$HARNESS_HOME/settings.json`, default **false**. Exclude it from project,
  profile and conversation configuration. Expose `settings.keepServerRunning`
  through existing `app.settings.get/update` and the existing atomic writer.
- Show the checkbox in selected-host Settings: “Keep this server running after
  desktop exit.” Disconnected/unloaded hosts cannot display an invented value.
  Do not copy this flag into connection entries, native state or another cache.
- Enforce the current value at the server's existing conditional release boundary,
  sharing the decision between management and public release handlers. Read at
  release time; after the asynchronous read, atomically apply the existing
  only-release-client-remains check and mark stopping before scheduling shutdown.
  Two simultaneous explicit releases must not mistake each other for surviving
  consumers. Add an explicit relinquished bit to each existing bounded socket
  record (not a second collection). After valid release admission and a successful
  settings read, mark that requesting socket relinquished; false-default stop is
  allowed only when no nonrelinquished socket remains. Both release handlers share
  this operation. Invalid/stale requests or read failures never mark a socket.
  A caller removed while the settings read waits must not be reinserted into
  socket accounting. Release is an explicit surrender, using disposable controls; document that it
  is not a continuing observer connection. Ordinary socket close only removes
  its record and never triggers a deferred shutdown. A newly arrived client
  during the settings read must still prevent stop. No coordinator or retry loop.
- Extend **desktop exit**, including native updater exit, to remote owners too.
  Do not turn ordinary Disconnect, host switching/editing, reconnect, TUI detach,
  crash or network loss into exit. Explicit Stop/Restart and idle-gated upgrades
  remain independent of keep-running. Exit is not newly gated on idle work.
- Reuse native Bridge shutdown: drain **all** physical bridges first, then use
  the existing independent control helper for conditional release. Generalize
  the existing retained Local exit-owner obligation to authenticated owner/target
  obligations for Local/SSH/WSL. This preserves the current obligation across
  manual disconnect and covers nonselected/already-draining hosts on exit.
  Coalesce by canonical server identity, not saved connection labels. Retain
  only necessary control target/expected identity, never the preference.
- Reuse `runLocalBridge(onConnected)` with one explicit desktop bridge mode in
  the existing launcher whitelist/exact-arity validation and Node dispatch for
  desktop owner diagnostics across remote forwarding. Reuse the same launch
  implementation, not ambient environment flags or unsupported extra arguments. Capture identity from the same authenticated connection;
  ordinary CLI bridges must retain their existing stderr contract. Do not add a
  separate preflight connection or infer ownership from unauthenticated output.
- Remote exit control must inspect/attach only to the expected existing owner:
  never provision, start, reconnect to a successor or restart a missing owner.
  Preserve bounded control deadlines and current-instance validation. Existing
  `connectRemote(..., false)` already uses cached `--attach-only`, loading existing
  artifacts only and calling `attachLocalServer` rather than starting an owner.
  No new no-start mode is needed. Missing remote owner currently shares a generic
  command failure: keep it bounded/observable, never blanket-ignore exit code 1
  or match stderr to hide permission, corruption or packaged-program errors.
- Remove the obsolete client preference command, desktop footer checkbox and TUI
  client-preference writer. Accept/strip only the known legacy `client.json`
  desktop field when reading old files; keep other validation strict. Do not
  migrate one controller's old value into arbitrary hosts. Users opt in on each
  execution host; the new missing-value default is false everywhere.

The additional exit obligations are necessary control ownership for multiple
known hosts, not a second host registry or lifecycle coordinator. Prefer extending
existing records/control operations over adding parallel structures or managers.

### D. AGENTS.md editor: actual file, fixed resource

Add narrow `app.instructions.get/update` requests in the existing application API
registration. The server captures its own home and computes the fixed filename;
clients cannot supply a path or home. Keep guidance out of routine root settings
reads and avoid one update that partially writes two unrelated files.

Use fixed-path config helpers and reuse the existing atomic text replacement
internally; do not expose a general arbitrary-path filesystem RPC or introduce a
document store. The current replacement helper does not preserve an existing
file mode: extend that narrow internal write contract for guidance to retain the
existing permission mode and create a new guidance file privately (0600), rather
than weakening file privacy or introducing another atomic-write implementation. Existing application-operation tracking/write serialization owns
request lifetime. No new persistence library is needed where the existing atomic
writer already satisfies the contract.

- Read returns server-owned path and exact UTF-8 content; distinguish missing
  (`null`, displayed as an empty editor) from an existing empty file (`""`).
- Explicit Save writes the exact text, including whitespace/newlines. No autosave,
  preview, watcher, history store, localStorage copy, delete/reset or auto-reload.
- Missing files can be created. Existing symlink/nonregular targets reject with
  visible errors rather than following or replacing an ignored instruction target.
  Permission/write failures preserve the editable draft and original file.
- Reuse existing Settings, Textarea, Button and action feedback. Dirty edits must
  survive unrelated revalidation; switching hosts selects the corresponding file.
- Existing instruction snapshots do not change. State in the UI: **applies to new
  or reloaded conversations**. Do not promise the next prompt in an already
  prepared conversation uses edited guidance or force a runtime/server restart.
- Preserve existing guidance content semantics; do not silently trim, truncate or
  add a new runtime guidance size cap. Any editor-only limit needs an explicit
  separate decision rather than appearing as an implementation guard.

## Delivery milestones, dependencies and checks

### M1 — Evidence and reviewed plan (before production edits)

- [x] Independent send, packaging, host-lifetime and simplicity investigations.
- [x] Establish deterministic accepted-send/revalidation and duplicate baselines.
- [x] Authenticate/extract disposable published AppImage; read actual engine version.
- [x] Confirm default false and include host-local preference plus guidance editor.
- [x] Review unified plan with correctness, host-lifetime architecture and
      independent simplicity lenses. Incorporated concrete findings: shared
      explicit-release socket accounting, arrival recheck, preserved guidance-file
      modes, actual API-to-runtime guidance coverage, validated desktop bridge
      mode, and verified existing attach-only control. No new coordinator.

### M2 — Composer corrections (depends on M1)

- [x] Narrow revalidation filter and synchronous duplicate admission fix. Check
      accepted/rejected/unknown outcomes, edited text/images, independent Stop,
      same-turn duplicate events and settings mutations still revalidating.
- [x] Integrate the maintained autosizing component and remove old sizing path.
      Check growth/shrink, existing CSS caps at multiple viewport heights, capped
      internal scroll, wrapping after viewport/sidebar width changes, font-size
      changes, restored drafts and successful send clearing.
- [x] Exercise affected layout on isolated old bundled GTK engine as well as
      Chromium/current engine; never start the user's installed Harness app.

### M3 — Host configuration and real exit policy (depends on M1)

- [x] Global-only config/RPC field, strict contract/protocol version update and
      selected-host UI. Check absent=false, persisted true/false, unrelated settings
      preservation, two clients/aliases sharing a host and two homes isolated.
- [x] Remove/compatibly strip obsolete client preference and update CLI consumers.
      Check old registry loading and no copying into remote host configuration.
- [x] Generalize authenticated owner reporting and existing native exit/control
      path. Check Local plus selected/nonselected SSH/WSL targets, remembered and
      draining bridges, updater exit, duplicate aliases, stale/missing owners,
      no owner startup, explicit bridge-mode validation/normal CLI stderr, and
      physical close-before-release ordering.
- [x] Real server/control checks: false stops last owner, true preserves it,
      changed-at-release value takes effect without restart, another desktop/TUI
      prevents stop, simultaneous releasing clients do not keep each other alive,
      a client arriving during settings read prevents stop, explicit stop is
      unaffected, and ordinary detach never gains exit.

### M4 — Guidance editor (depends on M1; parallel with M2/M3)

- [x] Fixed-path API/helpers and explicit-save Settings editor. Check missing,
      empty, Unicode/CRLF/trailing newlines, read/write errors, symlink/nonregular
      targets, preserved existing mode/new-file 0600, atomic failure preserving
      the original and shutdown drainage.
- [x] Round-trip through real RPC in isolated homes; project AGENTS/settings.json
      remain untouched. Browser check selected-host routing, dirty draft/error
      preservation and saved-file reload. Existing service snapshot regression
      must edit through the new API and prove same-runtime guidance remains
      unchanged until runtime reload, then observes the exact saved text.

### M5 — Integrated verification and simplification (depends on M2–M4)

- [x] Independent correctness, architecture/simplicity and tests/evidence review;
      remove superseded logic and any abstractions not required by these outcomes.
- [x] Focused/full browser suite, Rust/native control checks, production frontend
      build, protocol schema no drift, format/lint/typecheck and full `npm run check`.
      Clearly distinguish simulated transport/source evidence from native/remote
      execution; leave required unverified integration open, not relabeled deferred.
- [x] Synchronize interface architecture, root/subsystem status and testing docs
      with actual behavior, default/migration and qualification limits.

## Evidence and current worktree

- All four production changes are integrated. `react-textarea-autosize` **8.5.9**
  supplies height measurement; a width-only observer addresses its demonstrated
  sidebar-only gap. Vite's standard module/browser conditions fix the proven
  CommonJS/ESM resolution error without aliases or library-specific build hacks.
  Npm installation reports zero audit findings.
- Accepted action clears stored draft but textarea stays nonempty behind a held
  settings read; two synchronous Enter events produce two identical deliveries.
  Baseline log: `.harness/26c6f184-e013-4809-ba3d-4b9ce52cd34c/outputs/act_82b84200.log`.
- Actual authenticated 0.9.0 AppImage WebKitGTK: **2.50.4**; system development
  engine: **2.52.6**. CSS survives minification unchanged. Older default-off
  field-sizing reproduces the missing growth (52px for empty, multiline and long
  drafts). The production-built corrected Composer now passes on both engines.
- Raw public artifact/probe evidence: `.harness/composer-20261019/`. Extracted
  bundle lives outside the checkout, recorded in `extracted-path.txt`. No installed
  app/profile, private guidance, credentials or user hosts were accessed.

References: [react-textarea-autosize](https://github.com/Andarist/react-textarea-autosize),
[WebKit field-sizing announcement](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/).

### Plan review evidence

`composer-send-fix` approves the final correctness plan after deterministic
concurrent-exit and arrival-during-settings-read checks were added.
`host-local-lifetime` validates the host/guidance architecture and existing
attach-only cached-runtime path, and recommends extending existing socket records
rather than adding a parallel collection. `simplicity-plan-review` approves the
minimal overall direction; its concrete file-mode, concurrent-release and
sidebar-width findings are incorporated above. Implementation must still prove
these outcomes; plan approval is not an implementation or test-completion claim.

The isolated system-engine CSS probe demonstrates 52px → 160px → 240px with
internal overflow → 52px after clearing on WebKitGTK 2.52.6. The first bundled-
engine probes initially failed before layout because bundled older GLib conflicts
with host PyGObject and bundled subprocess paths are relative to `usr/`; these
were diagnosed test-environment failures. Explicit host-GLib preload and the
correct extracted-bundle working directory permit the real 2.50.4 engine probe.
The actual production Composer passes growth/cap/rewrap/shrink/accepted-send on
both engines (`act_13c431e4`), without starting Harness itself.

### Integrated implementation evidence

- Backend config/API: **79 passed / 1 existing skip**, including two homes/clients,
  exact/missing/empty guidance, file modes, atomic failures, operation drainage
  and API-to-runtime snapshots (`host-settings-api` author, `act_89e26321`).
- Composer: **14/14** production Chromium regressions (`act_84fe0aac`), including
  root revalidation, same-turn duplicate, known/unknown failure and image/text
  draft ownership. The original CJS import failure was traced to nonstandard
  Vite conditions; no fixture timing workaround or library alias was added.
- Lifetime: **35 TS tests / 8 files**, **9 native desktop Rust** and **4 launcher**
  tests (`act_3d902848`); earlier broader run **49 / 9 files** includes all 14
  existing background-process cases. Raw control EOF now rejects promptly through
  existing connection disposal, preserving real NDJSON response-before-close.
- Parent full check: **2,134 passed / 46 skipped**, all type/lint/format stages
  (`act_4bd5964f`). Full Chromium **184/184**, retries disabled (`act_fe6ed2b4`).
  Final single-column form correction (352px half-width editor reproduced against
  796px panel) passes all **5** affected cases (`act_0d21c8a3`). Frozen final
  reruns also pass **2,134 / 46 skips** (`act_7657ff29`) and **184/184**
  (`act_c7e2c907`). Parent Rust formatting/full native workspace plus desktop
  lib/bin tests, production Vite build and schema regeneration/no-drift all pass
  (`act_88c25381`).
- Matching source payload rebuilt, actual isolated Docker/OpenSSH **3 passed /
  2 WSL-only skips** (`act_d2c4e50c`): keep=true, live observer protection,
  false-last-client shutdown and missing-owner control with no replacement
  discovery. Source-process stale/successor/no-database tests separately substitute
  only SSH execution; do not label that substitution as actual SSH evidence.
- `host-api-review` approves backend/UI after one concrete schema-registry omission
  was fixed; both new instructions methods now appear in generated protocol20.
  `full-simplicity-review` approves the complete existing/new boundaries without
  material findings; `delivery-evidence-review` independently verifies logs,
  tests, scope and qualification limits. No speculative features or unrelated
  refactoring were requested or added.
- Screenshots were visually inspected from the isolated source fixture, identifying
  and correcting the two-column editor layout. Temporary fixture server stopped.
  Native Windows/real WSL GUI specs are maintained but not executed locally;
  source Rust + real SSH and the GTK source Composer do not claim complete native
  GUI/updater qualification on every platform. These are explicit coverage limits,
  not claims that simulated transport or compilation proves native GUI behavior.

### M6 — Authorized patch delivery (depends on M5)

- [x] Commit coherent validated increments, push and require fresh source CI on
      Windows x64, Linux x64 and native ARM64.
- [x] Dispatch existing `release.yml` with `bump=patch`; let workflow bump/tag.
- [x] Require successful four-platform native builds and draft assembly/signature
      verification. Validate actual signed public metadata and expected24assets.
- [x] Publish via `gh` with notes explaining host-local false default/retired
      client preference and guidance snapshot semantics. Verify latest/public
      assets, synchronize generated version commit and record run/commit evidence.

### Hosted delivery progress

Source `6128244` passes Linux x64/native ARM source CI `39335374558`; Windows
exposes a new fixture error before any release-policy assertion: direct `mkdir`
can create an elevated runner directory owned by Administrators, so the existing
OS-user guard correctly rejects it (exit77). The fixture now uses the existing
`canonicalHome` initializer, which creates the private Windows ACL before
canonicalization. No production ownership guard, policy or assertion is weakened.

The user requested immediate release dispatch while source CI runs. Standard
patch workflow `39335781340` owns version/tag commit `1047499` (`v0.9.1`). Its
production sources remain identical to the validated implementation; the later
Windows correction changes only test setup/docs, not shipped code. Fresh source
CI with the fixture correction must pass before final delivery is declared done.

Fresh source CI `39336670070` passes all three platforms. Release `39335781340`
passes Windows, Linux x64 and macOS builds but fails native ARM64 qualification:
the unchanged real SIGKILL recovery test reports `read ECONNRESET`. A disappearing
listener can reset rather than refuse a connection; existing startup recovery
classified only refused/missing listeners. The production correction adds only
`ECONNRESET` to that existing classification, without new retry machinery,
timeouts, PID waits or changes to the crash test.

Deterministic socket-edge regressions fail both existing-discovery and readiness
recovery before the fix, while attach-only still passes (`act_6f3786d7`). After
the fix, all 34 focused connection/control/background tests pass
(`act_ae1e210a`), including the unchanged real crash, cancellation, authentication,
candidate retirement and non-contention failure cases. The full check passes
**2,137 / 46 skips**, including type/lint/format (`act_e8092957`). Browser/UI
sources are unchanged since the recorded 184/184 run.

The failed `v0.9.1` tag remains untouched and unpublished. Because this recovery
correction changes shipped code, delivery proceeds through the standard next
patch **0.9.2**, not a rewritten tag or custom release-resume mechanism. Final
three-lens independent review covers correctness/security boundaries,
architecture/simplicity, and test evidence/portability before dispatch.

Final correction review: `host-api-review`, `full-simplicity-review` and
`reset-evidence-review` independently approve with no blockers. The evidence
reviewer inspected the failing baseline and passing focused/full logs; reviewers
explicitly preserve the native Windows/ARM release-qualification gate. No
catch-boundary refactor or additional recovery abstraction was warranted.

Release `39382326003` generated `9ff5432` / `v0.9.2`; all four platform builds
and native ARM64 source/real-SSH qualification pass. Source CI `39382326844`
passes both Linux targets, but Windows rejects the new reset tests' unnecessary
`auth.store=file` setting before reaching assertions. The fixture correction
removes credential configuration entirely: unset backend uses the existing
in-memory read store, so these credential-free owner tests need no platform
branch or access to the user's DPAPI store. This is test-only; the shipped
production tree remains the `v0.9.2` tree. Publication still requires fresh
passing Windows/source CI and verified signed metadata.

`full-simplicity-review` approves the fixture simplification after tracing the
unset-backend read path; the earlier portability review missed the explicit
Unix-only selection. Full local revalidation again passes **2,137 / 46 skips**
(`act_1cedd9a7`). Release `39382326003` now succeeds, including signed desktop
artifact verification and draft assembly. The draft remains unpublished while
fresh source CI qualifies the corrected fixture.

### Completed publication — 2026-10-20

- [0.9.2](https://github.com/usatiuk/harness/releases/tag/v0.9.2) published as
  latest at **07:05:59 UTC**, confirmed non-draft/non-prerelease with **24 assets**.
- Recovery source `615d5c5`, workflow version/tag `9ff5432`, test-only fixture
  simplification `46748ee`. The latter changes no shipped production source.
  Unpublished `v0.9.1` is preserved unchanged.
- Fresh [source CI 39383715659](https://github.com/usatiuk/harness/actions/runs/39383715659)
  passes Windows x64, Linux x64 and native ARM64, including native Rust tests
  and ARM real-SSH qualification (`act_6dda5483`).
- [Release 39382326003](https://github.com/usatiuk/harness/actions/runs/39382326003)
  passes all four builds, native ARM64 source/SSH qualification, detached
  artifact-signature verification and draft assembly (`act_1e4fff14`).
- Downloaded actual signed metadata passes production `verifyRelease` /
  `verifyArtifactSignature`, exact-byte verification and tamper rejection.
  Manifest inventory/version/Node pin and four updater entries including
  `linux-aarch64` match 0.9.2. Unauthenticated public downloads after publication
  match the verified draft and pass the production verifier again.
- Notes explain false-default host-local policy, retired client preference,
  detach-only exclusions, exact host AGENTS.md and new/reloaded-runtime semantics.
  Existing pre-0.9.0 manual-install trust limitation remains explicit.
- Workflow-generated version commit was fast-forwarded locally. No installed
  app/server was restarted or altered; no saved remote host was touched.

Local artifacts are under `.harness/composer-20261019/release-092/`; release/CI
watch logs remain adjacent. Native GUI/installed updater qualification limits
recorded above remain limits, not failures hidden by source CI or packaging.
