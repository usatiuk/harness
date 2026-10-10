# Headless tests and Windows console windows

Investigated on 2026-10-10 against Windows 11 Home, managed Node 22.23.3,
Vitest 4.1.8, Playwright 1.63.0 and the repository's Tauri/WebView2 suite.
Three independent read-only audits covered process launches, Windows native
E2E behavior and cross-platform facilities. No GUI was launched during research.

## Accepted scope

Use standard process flags to suppress incidental terminal windows. Keep CLI,
server and browser renderer tests suitable for routine background execution.
Native GUI tests remain visible tests requiring approval for each local run.
Windows Sandbox is optional when the host supports it; otherwise accept the
visible app and focus changes during an approved run. The user explicitly
rejected adding isolated CI/VM infrastructure for this work.

## Process launches

[Node's child-process API](https://nodejs.org/docs/latest-v22.x/api/child_process.html)
provides `windowsHide`; Rust's
[Windows CommandExt](https://doc.rust-lang.org/std/os/windows/process/trait.CommandExt.html)
provides `creation_flags`, including `CREATE_NO_WINDOW`. These suppress console
windows without redirecting output away from the owning test process.

The audit found missing hiding flags in the desktop build's PowerShell wrapper,
Docker/devcontainer execution and Docker tests, SSH qualification tooling,
release Git probes and the native launcher's build-time Git probe. These launches
now request hiding. The browser opener also hides its intermediary shell while
still intentionally opening the browser for an actual sign-in.

The development bootstrap already uses `windowsHide` with inherited stdio.
Keep that inheritance: interactive CLI use needs its terminal, and preserving
the existing console relationship lets npm/test descendants reuse a hidden
automation console. The pinned
[Node/libuv implementation](https://github.com/nodejs/node/blob/v22.23.3/deps/uv/src/win/process.c)
uses `SW_HIDE` and only applies `CREATE_NO_WINDOW` when no stdio entry inherits a
file descriptor. Blindly applying `CREATE_NO_WINDOW` to the managed npm process
would remove the inherited console and could make an unhidden descendant create
another one.

Installed Vitest and Playwright workers, and npm's lifecycle shell, do not all
set `windowsHide` themselves. Missing flags therefore demonstrate launch-policy
gaps, not proof that each process displayed a window: console inheritance matters.
The observed terminal window's owner was not captured, so an end-to-end no-flash
claim remains unverified. No dependency monkeypatch, global preload, custom test
controller or test-pool migration was added on that inference.

The full repository check pipeline subsequently passed under managed Node:
typecheck, lint, formatting and 1,074 tests, with 36 skipped. The command was
started with PowerShell's standard `Start-Process -WindowStyle Hidden`, preserving
console inheritance and redirecting output to ignored validation logs. Its first
execution-sandbox attempt failed on Vite temporary-file renames before tests;
the unchanged pipeline passed outside that sandbox. No native GUI test ran, and
this check did not instrument transient window visibility.

## Native E2E is deliberately visible

The browser renderer configuration already sets `headless: true`. It tests
production React controls with controlled state; it does not qualify the native
application or window manager.

The native fixture spawns the actual Tauri executable and attaches through
[WebView2 CDP](https://playwright.dev/docs/webview2). Production appearance setup
then shows the window. Native design tests use foreground activation, real pointer
input, Windows system-menu gestures and full-window screen captures. Playwright's
browser headless option cannot hide that separately launched app.

An inactive Windows desktop cannot preserve this suite unchanged:
[SetCursorPos requires the input desktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setcursorpos),
and [SwitchDesktop makes a desktop visible](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-switchdesktop).
No custom desktop switching or product-level hidden test mode is warranted.

[Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/)
can isolate an approved GUI run when available, but is unsupported on Windows
Home and has a visible viewer. It is an optional testing environment, not a
requirement or a promise of headless native testing. Preparing and qualifying an
actual Sandbox run remains unverified here.

For future platform work,
[Tauri's Linux CI guide uses a virtual X server](https://v2.tauri.app/develop/tests/webdriver/ci/),
while [macOS native UI tests need a graphical session](https://developer.apple.com/library/archive/documentation/DeveloperTools/Conceptual/testing_with_xcode/chapters/08-automation.html).
Neither establishes that the
current Windows CDP suite supports those targets. No cross-platform test-driver
migration is part of this console-window fix.
