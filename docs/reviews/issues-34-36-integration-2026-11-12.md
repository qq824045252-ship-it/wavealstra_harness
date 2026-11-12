# Issues 34–36 integration verification — 2026-11-12

Base: b7040544 (including upstream personal Bot collaboration). Changes were selected in an isolated checkout; the user's original checkout, index and in-progress changes were not modified.

## Scope
- #34: persistent invalidation candidates, 64-entry recovery/processing batches, side-table invalidation, image retry receipts and sequence-fenced acknowledgements.
- #35: retry runtime/composer release independently of cancellation receipts; serialize close callers and retain lease until real resource release. Preserve upstream compaction patch and add retryable vendor Session/Storage/SQLite cleanup. Fix the production better-sqlite3 adapter so a throwing native close cannot prematurely mark the handle closed or release the local snapshot gate.
- #36: verify upstream aging wake behavior and add saturated/cancel/archive/authority/shutdown/short/recovery cases. No new scheduling policy.

## Actual checks
All run on Windows against the merged code and installed merged dependency patches:
- typecheck: passed, scripts zero errors.
- test classification audit and git diff --check: passed.
- bot-foreground-lifecycle: passed, real native runtime/composer cancellation, confirmed cancellation cleanup retry, actual production SQLite close failure, concurrent cold opening cancellation and fake-clock aging cases.
- durable-close-retry: passed, explicit JSONL and SQLite vendor backends, before/after release failure, concurrent callers and admission seal.
- durable-sqlite-close-retry: passed, production default cold startup (no preseeded selector), actual better-sqlite3 failure before/after release, snapshot/local gate, queued transaction drain, actual lease, long Windows paths.
- work-feedback-incremental: passed, 100/1,000/10,000 closed Works, idle hydration and image scheduling both zero, bounded side-table invalidation, rollback, restart, image retry and stale-generation fencing.
- bot-report-images: passed, six real image-service failure/recovery cases and snapshot/path boundaries.
- bot-work-milestones, work-conversation-feedback: passed.
- bot-collaboration, bot-collaboration-repository: passed, protecting upstream #32 integration.
- durable-context-management: passed, preserving upstream compaction behavior and restart/retrieval.
- bot-scheduling-routing: passed.

The lifecycle fault injector targets the exact native handle (not every connection sharing a path). Expected injected errors are asserted, not suppressed product failures.

## Boundaries
No full regression, product build, packaging, app restart or live Provider task run was performed. Desktop event-loop latency is still unmeasured. These checks establish behavior and bounded work, not a measured end-user frame-time improvement. Earlier tests on the older baseline hit Windows publication/long-path failures; latest upstream already fixed those paths, so the removed migration module was not restored. Two exploratory runner names did not exist; the real routing suite above was used instead.
