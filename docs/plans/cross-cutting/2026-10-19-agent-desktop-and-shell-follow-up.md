# Agent, desktop, and shell follow-up

Date: 2026-10-19. Baseline: `b215b8e` (`main`).
Status: Complete — implementation and available qualification verified; limits below.
Research: [repository audit and primary-source comparisons](../../research/2026-10-19-agent-desktop-and-shell-audit.md).

## Goal and scope

Make ordinary use predictable without another agent framework, prompt system,
terminal emulator, identity store, or UI component package. All twelve requested
issues remain required. Completion means the checks below pass, documentation
matches delivered behavior, and qualification limits are explicit.

| ID  | Required user-visible outcome                                                                                                     | Owner / milestone                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| W1  | Only actual user/assistant messages and commentary sit outside Working.                                                           | Desktop projection / M1                |
| W2  | Opening a row in the latest Working preview survives subsequent work.                                                             | Desktop presentation / M1              |
| A1  | Small tasks do not encourage delegation; children do not relay whole assignments unchanged. Useful parallelism remains supported. | Subagent tool/catalog guidance / M3    |
| A2  | Dismissed branches disappear from the GUI navigator without deleting history or silently stopping work.                           | Subagents + server projection / M3     |
| A3  | Children receive a concise identity/parent/task briefing.                                                                         | Subagent spawn / M3                    |
| A4  | Normal subagent operations and labels use readable handles, with IDs as fallback.                                                 | Family + activity tool boundaries / M3 |
| G1  | `$HARNESS_HOME/AGENTS.md` applies independently of role prompts to roots and children, including projectless conversations.       | Agents plugin / M4                     |
| E1  | Supported user shells and intended startup environment work predictably across actual execution hosts.                            | Execution + server startup / M5        |
| U1  | Input utilization remains meaningful with input-only limits, and unknown capacity is not shown as zero.                           | Desktop + TUI / M2                     |
| D1  | Desktop Markdown links are visibly recognizable and keyboard accessible.                                                          | Existing content-link rendering / M2   |
| D2  | CSD main top-left is square when the left sidebar is closed.                                                                      | Existing layout CSS / M2               |
| D3  | CSD host-area controls have translucent interaction states; both sidebar toggles share consistent primitive styling.              | Existing control recipes / M2          |

## Design decisions and invariants

### Working and desktop

- Define message rows positively as `user | assistant`; every other transcript
  cell is work. Keep chronological boundaries/provenance. Approval/question forms,
  connection warnings, and composer controls are not transcript cells.
- Reuse existing cell renderers and preserve individual error announcements/details.
  Integrate terminal duration markers into the summary instead of duplicating a
  nested duration line. The initially added group-level failure aggregation is
  removed in the subsequent reading follow-up at the user's explicit request:
  failed tool calls are normal and do not make the Working group itself failed.
- Collapsed latest work mounts the last five nonempty entries plus explicitly
  open/focused entries, with a stable keyed owner. Retention is proportional to
  deliberate interaction, not all intervening or future rows. Existing outer
  expansion remains an explicit request for full details. No durable UI state.
- Reuse `IconButton`/`Button` and a narrow chrome interaction recipe. Both toggles
  already share a base; remove inconsistent geometry rather than add a new base.
  Content-link styling must not restyle navigation or bypass safe URL opening.

### Subagents and identity

- Improve shipped tool/catalog guidance, not arbitrary spawn quotas or default
  depth reduction. A child should execute its task; nested work requires a
  distinct deliverable and the parent remains responsible for integration.
- Names label tasks; existing durable parent-local slugs provide readable handles.
  Prefer an explicit parent reference and scoped slugs; accept unique display
  names only when unambiguous. Preserve canonical IDs, family authorization, and
  legacy ID fallback. Never guess among duplicate names.
- Apply readable references to send/dismiss AND activity wait/peek/kill, list,
  notices, and foreground/background results. Add only the narrow activity
  reference contract needed by this known consumer; do not persist a second
  alias registry. Resolve activity references only among the caller's tracked
  activities; family parent/sibling references do not grant cross-owner activity
  access. Durable family references must not recreate expired activities.
- Filter dismissed branches before GUI pagination, including counts/expanders.
  Keep direct history available. Dismissal is neither cancellation nor deletion.
  Brief children from existing spawn metadata, not an implicit parent transcript.

### Global instructions: additive file, not a role framework

- Load the executing server's `$HARNESS_HOME/AGENTS.md` through the existing agents
  plugin's stable instruction contribution, before applicable project files.
  Include it with or without a workspace and independently of child role prompts.
- Keep current `config.instructions`/catalog role behavior and scalar precedence;
  no new role field, baseline migration, global editor, or prompt registry is
  necessary for G1. This is source separation using an existing seam.
- Label the global file as applying to all conversations on that server, not just
  descendants of the Harness home. Deduplicate if the same file is also found
  through ancestry. Preserve current no-symlink instruction-file policy.
- A missing global file is normal; unreadable/invalid filesystem conditions are
  errors, not an excuse to silently ignore intended guidance. Snapshot once per
  loaded runtime like existing initial instructions; changes apply on reload.
  Do not inject local client files into remote hosts or parse shell commands to
  discover instructions. Do not rewrite stored transcripts/configuration.

### Capacity and environment

- Both clients use the authoritative agent checkpoint and its exact model.
  Percentage uses known `maxInputTokens` first (label: input limit), otherwise
  `contextWindow` (label: shared context window), otherwise remains unavailable.
  Show known input usage even when the denominator is unknown; output-only
  metadata does not establish input capacity. Show both limits when available.
- Do not infer shared context as input plus output, combine usage from other model
  purposes, or use compaction's reserve-adjusted trigger as the UI denominator.
  Existing engine capacity/compaction behavior remains unchanged.
- Resolve shell language and startup state on the execution host. Separate
  trusted user startup initialization from model-command execution; never move a
  model command outside its permission/sandbox boundary. A newly attaching client
  cannot replace a running shared owner's environment. Keep AppImage loader
  sanitation, native confinement, cancellation, and process-tree ownership.
- M5's design checkpoint must settle supported shell selection, startup/export
  scope, alias/function expectations, initialization lifetime, unsupported-shell
  reporting, and Windows profile policy before broad implementation. Existing
  native `bash -c` is intentional; do not replace it blindly with `-ilc`.

## Execution checklist

Implementation items below track actual verification. The milestones are coherent slices,
not a requirement for one branch per item. M1/M2/M3/M4 can proceed independently;
M5 starts with its explicit design/probe gate. Each slice includes its own docs,
regression coverage, and independent review proportional to risk.

### M0 — Plan and research (current scope)

- [x] Record all twelve requirements, current implementation boundaries, primary
      upstream evidence, limitations, and proposed simplifications.
      Check: requirements table and linked research cover every user concern.
- [x] Review behavior, architecture/simplicity, and tests/scope independently;
      resolve material findings and record disposition/evidence below.
      Check: no unresolved document blocker or missing required behavior.
- [x] Validate document formatting, links, whitespace, and final scope.
      Check: affected Markdown passes Prettier; local links resolve; diff contains
      documentation only. No product tests are claimed by this milestone.

### M1 — Working projection and intentional reading state (W1, W2)

- [x] Make non-message grouping exhaustive in desktop row types and projection;
      reuse renderers, preserve Eval begin/result identities, and reconcile timing
      for cells without turn IDs. Avoid duplicate pending Working placeholders
      during context-only activity and duplicate terminal elapsed labels.
      Check: reducer-to-projection tests cover all cell kinds, actual terminal
      events, context-only/failed/aborted turns, commentary boundaries, history
      reconstruction, and unchanged-array terminal updates without invented timing.
- [x] Retain open/focused preview steps without moving/remounting their keyed
      owner. Track the step's own disclosure rather than arbitrary nested toggles;
      release retained steps on close/focus exit and reconcile removed keys.
      Check: outer-collapsed/inner-open append-more-than-five browser regression
      preserves the same DOM/body/selection/focus; only last-five plus exceptions
      mount. Cover nested disclosure, Eval result rows, outer expansion/collapse,
      superseding groups, history prepend/canonical replacement and reading anchor.

### M2 — Client capacity and desktop control polish (U1, D1–D3)

- [x] Correct both clients' checkpoint/model/denominator selection and label the
      basis. Use a small shared pure presentation helper only if both clients need
      identical selection/format-independent logic; leave compaction separate.
      Check: input-only, context-only, both, output-only, fully unknown, missing
      usage, zero usage, model-switch and auxiliary-call fixtures pass.
- [x] Add scoped Markdown link styling and standardize existing sidebar/chrome
      control recipes, corner state, sizing and accessibility.
      Check: focused browser cases cover actual left/right toggles, host hover/
      focus, CSD sidebar open/closed, native/fullscreen, light/dark, links in
      assistant/reasoning content, supported/unsupported destinations and opener
      failure. Geometry/focus assertions accompany visual comparisons. Browser
      checks alone do not establish native window-material behavior.

### M3 — Useful delegation and readable family interaction (A1–A4)

- [x] Replace blanket delegation preference in shipped tool/catalog text with
      direct-small-work, useful-independent-work, and no-unchanged-relay guidance.
      Add the compact child identity/parent/task briefing at spawn using existing
      metadata. Preserve project rules, assigned read-only scope, depth limits,
      and configured catalog/tool inheritance.
      Check: direct/code-mode contracts expose matching guidance; root/child/
      grandchild, projectless and legacy metadata cases have truthful identity.
      Exercise small-lookup versus substantive parallel-review prompts when a
      model is available; text assertions alone do not prove model compliance.
- [x] Resolve readable family and activity references at their owning tool
      boundaries, retaining canonical IDs and owner/family checks.
      Check: send/dismiss/wait/peek/kill, list/results/notices and direct/eval paths
      cover family parent references, duplicate names, owner-local activity
      references/slug collisions, legacy UUID fallback, permission denial,
      settlement/collection and restart. Parent/sibling activity access remains
      denied; do not resolve activities through durable family records.
- [x] Filter dismissed GUI branches through the public server projection before
      paging; refresh affected navigation and handle an already selected child.
      Check: dismissed first/middle/all pages and descendants disappear without
      empty-page dead ends or stale expanders; completed-but-not-dismissed agents
      remain. Dismissal does not kill live work or prevent direct historical access.

### M4 — Global AGENTS.md through the existing plugin (G1)

- [x] Supply the resolved executing-host Harness home to the agents plugin and
      load its global file before initial project instructions. Preserve source
      labeling, deduplication, instruction security, and runtime snapshot behavior.
      Check: main and custom/general/explore children, no-workspace conversations,
      non-default `HARNESS_HOME`, ancestor duplication, missing/unreadable/symlink
      files, deeper rules, reload/rewind/compaction and stable repeated requests.
- [x] Prove the global file is additive even when `config.instructions` is a
      client baseline or custom child-role override; do not alter scalar merges.
      Check: public service/request fixtures observe both role and global/project
      instructions, with isolated local/remote homes and no client file transfer.

### M5 — Supported shell and startup environment (E1)

- [x] Before broad edits, run isolated Bash/zsh startup probes and compare existing
      OS/maintained-library facilities with the required contract. Record the
      smallest chosen design in this plan: shell-selection precedence and tool
      language, startup files/interactive guards, exports versus aliases/functions,
      Windows behavior, owner lifetime/restart semantics and backend support.
      Check: the selected design covers the required default-shell/rc environment
      behavior, native-host startup constraints and target ownership; any missing
      required behavior remains a blocker, not a deferral. No full persistent PTY,
      general snapshot framework or retry/fallback chain without demonstrated need.
      Record the supported shell/backend and exports/aliases/functions matrix.
- [x] Implement the chosen narrow contract across local/native/container and
      SSH/WSL target startup as applicable. Preserve confinement and cancellation;
      bound startup work and classify observable initialization failures without
      logging environment values or treating deterministic defects as transient.
      Check: real isolated startup files cover exports, early interactive guards,
      noisy/failing/hanging rc, `BASH_ENV`/`ZDOTDIR`, supported/unsupported shell,
      quoted paths, aliases/functions per chosen contract, process-tree stop and
      a cold GUI-owner launch with sanitized inherited environment: rc-derived
      exports must reach real commands, and a second client with conflicting
      `PATH` must not replace the owner's environment. Check backend/tool language
      agreement. Verify available real remote/container/platform paths; record
      unavailable native qualification explicitly.

### M6 — Integrated evidence and durable documentation

Depends on M1–M5 for complete delivery; partial slices may be independently verified.

- [x] Update affected public protocol/schema/tool documentation and subsystem
      READMEs to actual behavior, plus `docs/TESTING.md` for coverage/limits. Remove
      superseded local recipes/descriptions rather than leave parallel paths.
- [x] Run `env -u HARNESS_SERVER_SELECTION npm run check`, focused production-route
      browser regressions, and relevant real shell/remote/native checks. Diagnose
      original failures before changing behavior or test expectations.
      Check: actual results and unsupported platform/live-model limits recorded;
      source/typecheck or mock success is not substituted for process/UI evidence.
- [x] Independently review the integrated changes with correctness, simplicity/
      architecture, and evidence lenses; resolve findings and update this plan.
      Check: every required outcome has evidence, with no unfinished required
      integration relabeled as cleanup or deferral. No commit/push/release is
      authorized by this document alone.

## Documentation impact

During planning, link this work from root/subsystem roadmaps without describing
proposed behavior as shipped. During implementation, update owning accepted
architecture: interface (Working/control/capacity presentation), orchestration
(family visibility/handles/briefing), context (global instructions), execution
(shell/env ownership), and testing. Update model documentation only if public
capacity interpretation changes; do not rewrite engine capacity semantics.

## Planning review and validation evidence

- Correctness/completeness review: all twelve outcomes have owned tasks and
  completion checks; no material blockers.
- Architecture/KISS/DRY/YAGNI review: existing agents instruction contributions,
  owner-local activity references, keyed local preview retention, and shared
  controls are sufficient. No role framework, persisted aliases, disclosure
  registry, or speculative shell machinery is needed.
- Evidence/test review: no substantive blockers. Corrected the status convention
  to Draft and strengthened cold GUI-owner/conflicting-client environment checks.
  Clarified that family references do not widen activity ownership.
- Review-driven changes are documentation clarifications, not a new product
  design or implementation; no implementation re-review is claimed.
- Validation: Prettier checks pass for all five affected Markdown files,
  `git diff --check` passes, and all 76 relative Markdown target paths resolve.
  Scope check finds exactly the two new research/plan files plus three roadmap
  edits; no product code changes. Full `npm run check` and product tests were not
  run for this documentation-only milestone.
- No product implementation, upstream runtime tests, native qualification, or
  behavioral model evaluation is claimed. Shell contract details remain an
  explicit pre-implementation gate, not an excuse to omit the requested
  environment behavior.

## Implementation progress

- Implementation authorized after the planning review. Three bounded independent
  workstreams own desktop/presentation (M1/M2), family/activity interaction (M3),
  and shell probes/execution (M5); the coordinating workstream owns global
  instructions (M4), shared composition, documentation, integration and review.
  No nested delegation, push, or release is part of this authorization. The user
  subsequently authorized coherent validated local commits as work progresses.
- Planning evidence above is historical, not implementation qualification.
- M4 focused verification: 30 tests pass across agents, global service requests,
  execution integration and workspace switching. The service fixtures observe
  global/project guidance alongside root, general, explore and custom child
  roles, including projectless conversations, isolated homes and explicit reload.
  Initial failures were test-harness mistakes (nonexistent lifecycle methods,
  then missing explicit `prepare` after deactivation) and a fixed-Bash fixture
  assumption exposed by real shell selection; assertions were preserved.

### Selected shell contract (M5 design gate)

Use one bounded native interactive-login Bash/zsh startup capture per actual
target owner, then fresh noninteractive command processes with captured exports.
Bash follows its own login profile ordering: `.bashrc` runs when the login profile
sources it; do not parse/trace startup scripts or source it a second time. zsh
uses its normal login/rc order and `ZDOTDIR`. This imports exported environment,
not persistent aliases/functions/options or working-directory changes. Detect
failed startup processes/timeouts/transport rather than promise to detect every
failed statement a user script itself masks.

| Backend           | Command language                                                                                                     | Environment ownership                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Local/native Unix | Explicit target `SHELL`, otherwise account Bash/zsh; unsupported shell is reported. Tool language matches selection. | Initialized executing-host owner; native commands do not replay host login scripts inside confinement.                           |
| Windows           | Existing PowerShell noninteractive/no-profile contract.                                                              | Existing owner environment; Unix rc semantics are not invented for PowerShell.                                                   |
| Docker            | Existing truthful Bash tool language.                                                                                | Default supported Bash/zsh user's startup exports captured inside that physical container handle; no host profile/env injection. |
| SSH/WSL           | Target platform's contract above.                                                                                    | Target owner performs initialization; attaching clients do not replace it.                                                       |

Primary maintained facilities were checked: `shell-env` uses newline parsing and
broad fallback unsuitable for NUL-safe fail-fast capture; the existing
devcontainers CLI probe is not a public checked startup-result seam. Reuse Node
account-shell lookup and process facilities, adding only bounded private-FD NUL
export transport. Preserve Harness identity/selection and packaged loader
sanitation. Initial contained inspection could not reach Docker; the approved
host retry found real Docker and Bubblewrap. Final real tests pass six Bubblewrap
cases and four cached-image Docker cases, including non-root account HOME and
process-group timeout. Only a new owned container was used (`--pull=never`, no
network/mounts) and removed. Real SSH/WSL, Windows/macOS and native desktop
material qualification remain unavailable; adapter/source fixtures do not replace them.

### Integrated review and focused delivery evidence

- M1/M2: 60 focused unit tests pass (projection 15, capacity helper 6, CLI 27,
  desktop session 12); final production-route Chromium matrix passes 32/32, with a
  subsequent screenshot/control/retention rerun 12/12. Working rows preserve real
  DOM/body/text-node/selection/focus across append, prepend/replacement and
  supersession while mounting last-five plus intentional exceptions. Blank work
  does not consume slots; images and meaningful tool/shell rows remain.
- Broad Chromium evidence is not all green: 145/147 in the last complete run. One
  failure is the previously baseline-reproduced 12px history anchor; the new
  selection case failed because selection was absent before append while its
  disclosure animated. The test now establishes actual selected text first,
  keeps the post-append assertion, and passes in final focused runs. The separate
  scrollbar case captured a detached Virtuoso sizing copy; archived original
  source reproduced its timeout, and waiting for the actual visible owner fixes
  the prerequisite without changing geometry assertions or timeout.
- M3: 107 focused tests pass across subagents, activities, family service, shared
  server and code-mode integration. Ordinary text/briefings/notices use readable
  references; canonical IDs remain structured compatibility/ambiguity fallbacks.
  Desktop dismissal refresh/selected-side clearing passes production-route cases.
- M4/integration: the focused 30-test run and subsequent 25-test regression run
  cover root/child roles, projectless use, separate homes, runtime snapshots,
  actual compaction/rewind and byte-equivalent repeated instruction prefixes.
  Negative public notification cases verify other-root/unattached isolation.
- Independent family/global review passes 133 tests across eight files and finds
  no material blocker. Its two proof gaps were addressed by the compaction/rewind
  and negative-notification assertions above. Desktop review finds no product
  blocker; final corrected selection evidence and older-group reading exceptions
  are reflected in accepted architecture.
- Initial shell review finds three material defects despite focused tests:
  pre-initialization sandbox probing, exported Bash options/readonly import, and
  escaped descriptor holders extending startup deadlines. Fixes initialize before
  sandbox construction, filter intrinsic Bash state at one shared boundary, and
  close owned pipes/kill the original group with bounded direct-child cleanup.
  Non-root Docker HOME and resolved-owner-home regressions were added too.
- Public composition and real cold-owner tests pass 18/18: backend default sees
  initialized PATH, owner home survives changed HOME, failed startup releases
  SQLite ownership, actual rc-derived commands/global guidance work, and a later
  conflicting client retains the same owner PID/exports. Demo provider direct,
  evaluator and discovery paths now support the offered zsh tool (7/7).
- Shell fix sweep passes 80 tests with one platform skip; final live Bubblewrap 6
  and Docker 4 pass. Independent re-review passes 47 tests with seven capability/
  platform skips and finds the original defects resolved. It does not claim
  escaped detached processes are killed: their descriptors cannot retain owner
  startup, and tests clean up their own escaped PIDs.
- Final integrated simplicity review finds no new material blocker or added role,
  alias, disclosure, or environment registry. Repeated alias scans on small
  visible-family rosters are a nonblocking potential operation-local optimization;
  no persistent index/store redesign is justified for this delivery.
- Both real Bash and zsh startup/native paths were rechecked by the coordinator:
  26/26 tests pass, including six real Bubblewrap cases. This account reports zsh
  through both explicit `SHELL` and account metadata; local/native use zsh without
  requiring Bash configuration.
- Final `env -u HARNESS_SERVER_SELECTION npm run check` passes **2,079 tests / 45
  skips / 0 failures** across 185 passing and 11 skipped files, including all
  three typechecks, lint and repository formatting. Earlier attempts caught a
  test-only unsupported `Array.fromAsync` use, asymmetric-matcher lint, and
  unformatted generated evidence Markdown; each was corrected at its source
  without changing the TypeScript target, test contract, or formatter scope.
- Desktop production Vite build passes. Server and CLI bundles pass with the
  shared production bundle options and external dependency sets; these checks
  do not claim a rebuilt native installer. An initial ad-hoc CLI bundle probe
  used the wrong `.tsx` entry; the real `.ts` entry from the production script
  passes without product changes.

### Completion and remaining qualification limits

All twelve required outcomes are implemented and covered at their practical
public boundaries. Independent correctness, architecture/simplicity, desktop/
evidence reviews and the substantive shell fix re-review leave no material
blocker. No extra role framework, alias store, disclosure registry, persistent
terminal or engine capacity policy was added. Source documentation and plugin
contract/schema are synchronized.

The earlier full browser sweep is not claimed green; see the subsequent
geometry correction below rather than treating 12px as proven product movement.
Native window material/OS opening,
real SSH/WSL, Windows/macOS shell execution and live-model delegation compliance
remain unqualified. This delivery uses real Linux Bash/zsh, Bubblewrap and owned
cached-image Docker evidence, not mocked platform claims. Restart the executing
owner to refresh shell exports and reload a conversation for changed initial
global/project instructions. No user credentials, running installed server,
remote branch or release was changed.

Subsequent investigation: the [transcript reading follow-up](../interface/2026-10-19-transcript-reading-follow-up.md)
finds that the exact 12px automatic-history assertion compared a padded container
with its inner span, not the same box across time. The earlier failed broad-run
result stands, but it was not proof of that amount of product movement. This
corrects the earlier defect characterization without dismissing the user's
separate report of disruptive larger jumps, which the follow-up investigates.
