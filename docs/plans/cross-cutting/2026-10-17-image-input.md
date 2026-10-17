# Image input v1

Status: Complete — released in v0.4.0

## Scope and completion

Implement only the user's five requirements: desktop image paste/drop; images
stored inline in the conversation log; desktop previews and a full-app darkened
viewer with a top-right close button; MCP image results and image reads through
existing file tools; image request transformations for every existing provider
transport. No upload service, blob lifecycle, image generation, resizing, OCR,
image captioning, new CLI attachment workflow, or new provider abstraction.

## Grounded design

Extend the existing ContentBlock union with an inline image carrying mediaType
and base64 data. PNG/JPEG/GIF/WebP share the same content block across messages,
tool results, persistence and public RPC. Existing JSON item bodies need no
SQLite migration. Desktop passes image bytes rather than client filesystem paths.
A two-MiB decoded image budget per content/message bounds base64 below the existing
four-MiB RPC frame. Validate untrusted image input once at ingestion; preserve
valid blocks through output truncation and code-mode bridges.

Existing text delivery gains optional images; existing pending previews append an
image-count text marker, not repeated image payloads. Existing item history/chunking remains.
The transcript reducer retains images rather than discarding nontext. Desktop
owns previews/viewer/draft interactions; core has no presentation or vendor logic.
File reads stay behind ExecutionContext; its existing ranged read must actually
bound local I/O. Both file-tool dialects use a small shared image-read branch.

Provider adapters serialize native image tool results for OpenAI Responses,
Anthropic, and Gemini 3. Chat Completions, Mistral Conversations, and older Gemini
use adapter-only attributed image messages after complete tool-result batches.
Canonical history is never rewritten for vendor restrictions. Existing opaque
provider history, cancellation and cache-stable text requests remain intact.
Existing capability declarations represent adapter support. Model catalogs and
existing per-model configuration carry supportsImages metadata without a new
registry.

## Milestones and checks

- [x] Content/wire/runtime: canonical image schema and bounded input, image-only
      delivery, inline persistence/reconnect, capability failure, pending counts,
      and code-mode images without text-output regressions.
- [x] File/MCP ingestion: bounded reads, both file dialects, native MCP image
      mapping, explicit invalid/oversize failures; preserve text behavior.
- [x] Providers: all existing adapter families pass native/fallback image request
      tests, including parallel result ordering and normal text compatibility.
- [x] Desktop: paste/drop/image-only send, safe captured drafts, message/tool
      previews, full-app accessible closeable viewer; representative browser tests.
- [x] Review and finish: independent correctness, architecture/simplicity and
      evidence/scope review; focused tests plus npm run check; synchronize docs.

## Research and coordination

Researchers inspect actual pinned SDKs and current primary vendor documentation;
issue #39 is not authoritative architecture. All work shares the main checkout.
Provider researcher owns adapters; I/O researcher owns workspace/MCP and the
necessary local ranged-read fix; UI agent owns desktop. Primary owns protocol, core, public client/service integration, reducer/CLI
placeholder and documentation. I/O researcher also integrates code-mode/output
budgets; provider researcher adds public-boundary persistence tests. Native desktop/remote-host qualification must be stated separately
from browser and adapter request fixtures.

## Evidence

Initial checkout was clean at 0be287d (v0.3.0). Implementation is complete in the
shared main checkout; no commit or release was made for this image delivery.

Focused evidence: provider suites 390 passed/11 skipped; file/execution/MCP 56
passed/1 skipped; code-mode/output/MCP 43 passed; public protocol/client/service
regressions and auto-approval 41 passed; desktop image/reducer units 37 passed;
Chromium's four image scenarios and four existing text-composer/fork scenarios
passed (8/8). These overlap and are not a total count.
Public tests cover SQLite close/reopen and reconnect, including chunked large
history; max-sized image notification races an attach snapshot successfully.

Three independent review lenses covered correctness, architecture/simplicity and
evidence/scope. Findings fixed: context estimator counted base64 as text; batch
FileReaders allocated before aggregate validation; pending-attach buffer was
smaller than a valid image event; encoded overhead from many tiny images required
the existing wire budget at ingestion. Documentation claims narrowed to verified
viewer close-button behavior. No extra image framework or provider registry added.
Final `VITEST_MAX_WORKERS=4 npm run check` passed: root/CLI/desktop typechecks,
ESLint, Prettier, and 1,557 tests passed / 41 skipped across 175 files.
`git diff --check` passed. Native clipboard/drop, remote execution and live vendor
acceptance are not established by fixtures.

Image arrays also have a 3 MiB serialized limit, including JSON overhead, so
many tiny images cannot exceed the existing 4 MiB transport frame.

## Model metadata follow-up

User requested clean model-level image metadata across existing providers and
explicitly chose to allow model switches, validating the next request. Compaction
keeps its existing behavior; model-backed summaries can describe image content.
No switch-time history scan, image cache, stripping, probing, or automatic
compaction is introduced.

Keep adapter contentTypes as serialization support. Add optional
ModelInfo.supportsImages (wire boolean/null), preserving explicit false and unknown.
Core checks the same predicate for new image delivery and the final effective
provider request. A known text-only model rejects images; unknown metadata remains
permissive and vendor validation remains authoritative. Switching itself succeeds;
image-bearing active context then fails clearly without changing the log. Existing
compaction boundaries naturally remove prior images from subsequent requests.

- [x] Provider evidence and mappings: Mistral vision, Models.dev input modalities,
      and LiteLLM supports_vision. The initial Anthropic API overlay and unknown
      classifications were superseded by the completeness audit below, which
      uses maintained/documented model facts and requested custom configuration.
- [x] Shared protocol/service/client field preserves true, false and unknown.
- [x] Request-boundary and public switching regressions, including summary boundary.
- [x] Independent review, synchronized docs and full check.

Metadata follow-up validation: `VITEST_MAX_WORKERS=4 npm run check` passed all
root/CLI/desktop typechecks, lint, formatting and 1,568 tests / 41 skipped across
176 files. Three independent read-only review lenses found no remaining blockers;
focused independent metadata/wire/switch runs passed 130 tests / 6 skipped.
The public switch test waits for the actual terminal RPC notification rather than
assuming service idle implies client delivery. Model-setting test writes stay in
its temporary home. Generated protocol schema includes nullable supportsImages.
Metadata mappings use pinned SDKs and primary APIs; live account-specific capability
responses and live image summarization remain unqualified. No commit/release made.

## Completeness and simplicity audit

User challenged unknown claims for known Codex/OpenAI/Gemini models and requested
configurable custom-model modality metadata plus an overall research audit.
The earlier metadata follow-up treated missing API flags as missing knowledge;
that was incomplete for already-maintained catalogs. The audit corrects it:

- [x] Official OpenAI model/vision docs establish image support for maintained
      roster entries; share that metadata with Codex and test authenticated Codex
      Responses user/tool-image serialization through the actual SDK.
- [x] Official Gemini docs establish general-model image support; exclude the
      documented audio-only/non-tool Transcribe model in the existing filter.
- [x] Existing custom model metadata gets optional supportsImages, including
      Mistral/LiteLLM overrides, retaining false/unknown and existing precedence.
- [x] Simplify Anthropic: use documented support in its existing three-model
      catalog; remove the newly added metadata API requests/cache/error paths.
      LiteLLM also reuses existing profile merging instead of duplicate metadata.
- [x] Recheck original five outcomes and metadata/config/switch behavior through
      independent review, focused regressions and full validation; synchronize docs.

Audit sources are linked in the owning models subsystem. Read-only end-to-end
review found no additional blockers in GUI/log/reconnect/file/MCP/code-mode or
context/switch ownership. Provider wire review found no additional mapping issues.
Model-backed compaction remains unchanged as explicitly accepted by the user.
No external catalog service, probing, image cache, automatic compaction or media
manager is introduced. Native/live-vendor qualification limitations remain.

Final completeness audit: three independent read-only lenses found only stale
metadata documentation; the models table, testing guidance and historical plan
claims are corrected. No further implementation blockers were identified.
`VITEST_MAX_WORKERS=4 npm run check` passed typecheck, lint, formatting and
1,575 tests / 41 skipped across 176 files. Provider suites passed 404 / 11 skipped;
custom/configuration suites passed 160 / 1 skipped; authenticated Codex/OpenAI
focused tests passed 21. These focused counts overlap the full suite.
Final `git diff --check` and formatting of updated documentation passed.
Native paste/drop, remote-host image reads, actual image-derived compaction and
live vendor/account acceptance remain explicitly unqualified. Delivery is complete in the shared main checkout. The authorized commit covers
image input, model metadata/configuration and the associated tests/documentation;
no release is part of this commit request.

## Native input correction

User testing disproved the desktop input completion claim: on Linux, pasting a
copied screenshot file inserts a path, and file drag/drop does not attach it.
Synthetic browser events created File objects and bypassed the OS/WebView
boundary; those tests did not establish requirement 1. Native paste/drop was therefore reopened as a required correction. The earlier implementation was committed as 8297f20;
the follow-up below fixes and qualifies the native Linux path before committing.

- [x] Controlled Linux clipboard/file-drag reproduction through real WebKitGTK,
      distinguishing plain-text paths, file URIs and screenshot bitmap data.
- [x] Minimal desktop ingestion correction using existing attachment pipeline;
      client paths must never be treated as remote server paths.
- [x] Explicit paperclip chooser immediately before the model control, as requested.
- [x] Fix independently reproduced mixed custom/function replay ordering in
      Anthropic/Chat adapters; keep valid existing request shapes and log intact.
- [x] Real native input evidence, focused regressions, full checks, independent
      review and authorized follow-up commit. Synthetic tests alone cannot close
      the native-input task.

Native correction evidence: actual rebuilt Harness in an isolated Linux X11/
WebKitGTK session passes GNOME copied-file paste, PNG bitmap, JPEG-only clipboard,
normal text/URL preservation, native file drop over the transcript, native
paperclip chooser, Send, five user-message previews, five persisted SQLite image
blocks and five model request images without local paths. The repeatable scripts
are tests/native/linux-images.py and linux-image-inspector.mjs; full commands and
qualification boundaries are in docs/TESTING.md. Clipboard support uses GTK on
Linux and clipboard-rs on Windows/macOS; no fake platform implementation.

Additional review findings fixed: clipboard image MIME negotiation instead of
PNG-only reads; one observable router draft owner instead of stale component
image/loading/error copies; mixed raw/native tool replay and hoisted context
preserving required tool-result adjacency. Real GTK and browser navigation
regressions accompany these corrections. Wayland and native Windows/macOS have
not been exercised. Final `VITEST_MAX_WORKERS=4 npm run check` passed typecheck,
lint, formatting and 1,600 tests / 41 skipped across 176 files. The final three
browser regressions (chooser placement, navigation during image reads, and
attachments added during delivery) passed. Native Rust checks passed eight tests
with the display-dependent GTK regression separately passing under Xvfb. Three
independent review lenses have no remaining blockers. The authorized follow-up
commit includes these corrections and retained native evidence; no release is
part of this correction.

## Browser-first simplification

The user requests normal browser APIs, removal of unproven native clipboard
branches, and maximum simplification. Keep the existing DOM File input as the
primary path. Do not infer platform failures from a Linux WebKitGTK reproduction.

- [x] Compare standard synchronous paste and asynchronous clipboard reads in an
      isolated real WebKitGTK session before retaining a Linux fallback.
- [x] Remove unnecessary native clipboard code and dependencies; retain native
      file-drop integration only against existing reproduced evidence.
- [x] Verify browser behavior, actual Linux input, focused native checks, full
      repository validation, and independent simplicity/correctness review.
- [x] Synchronize current documentation and commit the validated correction.

Browser-first audit findings and resolution:

- Actual trusted Ctrl-V in WebKitGTK 2.52.6, without clipboard preference
  overrides, exposes PNG blobs and file-URI-list blobs through
  navigator.clipboard.read(). The original investigation missed this API.
  Removed all native clipboard readers, platform branches, GTK/clipboard-rs
  direct dependencies, the clipboard command and permission.
- File URI blobs cannot be fetched as image bytes by that WebView. Reuse the
  existing bounded local file reader; parse URIs there with Tauri's URL type.
  Collapse its now-single-consumer encoder into the bounded read loop instead
  of buffering/revalidating a second batch.
- Genuine external drop exposes no Files, getData URI, getAsString URI,
  getAsFile, or webkitGetAsEntry. getAsFileSystemHandle is unavailable. Keep
  the Tauri drop event; do not scrape paths out of HTML representations.
- Browser reads enforce the aggregate image limit incrementally, propagate
  permission errors, and report unreadable image representations. Raw JPEG-only
  native clipboard data is not exposed by this WebView; the regression checks
  an explicit error and preserved drafts, followed by successful copied JPEG
  file paste. This replaces an invented native-MIME acceptance expectation,
  not the requested JPEG file support.
- Remove the approval deadline fixture's private 12-byte-probe timing special
  case. Uniform read latency now checks multiple iterations sharing one signal,
  one 100ms deadline and a timed-out denial, rather than an incidental call count.
- Independent desktop/native/lifecycle, provider/backend/metadata, and
  tests/evidence/scope audits covered both image commits and this correction.
  Provider wire mappings, model metadata and admission/request checks retain
  distinct required contracts; no speculative provider abstraction remains.
  Remove obsolete current documentation instead of layering more platform code.

Verification: six focused Chromium cases pass, including actual browser clipboard
write and keyboard paste without Tauri APIs. Thirty focused helper/deadline tests
pass. The native desktop builds; three remaining file-reader tests pass. The
rebuilt actual Linux X11 app passes controlled copied PNG/JPEG file-URI and PNG
bitmap paste, explicit JPEG-only error, ordinary text/URL paste, actual drop and
chooser, and five-image send/store/model delivery without paths in the payload.
The first full check passed typecheck/lint/format but had an unexplained Vitest
worker exit (1591 passed, 41 skipped); its log is
/tmp/harness-image-simplification-check.log. An unchanged verbose diagnostic run
passed all 1605 tests / 41 skipped. No assertion/timeouts were changed in response
to that worker exit; its cause remains undetermined. Final complete
`VITEST_MAX_WORKERS=4 npm run check` passes typecheck, lint, formatting and all
1,605 tests / 41 skipped across 176 files. All retained native/browser behavior
and audit findings above are verified. The authorized cleanup commit contains
these removals and updated regressions; no release or push is included.

Primary browser contract: https://webkit.org/blog/10855/async-clipboard-api/
explains image/png and text/uri-list representations and direct paste-gesture
access. MacOS/Windows native execution and Wayland remain unqualified; this audit
does not infer failures there from Linux observations.

## Follow-up review fixes

Scope is limited to the three accepted findings: browser image type detection,
native test byte fidelity, and redundant validation of file-tool generated base64.

- [x] Reuse existing signature conversion for browser files, including empty and
      generic browser MIME types; exercise actual browser FileReader.
- [x] Assert generated file bytes, screenshot pixels and persisted/model payload
      equality in the existing actual Linux test, keeping its count/path checks.
- [x] Replace generated-base64 schema validation with a raw signature comparison;
      preserve size and changed-file rejection through public file-tool tests.
- [x] Run focused/browser/native/full checks, review the diff, synchronize evidence
      and commit the scoped changes.

Focused verification: 46 helper/workspace tests and eight Chromium browser cases
pass. The existing native Linux scenario passes exact known-file dataURLs,
screenshot PNG dimensions/pixels and exact persisted/model payload equality.
Independent product review reconfirmed all three original MIME cases preserve
identical canonical PNG bytes. User additionally authorizes push and a minor
release after the scoped fixes are validated and committed; use the existing
manual release workflow, without local version-bump machinery.

Final review-fix validation: full `npm run check` passes typecheck, lint, formatting
and 1,606 tests / 41 skipped. Three independent final review lenses found no
remaining blockers. Browser/native payload evidence above passed; no native
clipboard code, image conversion service or new abstraction was added.

- [x] Push the validated commits and dispatch the existing minor release workflow.
- [x] Verify all platform builds and signed draft assembly, publish the minor
      release, and record its run/tag evidence.

Minor release run 39058583284 created tag v0.4.0 at 25e98d9 after its source
check passed. Parallel Linux CI passed. Windows CI run 39058571579 exposed two
existing question-overlay tests expecting Unix pointer/check symbols; actual
Windows output used the installed figures package's documented fallback symbols
(> and √). Fix only those four marker assertions using the same cross-platform
regex convention as existing host tests. Interaction/answer assertions remain
unchanged; require new hosted Windows CI before publishing. Platform builds
continue from the tagged source; this correction changes tests only.

Release completion: [v0.4.0](https://github.com/usatiuk/harness/releases/tag/v0.4.0)
is published as latest with 19 assets. Image review fixes are committed as
338bf9b; the workflow's version bump/tag is 25e98d9. Test-only Windows symbol
correction d0e5418 passes [hosted CI](https://github.com/usatiuk/harness/actions/runs/39059007719):
Windows 1,594 passed / 53 skipped; Ubuntu 1,603 passed / 44 skipped.
[Release run 39058583284](https://github.com/usatiuk/harness/actions/runs/39058583284)
passes the source gate, all Windows/Linux/macOS builds and signed assembly.
Downloaded draft metadata and anonymous published manifest/signature/update-feed
downloads pass the production native signature verifier, report version 0.4.0,
and contain all three expected platform entries. Local direct Node fetch timed
out; the required external-network curl retry completed successfully.
All test-owned native resources were cleaned; the pre-existing Vite listener was
left untouched. Platform build results do not expand the recorded native UI
qualification beyond the actual Linux X11 test.
