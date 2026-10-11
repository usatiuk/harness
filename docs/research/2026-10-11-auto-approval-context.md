# Auto-approval context and denial investigation

The [current delivery plan](../plans/execution/2026-10-11-auto-approval-revamp.md)
has been narrowed at the user's request: existing YES/NO decisions, clearer
context, and workspace file inspection in an unsaved temporary review. This note
retains the earlier research and broader proposals as history. Structured decision
output, reason codes, provenance frameworks, and history redesign are not current
implementation requirements.

## Question and scope

The user reports that auto-approval rejects almost everything. This investigation
traces the current Harness request and compares public approval implementations.
This initial research predates implementation and live diagnosis. It did not
examine an affected live conversation or change runtime policy. Subsequent
implementation and model-specific live evidence are recorded in the delivery plan.

## Baseline Harness behavior before the revamp

`packages/auto-approval/src/auto-approval.ts` sends a standalone reviewer policy,
the projected transcript, and the exact proposed call. The final call includes
untruncated arguments, available tool description/input contract, parent call id,
and workspace root/relationship when a relationship exists. It offers no tools.
The reviewer model/preset comes from plugin configuration or the conversation.
The model invocation has a 30-second deadline.

`reviewer-window.ts` selects ordinary history from the latest compaction onward,
the most recent sixteen nested calls, and up to sixteen failed nested calls and
their results across the active branch. Earlier human messages therefore depend
on the summary for their authorization evidence. Prior tool arguments and results
are bounded to 1,000 characters per rendered value; spilled structured results
receive bounded head/tail previews. Human and assistant messages in the selected
window are retained.

The review excludes reasoning and every context item. More significantly,
`core/src/engine.ts` forwards the draft instructions without merging the ordinary
agent instruction assembly. Settings instructions and initial AGENTS.md context
sources are absent; lazily discovered AGENTS.md context items are also omitted.
The original auto-approval commit (`bb5d915`) already omitted context items and
used only its reviewer instructions. This is a longstanding omission, not evidence
of a recent breakage.

The parser approves only trimmed, uppercase `YES`. `YES` plus an explanation,
lowercase `yes`, empty output, unexpected tool calls, provider failures, and
timeouts all become automatic denials without falling through to a human prompt.
The durable annotation distinguishes these cases through its reason string.

The policy explicitly honors exact or category-level human authorization and
encourages low-risk project inspection, but does not give a broad low/medium-risk
allow rule or clearly define authorization for necessary implementation steps.
This may bias decisions toward requiring explicit action-level authorization.
That is a hypothesis, not a measured model result.

## Public comparisons

- [Codex Guardian policy template](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/guardian/policy_template.md):
  separates intrinsic risk, authorization, and outcome. Its default thresholds
  allow low/medium-risk work, subject to explicit policy and injection exceptions;
  necessary implementations of requested operations can carry high authorization.
  It explicitly recognizes developer messages and AGENTS.md as trusted evidence.
  Its read-only investigation capability differs from Harness's tool-less review.
- [DeepSeek Harness approval guardian](https://github.com/karuboniru/dsh-approval-guardian):
  documents a previous always-denies defect caused by child-runtime restrictions
  leaking into reviewer context. It now suppresses those contexts for review and
  labels trusted human/instruction evidence separately. Harness's standalone
  prompt does not show that specific leakage path.
- [DSH auto-approve policy](https://github.com/xiuyuan18/dsh-auto-approve/blob/main/src/policy.js)
  and [implementation](https://github.com/xiuyuan18/dsh-auto-approve/blob/main/index.js):
  use a structured risk/authorization/outcome assessment. Its source discusses
  reasoning consuming the answer budget and making reviews fail closed. Harness
  inherits the selected preset unless a reviewer preset is configured; whether
  this contributes to actual timeouts is unverified.
- [Cline permission handling](https://github.com/cline/cline/blob/main/docs/sdk/guides/permission-handling.mdx):
  documents deterministic permission callbacks and tool-based auto-approval,
  rather than an equivalent model approval prompt.

## Evidence and next diagnostic

The follow-up [revamp plan](../plans/execution/2026-10-11-auto-approval-revamp.md)
incorporates the user's clarification: project AGENTS.md is untrusted for security
authorization. Seeing project guidance is useful; treating it as a human permission
grant is a different and unwanted behavior. The comparisons below were researched
by three read-only agents and checked against primary source artifacts. They do
not establish the behavior of any installed proprietary release.

`npx vitest run packages/auto-approval/src` passed all 25 tests in three files on
2026-10-11. These use scripted providers and verify plumbing, projection, and
parsing; they do not establish real-model decision quality. The full local check
was not run because this investigation changes documentation only.

Inspect a rejected call's durable approval reason and its model-usage-linked
`auto-approval` context build before changing behavior. Context builds store the
review request before model middleware/provider rendering, not the final wire
payload. A `review failed` reason points to execution/provider failure; a
`not exactly YES` reason exposes formatting failure; an ordinary justification
points to a model judgment. Check whether the authorizing human message and
applicable project instructions were represented, and whether the adapter honors
instructions (custom Responses providers already support `sendInstructionsAsSystem`
for backends that ignore top-level instructions).

Potential changes should preserve instruction provenance, retain bounded human
authorization across compaction, state routine-work allow criteria explicitly,
and distinguish technical review failures from substantive judgments. Do not copy
the main agent persona wholesale or loosen parsing before classifying failures.

## Detailed follow-up comparisons

### Codex

Official public source snapshot:
[`a07c8ebd57feedc4cf5dfe854c8e9101de54186b`](https://github.com/openai/codex/commit/a07c8ebd57feedc4cf5dfe854c8e9101de54186b).
Its [Guardian template](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/prompts/templates/guardian/policy_template.md)
trusts AGENTS.md alongside user/developer messages and question answers as
authorization evidence. That is broader than the Harness user's chosen trust
model. Authorization is separate from policy: critical risk and absolute denies
remain denied. Home deletion is not a literal fixed-path rule here; classifying
a populated home deletion as major irreversible destruction is an inference.

The [retention code](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/guardian-context/src/retained_instructions.rs)
keeps bounded original user instructions separately from compaction, marks
omissions, and avoids turning clipped restrictions into partial grants.
[Transcript records](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/guardian-context/src/transcript_record.rs)
carry source labels rather than trusting embedded text to establish roles.
The [assessment contract](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/ext/guardian-reviewer/src/assessment.rs)
is JSON risk/authorization/outcome/rationale;
[shared limits](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/ext/guardian-reviewer/src/lib.rs)
allow a 90-second deadline and up to three attempts. Those are implementation
comparisons, not evidence that Harness needs a longer deadline or retries.

[Official OpenAI guardrail guidance](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
also separates a reviewer from independently enforced boundaries and says API
applications do not automatically inherit Codex auto-review.

### Official DeepSeek Harness and community plugins

Official DSH at
[`d743267388641bc76f17c45ce8b4c231aed1d32c`](https://github.com/deepseek-ai/deepseek-harness/commit/d743267388641bc76f17c45ce8b4c231aed1d32c)
has an [approval answerer seam](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/interaction/user-approval/src/index.ts):
`never` rejects before answerers; `ask` dispatches. Reviewed source does not put an
LLM reviewer in that service itself. Its
[instruction framing](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/context/agent-instructions/src/render.ts)
puts system/developer/direct user instructions above workspace guidance.

The karuboniru plugin at
[`5cef6e92569222d438d39da317b5b86f4c0ccdbb`](https://github.com/karuboniru/dsh-approval-guardian/commit/5cef6e92569222d438d39da317b5b86f4c0ccdbb)
trusts recognized instruction-source entries as authorization, rather than
independently verifying that a human adopted each file. Its
[transcript collector](https://github.com/karuboniru/dsh-approval-guardian/blob/5cef6e92569222d438d39da317b5b86f4c0ccdbb/src/transcript.ts)
uses already-derived/compacted messages; it cannot restore lost human originals.
Its [policy](https://github.com/karuboniru/dsh-approval-guardian/blob/5cef6e92569222d438d39da317b5b86f4c0ccdbb/src/policy.ts)
retains absolute critical denial. Its README distinguishes technical unavailable
from valid deny and permits human fallback only for technical failure.

The xiuyuan plugin at
[`cb559e326c84c2c976e140b0910ab44880b7419a`](https://github.com/xiuyuan18/dsh-auto-approve/commit/cb559e326c84c2c976e140b0910ab44880b7419a)
intends to trust real humans only. Comparing its
[transcript renderer](https://github.com/xiuyuan18/dsh-auto-approve/blob/cb559e326c84c2c976e140b0910ab44880b7419a/src/transcript.js)
with official DSH instruction source kinds suggests a compatibility flaw: source
kind `agent-instructions` may be rendered as an ordinary user instead of a plugin.
This is a code-comparison inference, not a runtime reproduction. Its
[manual grant fingerprint](https://github.com/xiuyuan18/dsh-auto-approve/blob/cb559e326c84c2c976e140b0910ab44880b7419a/src/store.js)
omits actual tool arguments; it should not be copied as exact-action authorization.
Its failure conversion also counts technical failures toward a denial breaker.

### Pi core and extensions

The upstream repository now redirects to `earendil-works/pi`.
The stock [permission-gate example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts)
matches selected command patterns and asks a human. It does not consult AGENTS.md
or another model. The
[protected-paths example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/protected-paths.ts)
blocks selected write/edit paths without a human override, but is not comprehensive
shell protection. These examples are not an OS sandbox.

The third-party [pi-approve-for-me](https://github.com/JosiahEverson/pi-approve-for-me)
uses global configuration, exact action arguments, original active-branch human
messages even across compaction, and a structured model assessment. Its
[request construction](https://github.com/JosiahEverson/pi-approve-for-me/blob/main/src/index.ts)
does not explicitly project AGENTS.md. It documents that downstream extension
argument mutation can invalidate the reviewed action; Harness must preserve its
existing governed execution boundary.

[pi-auto-approval](https://github.com/Europa2061/pi-auto-approval) offers human
fallback and automatic blocking modes. Its limited raw-branch tail is useful
interaction evidence, not a recommended authorization-retention design.

### Claude Code

[Official permission documentation](https://code.claude.com/docs/en/permissions)
distinguishes model instructions from runtime permission enforcement.
[Auto-mode configuration](https://code.claude.com/docs/en/auto-mode-config)
allows managed/user/invocation policy, excluding project settings. Its classifier
sees CLAUDE.md guidance; hard-deny and soft-deny policy have different user override
semantics. [Permission modes](https://code.claude.com/docs/en/permission-modes)
document additional protection for removal of root, home, or the working directory,
requiring human interaction or denial rather than ordinary automatic approval.

## Design consequences

### Follow-up: inspection capability and retention

Codex's current public
[reviewer settings](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/ext/guardian-reviewer/src/settings.rs)
allow exec_command, write_stdin, view_image, exec, and wait. The host requires a
managed sandbox, intersects inherited permissions with read-only access, hides
additional permissions, and sets approval policy to Never. The reviewer prompt
forbids network and escalation. This is capability enforcement plus instructions,
not a promise that a shell command is read-only because the model says so.

The user proposed a narrower Harness reviewer: file reads and a temporary chat
without persisting that chat. The amended plan uses a bounded in-memory review
loop and a substrate-confined range-read capability; there is no shell or ordinary
child service conversation. Current ModelInvoker persists request context builds,
so ephemeral review requires an explicit retention contract change. Usage and
the final parent-call decision remain durable; intermediate read contents and
provider payloads do not. This intentionally removes full reviewer trace replay.
The plan also discards free-text model rationale, persisting a host-authored reason
category so the final explanation cannot save inspected content by quoting it.
Initial scope is workspace-only; outside-read grants are not an existing capability.
Remote provider retention is a separate policy, not controlled by local memory.

Existing ReadFileTool reads the full file before clipping its model-facing output;
it is not suitable as-is for an IO-bounded reviewer. ExecutionContext already has
range reads, but local read loads the full file before slicing, has no cancellation
signal, and is unconfined. Required IO is a backend-owned confined/cancellable
regular-file range read; byte limits alone cannot prevent FIFO/device hangs.
Public subagent presets also permit shell
commands by instruction and create normal child conversations; they are not the
chosen temporary file-only reviewer boundary.

The useful common pattern is separation of enforcement, authorization, and
implementation evidence, not automatic trust of project files. Harness should
retain the original provenance of global versus project settings before merging;
the final instruction string alone cannot establish that a human authored it.
Preserve real human evidence across compaction without duplicating conversation
truth. Keep risk decisions separate from technical unavailability. Retain bounded
records and explicit omissions instead of promoting summaries into authorization.

Current Harness `allow` rules skip model review, and project settings can configure
permission effects. The proposed ask-path revamp does not establish universal
policy enforcement against arbitrary project configuration. Treat that separate
ownership limitation explicitly; do not imply that improved prompt trust creates
a sandbox or makes every operation pass through a reviewer.
