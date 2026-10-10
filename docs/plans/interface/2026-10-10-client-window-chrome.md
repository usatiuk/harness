# Client window chrome and Terminal brand

Status: Complete

## Outcome

Replace the separate native title-bar surface with one shared application header
so modal dimming includes the header, sidebar and main panel. Restore the original
Lucide Terminal mark. Preserve the accepted layout, Mica/AppKit material, opaque
fallback and single System/Light/Dark preference from the
[native-material baseline](2026-10-10-native-window-material.md).

Use the pinned `tauri-plugin-decoration` 3.0.5 for platform controls and native
Windows Snap hit testing. Tauri remains responsible for window commands, dragging
and resizing. Avoid custom Win32 frame ownership and fake activation. Start with
native decorations enabled and the window hidden; install custom decoration once
the shared header mounts, after applying the stored theme, then show it. Unexpected
initialization failures retain the existing fatal native-dialog/close path.

The shared header belongs above the route/session lifetime so navigation and live
theme changes cannot remount drafts or scroll state. Only inert title-bar areas
are draggable. Reuse flat platform controls; no new settings, header toolbar,
material options, animations or server behavior. Native macOS traffic lights stay
native and need a narrow dimming integration if the plugin does not supply it.
Linux retains the existing native frame; adopting the library's best-effort,
Wayland-only controls is outside this focused delivery.

## Execution

- [x] Confirm the pinned plugin's actual control, drag, modal layering, theme and
      fullscreen contracts; compile against Tauri 2.12.1.
- [x] Add one shared header and decoration startup. Remove duplicate sidebar
      branding, restore Terminal artwork and synchronize app-icon assets.
      Verify ordinary routes and startup/error screens share the same shell.
- [x] Preserve modal dimming and native window behavior. Exercise real Windows
      drag/double-click, resize/maximize/Snap/system-menu/close, explicit themes,
      popup layering and retained draft/navigation state. Keep library-owned
      platform mechanics; document remaining native-platform coverage precisely.
- [x] Pass root checks, frontend build and focused browser tests. Complete three
      independent reviews including simplicity; fix confirmed findings.
- [x] Rebuild and run visible native qualification at the end. Inspect complete
      light/dark/modal window screenshots and update README, PLAN, interface and
      testing evidence with actual results.

Dependencies are sequential except independent checks and reviews. The title-bar
behavior checks are part of the requested outcome, not optional polishing.

## Grounding and evidence

- [Tauri title-bar APIs](https://v2.tauri.app/learn/window-customization/) provide
  basic client decoration and native macOS overlay/traffic lights.
- [Plugin integration](https://github.com/oovz/tauri-plugin-decoration/blob/main/docs/integration.md)
  publishes control clearances and z-index without owning the application's
  header or route layout. Native Snap geometry must match the finished app.
- The original sidebar Terminal mark was removed in `4374ea6`. The blue H app
  icon predates that removal; use the library artwork rather than a new drawn logo.
- The plugin and application compile against the existing Tauri 2.12.1/Rust
  dependency stack. The shared shell mounts above `Desktop`; both startup/error
  and connected routes render within it. Generated PNG/ICO/ICNS reuse Lucide's
  Terminal artwork and the existing app-icon background.
- The native adapter keeps material installation and macOS opacity calls in one module.
  Only macOS observes modal portals; unchanged opacity never crosses IPC.
  Library clearances/z-index and the shared scrim height live at the document root
  so body portals and injected controls inherit them. Native Linux frames remain
  supported without adopting the plugin's best-effort Wayland-only backend.
- WebView2's native `app-region: drag` supplies the real Windows system menu;
  a physical right-click opens it without a DOM context-menu event. The redundant
  application menu command, capability and direct Win32 dependency were removed.
- macOS/Linux packaging remains unqualified locally, as before; compilation or
  Windows tests do not establish it.

## Final validation

- Final root checks pass typecheck, lint, formatting and 1,039 tests (36 skipped;
  test duration 54.04s), including two native-opacity reconciliation regressions.
  All ten headless Edge cases pass (9.9s). Production frontend, packaged server
  and locked native Windows builds pass; Rust check and formatting pass.
- Three independent reviews resolved nested-modal double dimming, initial macOS
  opacity after reload, concurrent native-opacity writes, and test label/readiness
  assumptions. Focused follow-ups also resolved the Close-hover dark-media
  cascade and foreground readiness before test exposure cleanup. All three
  reviewers report no remaining material findings.
- All six final visible Windows cases pass on the rebuilt executable (1.2m).
  They cover native themes, modal dimming, keyboard preferences, focus, physical
  drag/edge resize, native system menu, double-click/maximize/restore, Snap hit
  testing, modal maximize/minimize/restore, retained draft/route, close,
  accessibility, startup/error recovery, page layouts and persisted accounting.
  Complete Light/Dark/modal screenshots show readable caption controls and one
  continuous dimmed application surface. The OS system menu is also captured.
- Foreground activation is test-owned: Windows can deny background activation
  despite a successful z-order call. The helper temporarily exposes only its
  captured application window, clicks an owned child/header, verifies actual
  foreground state, and restores z-order. No global focus policy or product
  activation fallback was introduced. Some earlier physical runs overlapped user
  desktop activity; one captured unrelated typing in the isolated test draft.
- At 200% CSS zoom, the header's intrinsic width overflowed the minimum viewport.
  Setting the shared shell/header's minimum width to zero and clipping the title
  fixes the original layout case, which now passes unchanged. Caption controls
  use 46px width instead of the plugin's oversized 58px default; the native probe
  at the displayed maximize button reports Windows `HTMAXBUTTON`.
- Full-window review exposed caption glyph colors following OS media instead of
  an explicit app theme. They now inherit the app's ink, with themed non-close
  hover tint and explicit native red/white Close hover. The passing regression
  exercises explicit themes while emulating the opposite OS color scheme.
- A later full-check run encountered an existing server crash-recovery DPAPI
  `EPERM` while replacing `.server/auth.dpapi`. This path is untouched by window
  work; the original focused crash-recovery case passed unchanged (5.9s), followed
  by another complete passing root check (1,039/36). No credential storage changes
  were made.
- Tauri's built-in WindowEffect API was verified against 2.12.1 source. Its
  wrapper discards native installation results; the direct `window-vibrancy` call
  uses the same transitive dependency and exposes the unsupported result needed
  for opaque fallback. It avoids new OS-version detection or native effect code.
- Native fullscreen transitions, actual OS accessibility/theme transitions,
  monitor moves and macOS/Linux packaging remain separate platform qualification.
  Future visible GUI test runs require the user's explicit approval for each run.
- The user requested validation only, followed by another approved GUI run. Its
  first invocation failed at CDP attachment in every case: a later development
  build had replaced the shared executable without `custom-protocol`. No design
  checks had started. Repackaging the server/frontend and rebuilding with the
  documented production test feature restored the expected application origin;
  all six unchanged GUI cases then passed (1.1m). Use the full native test script
  when a development build may have replaced the executable.
- Additional platform availability checks found Ubuntu WSL, but its current
  command environment provides neither Cargo/Node nor `pkg-config`; it is not a
  ready native desktop qualification environment. The configured macOS hostname
  did not resolve from this host. These probes do not qualify either platform,
  and no extra GUI runs or commits/pushes were performed.
- After the completed review loop and passing approved Windows GUI rerun, the
  user authorized committing this delivery and pushing directly to `main`.
