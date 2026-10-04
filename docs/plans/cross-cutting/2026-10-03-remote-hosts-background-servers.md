# Remote hosts and background servers

Date: 2026-10-03. Status: Active.

## Outcome and decisions

Desktop and TUI are clients of one background server per execution environment,
OS account, and canonical Harness home. Both initially select **Local** and share
a client-side connection registry. Switching hosts leaves other hosts running.
The accepted product discussion and code evidence are in
[the research note](../../research/2026-10-03-remote-hosts-and-background-servers.md).

Use one explicit shared RPC host around HarnessService. It owns admitted roots,
operation draining, and shared close/reload; sessions own observer membership.
Disconnect disposes the observer. Server shutdown drains/cancels canonical work.
Approvals remain kernel-owned pending requests, with metadata available to attach
and decisions delivered through client-to-server RPC. No transport-owned approval
promise or automatic denial on disconnect remains.

Reconnect constructs fresh clients and attachments. An underway response is shown
as running until its canonical completed item arrives. Do not reconstruct missed
partial text, add replay storage, or automatically resend a mutation whose reply
was lost. Explicit host selection and drafts are client concerns.

Host-local transport is authenticated loopback TCP with a random secret kept in a
user-private file on POSIX and protected with current-user DPAPI on Windows.
Authenticate before admitting a JSON-RPC session. An owner discovery record gives
the endpoint and home/instance identities; the existing exclusive SQLite lock is
the final ownership authority. Bounded ensure/connect handles startup contention
and stale discovery, and never treats a PID or file as proof of liveness.

Clients use a common Node connection/provisioning adapter. Local connects directly;
WSL and SSH execute a fixed stdio bridge into the same server. The server launches
independently inside the selected environment; actual WSL/SSH qualification checks
that it survives every bridge closing. SSH uses OpenSSH configuration,
host verification and agents. SSH uses non-interactive BatchMode: users configure
keys, ports and host verification through their .ssh/config alias. The editors
take only an SSH destination, with no SSH port/key/config-file fields or prompts.
Missing authentication or an unverified host fails visibly; protocol stdout stays
separate from diagnostic stderr. Interactive SSH authentication is outside the
user's selected scope.

Add `client.json` alongside the controlling machine's existing global settings.
It stores structured host routes, runtime choices and client preferences, shared
by desktop/TUI. Each server retains its existing `settings.json`, project settings
and credentials. No remote settings are copied into the registry.

Development provisioning builds current local code into JavaScript, transfers the
bundle and generated dependency manifest/lock, and prepares target dependencies
with the target's Node/npm. Dependency installations are cached by manifest,
platform and Node compatibility; source changes only replace the staged bundle.
Managed provisioning supplies a supported portable Node runtime and the same
target-compatible server dependencies in a user-local installation. Qualify Linux
x64 glibc first using official pinned Node artifacts with checksum verification.
There is no existing Harness release channel: local build transfer is required
and does not pretend a published Harness package exists. Staging is atomic and
new code is activated only by explicit shared-server restart.

Desktop gets a host switcher above conversations and structured WSL/SSH editors,
test/connect progress, and server controls. WSL distributions are discovered as
available choices, without provisioning each one at startup. TUI provides equivalent
host editing, discovery, selection and lifecycle actions. Preserve independent
host sessions and scope views/drafts/path selection/settings by host identity.
Default exit keeps the server running; provide explicit stop and a remembered
desktop exit preference. Tray, notifications and login autostart remain optional.

Only the current protocol, plugin contracts and database format are supported.
The user explicitly authorized resetting the disposable database and removing
all older formats. Fresh databases get the complete current schema; unsupported
databases fail with a reset instruction instead of migrating or rewriting data.
Protocol version checks identify the current wire contract and reject mismatches.

## Milestones and completion checks

- [x] **Shared server authority and protocol.** Split composition/session lifetimes;
      centralize admitted roots and operation draining; detach every affected observer
      on explicit close/reload; retain/re-project approval metadata and accept one
      decision; evolve protocol version. Check through two real RPC clients that one
      disconnect/failed attach does not cancel another client's work or approval, and
      explicit root/server stop disposes resources and drains before store close.
- [x] **Background discovery and common adapters.** Depends on shared authority.
      Implement authenticated ensure/connect, exclusive startup convergence, stale
      discovery recovery, stable home/instance identity, explicit shutdown and fixed
      stdio bridge. Check concurrent real process starts, unauthorized connections,
      bridge exit survival, reconnect and explicit shutdown on native Windows.
- [ ] **Registry and provisioning.** Depends on adapters. Add validated shared
      client.json and structured local/WSL/SSH routes; bundle deployment and cached
      native dependency setup; portable Node managed setup; atomic activation and
      explicit restart. Check real Ubuntu WSL and isolated SSH, source-only upload,
      dependency reuse/invalidation, interrupted transfer, target paths, credential
      onboarding and compatible/incompatible handshake.
- [ ] **Desktop/TUI interaction.** Depends on registry and adapters. Implement
      Local-first switchers, equivalent connection editors/discovery/server controls,
      host-scoped navigation/drafts/settings and fresh reconnect, keep-running exit.
      Check actual desktop/native bridge and TUI process behavior with multiple hosts,
      simultaneous clients and a closed UI. Device-code sign-in must be
      exercised before claiming complete remote authentication.
- [ ] **Validation, review and cleanup.** Run focused public regressions and full
      npm run check, desktop build/native qualification, update README/PLAN/interface,
      protocol and testing guidance; independent correctness, architecture/simplicity
      and evidence reviews. Resolve required findings and verify final diff. Aim for
      two validated feature commits followed by tied cleanup, repeating the cadence
      when a larger delivery needs more coherent increments.

## Evidence and remaining work

- Shared composition/RPC host and protocol v2 implemented. Public regressions
  qualify disconnected accepted/queued turns, approvals with no client, racing
  decisions, failed second attachment, atomic snapshot admission, fresh response
  convergence, real shell survival/completion broadcast, shared detachment,
  configuration drainage and concurrent composition closure.
- Dependencies installed with npm ci on Node 24.19.0. Full npm run check passed:
  94 test files, 850 tests; 6 files/30 tests skipped by existing opt-in/platform
  conditions. Fixture TEMP/TMP uses D:/Temp/harness-validation, outside both the
  user's existing global settings and repository ancestor instructions/devcontainer
  configuration. Earlier runs exposed those fixture ancestry assumptions; no
  production configuration was changed to accommodate them.
- Real WSL enumeration found Ubuntu and docker-desktop. Ubuntu is Linux x64 and
  has no usable Linux Node/npm installation or sshd; isolated portable provisioning
  and an SSH qualification fixture are still required.
- Three independent read-only reviews covered correctness, architecture/simplicity,
  and tests/docs. Fixed snapshot/admission event loss, connection admission during
  composition closure, concurrent close drainage, and test resource cleanup.
- Background owner and common local adapter now provide authenticated single-stream
  attachment, atomic home/instance discovery, bounded stop, and bridge independence.
  Windows regressions qualify zero-client approval survival/completion, parent exit,
  concurrent startup, crash recovery, canonical aliases, unsafe/copy-home rejection,
  initialized-client control and deterministic startup-failure classification.
  Separate Node processes qualify shared registry edits. A real fresh-start race
  showed both SQLite openers can fail their lock upgrade; only classified contention
  now permits at most eight staggered starts within twenty seconds.
- Windows home creation uses the OS's
  [atomic directory ACL API](<https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.createdirectory?view=netframework-4.8.1#system-io-directory-createdirectory(system-string-system-security-accesscontrol-directorysecurity)>);
  existing unsafe homes are rejected, not rewritten. This also avoids module-path
  incompatibility between inherited PowerShell 7 modules and Windows PowerShell.
- Rebased on latest primary branch main, ce9db0a, at the user's request. Shared
  authority commit is now 2332e06. Migrated the new code-mode RPC persistence fixture
  to host-owned cleanup. Full npm run check passed after rebase: 99 files/907 tests,
  with 6 files/30 existing opt-in/platform skips.
- Remaining milestones stay open. Remote adapters and provisioning now have real
  process evidence; GUI/TUI integration, authentication interaction and routing,
  exit preferences, and fault-path qualification remain required.
- Background transport increment committed as d9547d5. The following tied cleanup
  derives plugin services from the session's mandatory shared host, sends shell
  process events directly through that host, and uses stateless UUID shell IDs.
  Fixture cleanup discovers only existing owners and runs independently of whether
  an assertion captured the owner's identity. Full npm run check passed: 99 files,
  908 tests; 6 files/30 existing opt-in/platform skips.
- Rebased again on the latest primary branch main, 0282afc. The first two work
  increments and cleanup are now ec69df2, 6fe523e and 630246f. Integrated named
  provider instances, shared live OAuth owners, cancellable bootstrap and the new
  provider fields in the generated v2 schema.
- The common remote adapter deploys current local JavaScript and a minimal locked
  runtime manifest. Desktop packaging now uses that same bundler. Linux x64 glibc
  managed mode verifies pinned official Node 22.23.3; development mode resolves
  existing Node/npm and caches dependencies by lock/platform/ABI. Immutable code
  builds also include the dependency key, and private canonical runtime ancestry
  is checked before staging or reuse. Provisioning cleanup preserves both original
  and cleanup failures. The client-download fallback has cancellation and a finite
  deadline. Source and local node_modules are not transferred.
- Real Ubuntu WSL and an isolated Docker/OpenSSH host passed both remote integration
  cases (43.11 seconds): managed install/cache reuse, changed JavaScript without
  dependency reinstall, relative Node resolution, authenticated identity, all-bridge
  exit survival, fresh reconnect to the same owner and explicit shutdown. SSH uses
  a fixture-specific key/config and verified host key. No SSH service was installed
  in the user's Ubuntu distro. Downloads, caches and servers use isolated fixtures.
- Full npm run check passed after the second rebase: 107 files/957 tests, with
  8 files/33 opt-in/platform skips. Desktop frontend build, cargo check and the
  native debug executable build pass. The first native editor test found that a
  selected-view remount closed connection management during disconnect; its owner
  is being lifted above host presentation and the scenario remains unqualified.
- The repository ship-change skill now explicitly requires the authorized repeating
  two-work/one-simplification cadence, periodic validated increments, and inspection
  of existing affected boundaries. The next work increment records remote deployment;
  client behavior and remaining required qualification will follow separately.
- Remote deployment and the skill cadence were committed as 122f743. The desktop
  editor now remains open through selected-host disconnect. Two real native GUI
  cases pass: Local-only initial registry, saved SSH route, disconnected management,
  reconnect and owner survival after exit; two simultaneous GUIs with stop-on-exit
  preserve the remaining client and stop only after the last GUI exits. Local
  packaged execution is staged into a private immutable runtime so a surviving
  background owner does not lock mutable desktop resources during the next build.
- The user narrowed SSH to non-interactive authentication and OS-configured aliases.
  Removed the in-progress askpass broker, native wrappers and credential dialogs,
  and removed SSH-specific advanced fields from both editors and client.json.
  Real key-based SSH qualification and provider OAuth routing remain required;
  human OpenSSH password/passphrase/host-key prompt flows are no longer in scope.
- The client increment now has three passing native GUI cases (32.8 seconds),
  including stop-on-exit before WebView RPC initialization. The authenticated
  Local bridge publishes its owner to native shutdown, independently of UI
  readiness. Shutdown closes independent bridges concurrently and rejects new
  admission; Local packaged dependency caches include the complete copied closure.
- Rendered TUI tests exercise Local-first editing, repeated conversation/editor
  switching, same-owner reconnect, another client's survival, changed-home draft
  isolation and post-quit admission rejection. An intermittent allocation failure
  reproduced Ink 7.1.1's dangling nested Static layout reference. Upgraded to the
  maintained [Ink 8 fix](https://github.com/vadimdemedes/ink/releases/tag/v8.0.0)
  and required React peers; no renderer patch or increased heap limit was added.
- Full npm run check passes: 109 files/960 tests, with 8 files/35 opt-in/platform
  skips. Four real WSL/SSH cases pass (82.01 seconds), including non-interactive
  password/unknown-host rejection and immediate fresh reconnect after forcibly
  terminating only the fixture's bridge. The background owner remains the same.
  Detached TUI aliases split their mutable presentation, and disposal of an
  already-failed remote transport does not prevent explicit reconnect.
- Remaining required work includes desktop cancellation/readiness, selected-host
  CLI subcommand boundaries, remote OAuth routing, full native fixture migration,
  remote fault/credential qualification and final independent reviews. Created
  TUI conversations persist after client exit, consistently with server ownership.
- Client interaction was committed as 0282aac. The following cleanup removes the
  unreachable connection-owned SSH launcher and its duplicate destination parser.
  Isolated stdio rejects both --host and --ssh before launching. Existing local
  auth/sandbox utilities reject host flags and direct selected-host operations to
  the command center, rather than silently executing against the wrong machine.

- Desktop attempts now have native admission, cancellation and quit drainage.
  A finite initialize deadline closes a stalled peer, preserving its initiating
  diagnostic after bridge cleanup. WSL enumeration uses bounded, cancellable
  OS process execution. Four native connection cases pass (42.5 seconds),
  including actual WSL stalled provisioning cancellation, remote fixture process
  exit and continued Local usability. The initial cancellation test used an
  incorrect exact label selector; the accessible combobox selector fixes the
  test, without changing its timeout or cancellation assertion.
- Full npm run check passes: 110 files/963 tests; 8 files/35 existing opt-in/platform
  skips. Three independent reviewers checked cancellation ownership, format
  handling and evidence. Fixed native cleanup replacing readiness diagnostics,
  uncancellable discovery, omitted server.release schema/docs and retained
  legacy conversation pinning. New conversations resolve and insert their model
  selection together; the service no longer rewrites older records on activation.
- The user selected both ChatGPT sign-in methods: preserve browser OAuth for
  Local, add optional device-code sign-in for Local, and use device codes for
  WSL/SSH. Callback forwarding is explicitly excluded. Both methods persist the
  same instance-scoped OAuth session on the executing host. Device provisioning,
  polling, cancellation, URL/code presentation and selected-host credentials
  require qualification before completion.
- Device sign-in is additive: existing browser regressions remain. Device tests
  qualify pending authorization, cancellation during fetch/delay, expiry, safe
  errors and reusable OAuth credentials. Public RPC verifies URL/code delivery,
  cancelled login followed by successful retry and named-provider isolation.
  Current protocol version is 3; older running development servers fail the
  handshake rather than receiving incompatible auth fields.
- The full native desktop suite passes all fourteen cases (2.6 minutes), including
  Local browser/device choice, code display, cancel/retry and actual DPAPI storage.
  Three rendered TUI cases pass (16.76 seconds), including both Local methods and
  device cancellation. Only provider HTTP is substituted in sign-in scenarios;
  live vendor-account acceptance remains credential-dependent.
- Native fixtures now identify authenticated background owners, stop only their
  fixture homes during teardown and wait for actual process exit before removing
  a working directory. Route tests use the host-scoped router's sidebar links.
  A frozen-owner scenario found the stdio bridge waiting for peer TCP closure.
  Review then reproduced EOF starvation while outbound backpressure paused stdin.
  Bridges now keep reading within the existing writer byte limit and discard
  unacknowledged delivery on EOF; closing a remote transport terminates only its
  owned SSH/WSL process. A real authenticated paused-receiver regression covers
  detachment with a queued three-MiB frame. Accepted execution remains server-owned.
- Full-check iteration found a TUI fixture sending input after a visible frame but
  before React's input effect was installed. The fixture uses React act to flush
  effects between input events; no sleeps, retries or longer timeout were added.
  Full repository verification and real WSL/SSH credential/fault qualification
  remain required before completion.
- Full npm run check passes: 111 files / 974 tests, with 8 files / 35 opt-in or
  platform skips. A run concurrent with native qualification timed out in the
  existing multi-case QuickJS resource-limit test and a native Local-readiness
  assertion. The full check passed alone without code/timeout changes. Native
  connection requalification passed all four cases separately (42.6 seconds),
  including actual WSL cancellation. Remote milestones stay open.
- After the backpressure detach fix, full npm run check passes: 112 files / 975
  tests, with the same 35 skips. Independent lifecycle review reran the original
  paused-owner reproduction: the bridge exits successfully and the owner remains
  listening. The regression also passes through the real attach-only entry point.
  Rebuilt native shutdown/connection qualification passes five cases (51.3 seconds),
  including the suspended owner and actual WSL cancellation.
