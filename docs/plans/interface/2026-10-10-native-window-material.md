# Native window material

Status: Complete

## Outcome and decisions

Use a native backdrop through the title bar and sidebar while preserving the
accepted conversation layout, controls and existing System/Light/Dark preference.
Keep native decorations: the OS owns caption buttons, dragging, resizing,
maximize, system menus and accessibility behavior. No HTML title bar, new
appearance controls, animations, inset redesign or server changes.
The requested small follow-up rounds the main panel's top-left corner and moves
the existing 1px divider onto its left/top edges across all routes.

Windows uses Mica on supported Windows 11 versions. macOS uses AppKit's Sidebar
material with its normal native title bar. Other platforms and unsupported OS
versions retain solid themed surfaces. The OS owns material focus, transparency,
contrast and power-saving adaptations; do not recreate those policies in JS.

Tauri 2.12.1 already depends on window-vibrancy 0.8.1. Use that same library
directly to distinguish unsupported versions from application failures: Tauri's
effects setter discards the underlying material result. Transparent CSS is
enabled only after successful material installation. Unexpected failures remain
fatal. The main content and portals keep their existing opaque backgrounds.

The existing appearance preference also sets Tauri's native theme. The window
starts hidden and is shown after initial theme/material synchronization. Browser
fixtures remain solid and do not invoke native APIs. No second preference store.

Sources: [Tauri window configuration](https://v2.tauri.app/reference/config/),
[window-vibrancy](https://github.com/tauri-apps/window-vibrancy),
[Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica),
[AppKit materials](https://developer.apple.com/documentation/appkit/nsvisualeffectview).

## Execution

- [x] Ground the design in the pinned APIs and current shared appearance/layout.
- [x] Install the native material and expose its supported/solid result. Preserve
      native decorations; check Rust compilation and classified fallback.
- [x] Synchronize the existing preference and reveal the initialized window.
      Keep shared content opaque and expose the material only in the sidebar.
- [x] Validate focused browser/native appearance behavior, production build and
      root checks. Run visible native tests only after implementation/review.
- [x] Review behavior, boundaries and scope independently; synchronize README,
      interface architecture, PLAN and testing evidence; inspect final diff.

Dependencies are sequential except independent static checks and reviews.
Completion requires the implemented behavior and passing available Windows
qualification. macOS/Linux native packaging and display qualification remain the
existing platform coverage gap; this change does not expand packaging targets.

## Evidence

- Rust compilation passes with native decorations retained and only unsupported
  OS/version errors selecting solid CSS.
- Initial repository checks pass typecheck, lint, formatting and 1,037 tests
  (36 skipped); all ten headless browser regressions and production Vite build
  pass. Sandboxed test startup failed on temporary-file/profile permissions;
  checks passed when rerun outside the sandbox, without product/test changes.
- Three independent reviews found an opaque body covering the material, an
  unhandled hidden-window startup failure, and screenshot foreground readiness.
  Corrections expose the material through both document ancestors, report native
  appearance IPC failure before canonical close/shutdown, and verify the actual
  foreground window/frame before capture. No additional material policy or
  custom window-control machinery was added.
- Final repository check again passes 1,037 tests (36 skipped), typecheck, lint
  and formatting. All ten headless Edge regressions pass after the panel-border
  adjustment. Packaged server, production frontend and native Windows executable
  rebuild successfully. All five focused native design cases pass (53.2s),
  covering native theme/material/caption attributes, reopening, contrast/media,
  startup recovery, Settings/creation/popovers and persisted accounting.
- Full-window Light/Dark screenshots show continuous material through the native
  title bar/sidebar and the requested curved 1px main-panel divider. Independent
  follow-ups confirm the three findings are resolved.
- The user's Connections screenshot shows an active native title bar with the
  old CSS modal scrim darkening all client content. This is a backdrop mismatch,
  not native material loss. The user selected further CSD brainstorming rather
  than either suggested CSS backdrop adjustment; no popup styling was changed.

## Client-decoration follow-up

The user authorized a title bar included in the application surface so modal
dimming can cover it. The new implementation is tracked in the
[client-window-chrome plan](2026-10-10-client-window-chrome.md).
Retain the native OS backdrop and the coordinated System/Light/Dark preference.
Use one shared window shell across startup, errors and all routes; no new controls
or server semantics. Qualification must preserve dragging, double-click behavior,
resize, maximize/fullscreen, Windows Snap Layouts, system menus, scaling and close.

[Tauri's built-in title-bar APIs](https://v2.tauri.app/learn/window-customization/)
cover basic client decoration and a macOS overlay with native traffic lights.
[tauri-plugin-decoration](https://github.com/oovz/tauri-plugin-decoration) 3.0.5
was evaluated for Windows native Snap hit testing and embedded controls. It is a
small, recent project; its claims are not qualification of Harness. Its published
z-index/clearance contract permits application-owned modal layering, but macOS
traffic lights remain native views and need separate verification for dimming.
[Decorum](https://github.com/clearlysid/tauri-plugin-decorum) uses keyboard input
simulation for its Snap helper; this does not satisfy real maximize-hover behavior.
The follow-up selected and pinned the decoration library. Its shared shell uses
native drag regions for the real Windows system menu; no custom frame manager or
fake product activation was added.

The original `>_` brand was Lucide's `Terminal` icon beside Harness in the sidebar;
commit `4374ea6` removed it during the design refactor. The blue H app icon predates
that change. The follow-up restores Terminal in the shared header, removes the
duplicated sidebar brand and derives app/taskbar assets from the same artwork.
