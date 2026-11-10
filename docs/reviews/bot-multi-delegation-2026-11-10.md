# Six mixed Bot delegations: real-model desktop-session validation

Baseline: `7ad5b45759f504ab110dee0eaf43ca2beddb9a2d` on Omarchy. Isolated clone and temporary HOME; no production profile edits, crash injection, packaging, or WorkService split.

## Reproduction

`pnpm -s test:bot-frontdoor:live --multi-delegation`

Uses `pnpm dev`, Electron's rendered UI via CDP, and the actual local gateway model `opendesign/deepseek-v4.1-flash`. This is not a mocked LLM run or a claim about native desktop input injection. The existing fixture transparently records upstream request intervals and captures UI screenshots. The scenario explicitly authorizes workspace-file access in its isolated profile.

## Assertions

Six independently submitted messages without waiting for previous answers:

1. Arithmetic: 137 × 29 = 3973.
2. Translation: 苹果 → apple.
3. JSON extraction: 林晓, 27.
4. Native once Work: write a uniquely named text file and read it back.
5. Native once Work: compute sales total 184, write JSON and read it back.
6. Native once Work: a kitchen/desk/bedroom plan.

The scenario checks individual request IDs, original-message-to-Work links, returned result ownership, exactly three Work records, each `closed/succeeded`, and actual file contents independently of model claims. Upstream request intervals must overlap across separate foreground request IDs. It checks task titles in the rendered conversation and screenshots at 1280 and 390 px with no horizontal overflow.

## Observations

First run: six accepted messages in approximately 1.5 seconds, with three running and three queued immediately after submission. All six answers were correct; all three Work results returned and closed successfully. This demonstrates bounded concurrency, not six simultaneous model calls or unlimited capacity.

One result-consolidation call returned prose instead of JSON. The app delivered the actual file evidence as fallback and retried consolidation successfully without rerunning the business task. Therefore this run is **not** a claim of zero internal errors. Expanded original records still contain additional verbose evidence; the successful title attribution does not establish that every long-report layout is ideal.

## Limits

Six mixed requests include only three native Work executions. No large-load test, long-running watch, multi-Bot/team collaboration, provider failure injection, application-crash recovery, or production-profile migration is claimed. The direct answers are local reasoning tasks, not network-search coverage. Per-task result identity is checked, but every possible task-monitor interaction is not covered.

Generated evidence remains under `out/diagnostics/bot-multi-delegation/live/`: `report.json`, `six-delegations-1280.png`, `six-delegations-390.png`, and dev logs. Raw isolated execution histories are not committed.

## Repeat run and checks

Repeat run also passed. Foreground provider requests have distinct IDs and overlapping intervals (24 recorded cross-request overlapping pairs across the run). File Work initially produced a trailing newline: the owner identified the strict-content mismatch and automatically dispatched a correction. Its second execution removed the newline; independent final disk evidence equals the requested string byte for byte. The other two Work items used one execution each. All three finally closed as succeeded, without a user approval step. This is concrete self-correction evidence, not a claim that every failure class recovers.

`pnpm -s typecheck` passed (scripts 0 errors); both modified CJS files passed `node --check`. The final exact-byte assertion was also checked against the repeat run saved disk evidence. Full `test:all` was deliberately not run because this task defers crash-injection tests.
