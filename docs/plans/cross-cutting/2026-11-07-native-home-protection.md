# Native Windows home protection

**Status: Complete**

## Goal

Remove PowerShell from directory protection on the Windows startup path. Keep
private creation, owner validation and rejection of untrusted write access. The
desktop preparation helper and the Node server must both use the native check.

## Baseline and design

The original Windows 11 investigation measured about 0.53 seconds per
PowerShell invocation from a native parent. Warm-cache `--prepare-runtime`
took 1.6–1.8 seconds with three protection subprocesses, and the background
server reached discovery in 1.1–1.4 seconds with two. Those measurements
precede this change. Desktop window and WebView initialization were not isolated.

Rust creates missing Windows directories with an inheritable private ACL and
checks the owner and DACL on a directory handle. The Node Windows path calls
the same Rust implementation through the existing native addon. macOS and
Linux already perform in-process file permission checks and keep those paths.

Always revalidate the directory. A pathname can be replaced and the current
owner can change permissions between calls. Both the existing Unix bootstrap
test and the background-server regression exercise permission changes after a
successful check. Existing launch orchestration and cache leases are outside
this change.

## Delivery

- [x] Replace both Windows PowerShell callers with one native implementation
      and keep protection scoped to startup and existing runtime directories.
- [x] Build the Windows addon, run the Rust empty-`PATH` regression, and compare
      headless server startup with the previous Windows protection path.
- [x] Record cross-platform verification and run the repository checks.
      Report unsupported or unavailable build and measurement environments
      separately from exercised behavior.

## Validation evidence

Windows x64 built the native addon and passed the Rust bootstrap and launcher
tests (14 passed, one ignored fixture). The directory test covers nested creation,
repeat protection, and rejection of an existing file with `PATH` empty.
A disposable Windows directory also verified rejection after granting an
untrusted write ACE, private ACL repair, and inheritance by a new child.
The Windows `npm run check` passed typecheck, lint, formatting, and 2,112
tests (102 skipped), including the server unsafe-home regression.

On Windows with Node 26.13.0, five warm samples per version measured spawn to
`discovery.json`. The two bundles used the same source and native addon except
for the restored pre-change TypeScript directory protection in the baseline.
The medians were 659 ms with PowerShell and 249 ms with the native call. Each
sample started a fresh server process and stopped it through local RPC. This
comparison isolates the Node path and does not time the desktop preparation
executable or the GUI.

The Windows native `--install-development-server` helper had a median of 1,321 ms
with the existing development launcher and 48 ms with the rebuilt launcher.
Both used the same already-warm cache, inert cached Node fixture and local
server archive. Five alternating samples per launcher measured spawn to exit.
The helper exercises the native cache preparation path without launching Node
or the desktop. The installed desktop's `--prepare-runtime` and GUI startup
were not benchmarked here.

The POSIX paths were reviewed for behavioral parity. Linux and macOS runtime
tests were not run in this checkout.
