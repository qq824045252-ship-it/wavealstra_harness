# Context summary length failure repair (2026-11-12)

## Observed incident
The affected ordinary-task durable context document recorded two automatic `growth` failures at estimated 122,348 and 123,528 input tokens. Both reported `摘要模型没有返回有效摘要（length）`; committed folds and compressed tokens remained zero. The real settings selected billion-context, ratio 0.8 and absolute pressure threshold 500,000. That threshold was not a hardcoded 500K default and did not disable growth-triggered maintenance.

## Fix
- Replace the fixed summary output limit of 1,500 with a budget derived from the resolved model's declared output/context limits, estimated full summary input, safety margin, and reasoning capability. Missing output metadata uses an explicit conservative fallback.
- Reserve model-appropriate output space when chunking summary input. Never send input plus requested output above the modeled context bound.
- Retry only `length`, at most three requests for one chunk, increasing within the model and request ceiling. Never accept truncated content, feed it back as history, or replay business tools. Non-length errors and cancellation retain existing failure semantics. The final failure records reason, budget, attempt count, and preservation of originals.
- Surface detailed durable lastError instead of masking it with a generic failure message. Explain that the displayed pressure threshold coexists with earlier layered maintenance.

## Targeted evidence
- `test:durable-summary-budget`: 20 model-window/output-ceiling combinations; input-dependent budgets; unknown metadata; production manager retry recovery, bounded exhaustion, no repeated retry at ceiling, non-length failure and truncated-content rejection.
- `test:durable-context-safety`: all 9 behavior groups passed.
- `test:durable-context-operations`: production Runtime and real durable storage; new length→success and exhausted-length persistence/reopen/original-retrieval cases passed; existing cancellation, stale revisions, storage faults and four real process-kill recovery boundaries passed.
- `test:durable-context-window-matrix`: all window/setting/switch/native-child cases passed.
- Final typecheck (web, node and scripts with zero added errors), test-classification audit and diff check passed.
- `test:durable-context-management` and `test:durable-context-active-view` passed (production automatic maintenance, originals retrieval, cold reopen, media, queued input and cancellation).

Windows esbuild could not write output directly in the isolated checkout. Verification used the same entrypoints/options with esbuild `write:false`, Node output writes and the existing `test-guard`; no assertions or suite logic were bypassed. The user's working directory, live profile and running app were not modified.

## Boundaries
Six real `auto/deepseek-v4.1-flash` summary requests through local Magpie and the production callSummarizer method passed across code debugging, scheduling, research, document delivery, data analysis and project handoff materials. Synthetic input only; all retained their case identifiers and ended with stop. Requested adaptive limits were 6,558–6,684; provider reported 4,716–5,796 prompt tokens and 157–374 completion tokens. Those calls did not reproduce truncation; length recovery itself is covered by deterministic fault injection and real durable storage above. A thin test transport adapted OpenAI JSON to the summary port; this was NOT the complete Runtime/provider wrapper or Electron UI. Model policy metadata used a conservative 1,048,000 window / 328,000 output ceiling.

The six-task Electron acceptance ran concurrently in another isolated checkout by coordination, so observed 3.1–4.0 second latencies are not standalone performance measurements. No Electron re-acceptance of this repair yet; that separate fixed-version run is not evidence for the new repair. No build, packaging, application restart or model-window inflation. Bounded retries cannot guarantee an uncooperative provider returns a valid summary; exhaustion remains a truthful failure with originals intact.
