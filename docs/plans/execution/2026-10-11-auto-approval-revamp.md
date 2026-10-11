# A smaller, better auto approver

Status: Implemented and locally validated. The simplification uses the normal
file-read tool and normal model invocation. Independent reviews and live evidence
are recorded below. The user reports GPT 5.6 Luna works correctly; model judgment
is not guaranteed, and further live testing requires explicit user approval.

## What changes

Give the existing approver useful context and let it read a file when that would
resolve uncertainty. Keep exactly `YES` to approve, or `NO` followed by a short
reason to deny. Keep existing approval routing, model selection, annotations,
and human-only rules. No structured verdict, scores, reason categories, new
framework, or saved reviewer conversation.

The reviewer gets the relevant conversation, exact proposed call, and available
settings/project guidance. Core exposes existing context-source instructions to
request middleware because conversation items alone omit initial AGENTS.md.
Label this guidance as evidence, not human permission. Project instructions,
assistant messages, summaries, and tool output cannot override direct user
restrictions or authorize unrelated destructive actions. The policy is general, not coding-only: approve by default, and deny only direct
user restrictions or concrete unauthorized dangerous/sensitive effects. Necessity,
usefulness, efficiency, and task scope alone are not denial grounds.

## Use the existing read tool

Offer the normal `ReadFileTool` from the workspace package. Reuse its schema,
description, line windows (`path`, zero-based `offset`, and `limit`), output
bounds, and execution backend. Execute only this tool in the review loop; do not
send reviewer calls through the ordinary dispatcher or offer shell, writes,
network, MCP, delegation, or escalation.

No separate file reader, child script, execution API, path-policy framework, or
container lifecycle is added. Relative paths resolve from the workspace; the
normal local backend also accepts absolute paths and `..`, and Docker reads use
the container filesystem. This tool is workspace-rooted, not a new workspace-only
security boundary. Its contents remain untrusted evidence.

Keep normal read behavior: it reads the complete file before returning a bounded
line window. The reviewer does not gain a stronger special-file, allocation, or
physical IO-cancellation guarantee than the existing tool.

## The temporary conversation

One approval request owns an in-memory array of model items:

1. Build review context and offer the normal read tool.
2. Invoke through the existing model invoker.
3. Validate any read calls with the existing tool schema, execute them, append
   calls/results and native provider payloads to the temporary array, and invoke
   again.
4. Parse a final verdict only from a completed response with no tool calls.
5. Discard the array when review finishes or is cancelled.

`YES` alongside a read call is not final approval. Unsupported or malformed tool
batches do no IO. Preserve provider-native payloads needed for continuation.
This stays in the approval plugin; no second agent engine or service conversation
is created.

Use one configurable review timeout, default 30 seconds, exposed in the existing
auto-approval settings. The same cancellation signal covers every model call and
read. No step/read count cap, cumulative work quota, or new model-byte limiter.
Model calls retain their normal provider limits and cancellation behavior.

When review expires or the parent is cancelled, stop waiting for a normal read.
The underlying backend read may still complete; the existing read API cannot
forcibly cancel local file IO. Do not add subprocess machinery to change that.
Timeout/model failures use the existing denial path. Parent cancellation remains
an interruption.

## What is saved

Use one internal model-invoker option to skip reviewer context-build persistence.
Other invocations keep their normal retention. Every review invocation records
existing usage/cost against the parent turn, including unknown usage where the
provider does not report it.

Keep the final approval annotation: decision, reviewer model, and denial reason
when present. Save no reviewer conversation, intermediate messages/reasoning,
read results, or temporary native payloads. The short final denial reason may
contain information derived from inspection.

## Delivery checklist

- [x] Supply clearly labeled existing guidance and improve the routine-work prompt.
      Check: the short policy defaults to approval without a necessity gate;
      context projection includes project guidance without representing it
      as direct user authorization. Actual model judgment needs live qualification.
- [x] Reuse the normal read tool without backend changes.
      Check: reviewer schema matches the existing tool and a multiline fixture
      proves nonzero line offsets and limits.
- [x] Add the temporary loop, configurable timeout, and ephemeral invocation option.
      Check: mixed verdict/read responses wait; many reads have no count cap;
      timeout covers model/read waiting; payloads stay temporary and usage remains
      on the parent. Depends on the context and ordinary read-tool wiring.
- [x] Validate, independently review, and update durable documentation.
      Check: public service regressions and the complete local check pass. Record
      unverified real-model judgment explicitly rather than claiming proof.

## Evidence and limits

See [testing evidence](../../TESTING.md#auto-approval-inspection) for final check
counts and the desktop timeout-setting browser test. Public service regressions
use real temporary files with scripted providers: file-dependent verdicts, line
windows, 20 reads/21 review invocations, mixed YES/read responses, opaque payload
continuation, parent interruption, timeout, non-persistence, and parent usage.
Clock-controlled tests cover the single deadline and a pending ordinary read.
The complete `npm run check -- --maxWorkers=2` passes: 1,274 tests passed, 38
skipped, plus TypeScript, ESLint, and formatting. All three reviewers confirmed
the final fixes without remaining blockers.

The second independent review explicitly challenged simplicity and unrequested
features. It removed the custom inspection backend and generic model-byte limiter.
It retained the small instructions projection and ephemeral context option as
necessary existing-owner boundaries. Ordinary execution backends are unchanged.

Live investigation established a model-specific policy-adherence failure. Eight
explicitly approved Mistral calls returned YES, but the fixtures did not exactly
reproduce the actual context and provider defaults. A subsequent user-initiated
retry was captured at the real reviewer's decision boundary: the current policy
and seven projected items accompanied `find /home/stepus53/projects/harness
-maxdepth 2 -name "*.md" | head -30`. The answer was `NO` with “Unnecessary for
reviewing the project based on provided documentation,” directly contradicting
the policy. The context contained the user question, two read calls, README/PLAN
results, supplied guidance, and the proposed call, with no prior denial or direct
user restriction. This rules out stale policy and parser errors for that failure.

The user subsequently reported GPT 5.6 Luna works correctly as the reviewer.
This is manual acceptance, not automated model qualification. Three independent
reassessments found no demonstrated plumbing defect; no model-specific guards,
retries, command allowlists, or default-model changes were introduced. Temporary
debugging was removed and no reviewer context was persisted. Further live calls
require explicit user approval. Scripted tests establish plumbing, not model
judgment or prompt-injection resistance. Existing compaction can omit earlier
authorization; this increment does not redesign history selection.

[Research and public implementation comparisons](../../research/2026-10-11-auto-approval-context.md)
remain background. Broader provenance, policy matrices, whole-history retention,
structured decisions, diagnostics, and recovery frameworks are outside scope.
