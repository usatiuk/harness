# Migrate native sandboxing to MXC

**Status: Complete**

## Outcome

One implementation of Harness's existing `native` execution backend runs on
Linux, macOS, and Windows through the stable MXC Node SDK. Shell and file tools
use the same workspace, permissions, and temp directory within the existing
`ExecutionContext`. Replace the handwritten Bubblewrap launcher and the
host-side mutation checks. Keep public backend names, approvals, and the
activity model.

The [MXC evaluation](../../research/2026-11-21-mxc-native-sandbox.md) records the
upstream APIs, what they replace, and the known compatibility limits. The plan
starts with the published MXC 1.1.0 Node package and its stable V1 API.

## Hard scope

Run native shell commands and file operations through MXC on Linux (including
WSL), macOS, and Windows. Remove the superseded launcher and path checks at
cutover.

| Required behavior                                                     | Release check                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep Bash, zsh, and PowerShell working with the existing environment. | Run the host's supported shell through Harness. Check that existing exports and selected tools are available and the command does not rerun shell startup.                                                                       |
| Files outside the workspace are read-only.                            | From shell and file tools, read an outside file and reject a write to it. Verify workspace writes on and off, linked Git metadata access, and temp writes.                                                                       |
| Networking is on by default and permits outbound connections.         | A default conversation can make an outbound connection. Turning networking off blocks it. Host localhost and inbound access remain blocked in Native. The existing one-call approval covers commands that need the host network. |
| Each server has its own writable temp directory.                      | Native commands can share files through `TMPDIR`, `TMP`, or `TEMP`, including in read-only workspaces. A different server or a restart gets a fresh directory.                                                                   |

Windows and WSL runtime testing are the agreed completion gate. Keep the
macOS and native Linux implementation in scope. Record live results only for
the hosts tested.

Scope changes require explicit approval. This includes changes to Docker,
unconfined execution, approvals, or telemetry, and new sandbox settings,
per-OS controls, proxies, port forwarding, and persistent containers.

## Design

### Use the existing boundary

- Keep one native execution context under `packages/sandbox`. Translate the
  resolved workspace, selected shell, and native settings directly to a typed
  MXC `ContainerRequest` with `containment: { type: "process" }`. Use the stable
  `@microsoft/mxc-sdk/v1` exports and MXC's OS selection, policy validation,
  and process enforcement. Use the current server-side selection and reporting
  path. Unsupported explicit `native` requests fail with an actionable reason.
- Adapt MXC's process handle to the existing `SpawnedProcess` contract.
  Reuse current shell selection and command argument construction where they
  fit. MXC accepts a command string, so keep quoting at that single boundary
  and verify Windows, Bash, and zsh command behavior. Attach streams before
  waiting, and handle cancellation both before and after the async handle
  arrives. Use MXC's kill and wait operations for shutdown, and wait for output
  drain before reporting completion. Activity scheduling, rendering, output
  spill, and deadlines remain with their existing owners.
- Launch the existing Node file operations through the same native request as
  the shell. Pass the operation and any binary payload over standard input.
  Use a fresh MXC process per call and share one policy and temp directory.
  The trusted output store and approved host context use their existing paths.

### Preserve one native policy across hosts

- Use the existing execution host environment. Harness already loads the
  target account's Bash or zsh startup once on Unix and runs commands from
  those captured exports. On Windows it uses the server's environment and
  PowerShell with `-NoProfile`. Pass the same environment explicitly to MXC,
  preserving the existing startup-variable filtering and private temp
  overrides. Reuse the existing shell selection and startup code.
- Preserve the current Linux filesystem contract on every native host.
  Files outside the workspace are read-only by default. Existing OS permissions
  and private runtime paths still apply. The workspace is read-write when
  `workspaceWrite` is on and read-only otherwise. Use MXC path grants to
  implement the same policy, including Windows drive roots where needed.
  Let MXC enforce the OS permission boundary and path precedence. Qualify the
  broad read policy with the private runtime paths in place before cutover.
  Installed tools should work from the existing environment and readable
  filesystem. Use SDK tool discovery only if a tested compatibility gap
  requires it. Keep host cache writes within the existing approval path.
- Preserve private scratch and linked Git metadata access when workspace writes
  are enabled. Give shell and file operations the same grants. Use private
  scratch as the working directory for projectless calls.
- Keep Harness's default `network: true` and map it to external egress with
  ingress and host loopback denied. Setting `network: false` shuts off external
  networking. A command that needs Linux's shared host network can request the
  existing one-call host escape, subject to approval. Use MXC's native
  networking and keep proxies and port forwarding out of the migration.
- Create one scratch directory per Harness server process and grant it write
  access through MXC. Point `TMPDIR`, `TMP`, and `TEMP` at that directory on all
  three platforms. Other temporary paths follow the regular filesystem policy.

### Share prerequisite checks and setup guidance

Use the same server-side native availability and request-failure path on all
three operating systems. Use MXC's structured errors and remediation where
available, and give all clients the same backend, missing capability, and setup
guidance. Discover the host capability once per server runtime. Conversation
activation only prepares its own workspace. Keep host discovery advisory and distinguish an unsupported host or a
missing package from a probe or launch failure. Share the error presentation
with the existing sandbox selection flow; keep Docker's checks with Docker.
No parallel package detector, automatic installation, or retry with weaker
permissions.

Keep one sandbox prerequisites table in the execution documentation and link
to it from setup and errors. Cover server-host OS support, Node and native
assets, and mode-specific Linux packages. In Linux and WSL, network-off uses
Bubblewrap and usable user namespaces. Network-on also needs `slirp4netns`, the
iptables tools, and the standard helpers in the
[upstream Linux requirements](https://github.com/microsoft/mxc/blob/v1.1.0/docs/backends/bwrap/bubblewrap-backend.md#prerequisites).
An explicit network-on request with missing dependencies explains what to
install on the execution host or how to choose network-off.

## Delivery

### Qualification evidence

- Windows 11 build 26300 with MXC 1.1.0 passed real PowerShell and file operations,
  workspace write denial, junction denial, binary transfer, linked-worktree Git
  commits, and cancellation of a verified child process. Scratch was shared
  within one process and fresh in a second process. Outbound HTTPS succeeded
  with networking enabled and failed with it disabled. Both modes blocked IPv4
  localhost and inbound connections from the host's loopback and two network
  interfaces. Through the Harness tool pipeline, an approved host write
  succeeded, the next confined write was denied, and full command output
  persisted in a read-only workspace. The built Windows server selected the
  native default, and its packaged MXC and file worker passed a binary round
  trip. The packaged worker's median read took 147 ms across seven samples
  with outbound networking enabled.
- Ubuntu WSL passed those filesystem and scratch checks through a bundled
  adapter and file entry point, plus outbound access on and off. Bundled native
  commands in both Bash and zsh retained captured exports without rerunning
  shell startup. Both shells denied connections to a live host loopback endpoint
  with networking enabled. Shell and file tools shared the linked Git metadata
  grant and a linked commit left the primary checkout intact. The default
  network-on startup cost in the SDK probe was about 150 ms on Windows and
  230 ms on WSL for one read. A minimal MXC command took about the same time.
  The previous direct Bubblewrap launcher took about 4 ms for a minimal command
  on WSL with shared host networking.
- Windows traces showed repeated host discovery taking about 0.5–0.7 seconds
  during conversation activation and causing the CLI-host and feedback tests to
  miss their deadlines. Moving discovery to server startup cleared both. Small
  text and image reads now use one execution call by reusing the initial bytes
  used to identify the file type.
- `npm run check` passed on Windows with 2,114 tests passing and 94 skipped.
  The opt-in Windows MXC and worktree tests also passed.
- The reusable native integration suite now verifies host IPv4 loopback
  isolation with networking both enabled and disabled using a reachable test
  listener on the host. It passed in Windows and bundled WSL runs.
- Native Linux outside WSL and macOS have no live test results for this change.
  macOS uses the same MXC request through Seatbelt, and MXC 1.1.0 includes the
  Apple silicon runner and native library. The policy was checked against the
  [pinned Seatbelt documentation](https://github.com/microsoft/mxc/blob/v1.1.0/docs/backends/seatbelt/seatbelt-backend.md).

### 1. Qualify locally

- [x] Exercise the local shell, file, network, and scratch policies on Windows
      and WSL. Verify execution through the packaged Windows server and the
      bundled WSL adapter.

### 2. Replace and review

- [x] Route native shell and file calls through MXC. Verify output streaming,
      cancellation, disposal, binary file operations, the one-call approved
      host path, and trusted output spill.
- [x] Resolve the three independent reviews. Linux default selection tests the
      outbound policy. MXC ships in the server payload. Failed processes are
      stopped and awaited, and cancellation tests distinguish a killed process
      from a launch error. Documentation records the Node requirements and
      filesystem scope of Unix sockets. Real MXC tests use the existing local
      integration flag.

### 3. Remove superseded code

- [x] Remove the direct Bubblewrap launcher, resolver and temp mounts, custom
      process-group handling, host-side mutation checks, and superseded tests.
      Keep the MXC adapter and the shared file worker.
- [x] Preserve the `native`, Docker, and `none` settings and approved host access.
      Pass `npm run check` and document the local results and platform limits.
