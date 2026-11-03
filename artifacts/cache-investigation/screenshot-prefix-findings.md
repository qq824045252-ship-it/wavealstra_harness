# Screenshot history and prompt prefix audit (2026-11-03)

## Confirmed defect and change

The SerialPortTool conversation used the accepted MyBuddy 0.1.72 package,
including the earlier canonical-user anchor fix in `EphemeralContextProjection`.
That fix was present; this was a different context writer.

`createBuiltinCapabilityExtension` applied `ageToolResultImages(messages, 2)`
before every request. On the third image-bearing tool result it replaced an
earlier image with text. The saved session was immutable, but the provider input
was not. Each further screenshot moved that replacement boundary again.

The fix removes that context hook and its aging implementation. Pi's existing
tool-result normalization and native context compaction own the image lifecycle.
Ordinary continuations retain their earlier images; native compaction can retire
older context at an explicit compaction boundary. Model image/request-size
admission checks remain in place. This increases retained images and request
bytes between compactions; it does not promise unlimited images or 100% cache hits.

## Evidence and regression

An offline reconstruction of the 81 saved provider responses using the aging
function extracted from the running package found 19 changed historical input
prefixes. Without aging, the canonical history's serialized input had no such
changes. The affected responses included the observed 30% and 75% cache dips.
This reconstruction excludes request-only capsules and gateway transformations;
it does not establish the server's exact KV-cache behavior or explain the
separate zero-cache fifth request. Private transcript content is not committed.

`pnpm -s test:tool-image-aging` now exercises the actual builtin/conversation/
projection extensions together in the installed Pi loop, and captures the real
Responses serializer before network dispatch. It compares the entire preceding
input prefix, plus non-input fields (including tools/cache key), on each
continuation. The old implementation failed when the third tool screenshot
arrived; the new implementation passes 21 requests with 18 screenshot results,
two user image attachments, two user turns, and continued execution after a
real native compaction. Compaction reduces images in model context while
preserving the original tool entries. No actual desktop actions or credentials
are involved in this fixture.

The old screenshot test only checked newest-two retention and saved-history
immutability. That contract did not detect provider-input rewrites.

## Other request writers audited

| Owner/path | Finding |
| --- | --- |
| `EphemeralContextProjection` | Same-user tool loops reuse one capsule at a fixed canonical-user anchor. New user/execution, model/scope or revocation boundaries intentionally reset/reject it. Capsules are request-only; replacing/removing the prior capsule can reduce cross-user-turn reuse even when ordinary tool continuations are stable. Preserving revoked private evidence for cache reuse is not acceptable. |
| `conversation-runtime-extension` / `LegacyExecutionControlHistory` | Deterministic mapping of retired custom records; ordinary appended images/results do not change previous projections. Included in the new integration fixture. |
| `LegacyMemorySummaryRecovery` | Old contaminated summaries may be rebuilt before prompting/navigation, with an explicit native checkpoint. This is a history-repair boundary, not a per-tool sliding window. |
| `PromptAssembly`, `RuntimeAssemblyFingerprint`, `AgentService` | Prompt, skills and tool selection are assembled at session creation/recreation. Configuration, project, permissions and resource changes may intentionally change the request. No per-request clock/random text was found in this assembly path. |
| `ModelInvocationAdmission` / `request-transport.mjs` | Validate model/scope/image limits and byte count; do not trim history or rotate the cache key. Configuration changes are rejected rather than silently swapped during an invocation. |
| Magpie provider | Passes context/options to native Pi providers; no local history rewriting or random cache key. Gateway/server behavior is outside this source audit. |
| Command Code provider | Deterministic model-specific request normalization and output-limit policy; does not introduce a moving history window. |
| Native Pi Responses serializer | Cache key derives from session ID unless caching is explicitly disabled. Same-session non-input fields are checked in the regression fixture. New sessions, model/provider switches and cache settings are separate boundaries. |
| Native Pi images/compaction | Images normalize when accepted; compaction/retry/navigation may rebuild effective history. Existing compaction tests cover automatic thresholds, cancellation/failure and resumed execution. These boundaries are intentionally retained. |
| Subagent worker | Uses the same capsule implementation with no supplemental evidence, and native CLI loader/request serialization. No screenshot-aging hook exists in the worker. |

No second per-tool sliding-history writer was found in the inspected product
paths. This is a bounded source/runtime audit, not a claim about all upstream
cache eviction, account routing, external MCP schema changes or every provider.

## Release validation

See the scoped release commit and local `out/diagnostics/serial-cache/` reports
for typecheck, headless gate, packaged-payload and actual packaged startup
results. Provider hit-rate improvement must be measured on new real requests;
existing usage records remain historical and are not rewritten by this fix.
