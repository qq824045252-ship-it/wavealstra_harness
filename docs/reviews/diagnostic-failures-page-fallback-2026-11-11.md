# Actual diagnostic failure review and page-answer source recovery

## Read-only evidence

Vivion's current app database: 22 task rows, 1,122 model-request diagnostics,
1,451 task tool diagnostics and 31 scoped tool diagnostics. There are 73 + 6
failed tool records. All 79 were matched to their original durable tool-result
records. No duplicate `(taskId, callId)` was present. These counts are historical
calls, not 79 failed user goals; retries and later success require separate review.
Model requests: 1,117 completed, four interrupted, one aborted.

Failure codes: 34 invalid_arguments, 27 exit_code, 13 no diagnostic code, four
tool_error, one blocked. 33 argument failures contain concatenated complete JSON
objects. Their origin is investigated separately; persisted messages alone do not
prove which upstream streaming event caused the concatenation. Other errors include
five empty page-answer responses, three attempts to use local file URLs with the
HTTP-only browser tool, Windows command backend limitations, file-write denial,
missing commands, script errors, and command nonzero exits (including searches with
no match). These must not all be described as authorization failures.

## Fixed here

`fetch_content(mode="answer")` previously stored a successfully fetched page but
returned only a synthesis error if the answer model failed. The caller lost its
visible source evidence and could waste another fetch/model call to recover it.

On answer failure, return a bounded 4,000-character **untrusted source preview**,
source URL and the existing `get_search_content` response/URL index/offset. Retain
`isError=true`, `successful=0`, the original error, and explicit `answerStatus=failed`.
No manufactured answer, automatic retry, access-policy bypass, changed model budget,
or production-data edit. Empty, aborted, and failed fetches do not qualify. Multi-URL
errors provide the correct per-source continuation index too.

## Verification

- `test:web-access-capability`: 33 checks, including seven source-fallback behaviors.
- `test:web-access-extract-runtime`: real registered fetch tool and stored-content
  retrieval with isolated config and deterministic HTTP fixture; answer-model failure
  preserves source content and remains an error. No model or network inference used.
- Typecheck: pass.
- No full-suite run for this narrow change; no production restart or UI/live-model claim.
