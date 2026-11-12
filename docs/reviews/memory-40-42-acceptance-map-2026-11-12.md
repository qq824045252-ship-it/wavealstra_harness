# Issues 40–42 acceptance map (2026-11-12)

Product implementation is pushed through `d2bcb7db`; the successful real Electron product baseline is `b59df0a5`. The complete failed-run history and final 9/9 report are in [the live follow-up](memory-40-42-live-followup-2026-11-12.md). This map separates production-service/SQLite evidence from real-model UI evidence.

## #40 original checklist

| Item | Evidence and result |
|---|---|
| Six non-delete statements do not advance boundaries; old references survive | `memory-correctness-test.ts` non-delete and complete-message groups execute actual capture and historical recall; passed. Live negative/quote/hypothetical cases passed. |
| Shortest legitimate user evidence permits remembering | Same production `remember` tests, negative-retention cases; passed. |
| Actual forgetting, no existing L1, late completion, in-flight extraction, reopen | `bot-memory-forget-watermark`, `memory-correctness` and `memory-evidence-forget` use actual stores/services; passed. Real UI exact deletion passed. |
| Mixed operations and clause-local negation | Correctness mixed/explicit-operation groups plus retained same-source B; passed. |
| Private Bot, Team and shared channel do not promote data | Correctness Team/shared scope and existing Bot memory suites; passed. Real UI cross-Bot private isolation passed; Team/shared UI variations not separately model-tested. |
| Check durable effects and final references, not only regex | Persistent tables, records, candidates, actual history projection and final foreground provider payload are asserted. No claim of OS crash injection. |

Old incorrectly advanced coarse watermarks are retained, not guessed away. This preserves real prior deletion intent; it does not automatically recover incorrectly hidden old history.

## #41 original checklist

| Item | Evidence and result |
|---|---|
| Earlier A/B: A cannot resurrect; B history/extraction/L1 survives | Correctness in-flight extraction commits B only; evidence/source tests and real UI exact deletion + both continuation paths passed. |
| Same message, different messages, different conversations | `memory-forget-scope-entry-test.ts`: 22 real service/SQLite/candidate-review combinations. Conversation/Task cross-conversation cells are excluded as invalid contexts, not claimed tested. |
| Shared A versus other Bot private B; Team/Conversation/Work/Project | Correctness global deletion case and the 22-entry scope matrix; no expanded reads. |
| In-flight extraction, late completion, reopen, retries, late semantic writes | Correctness held extraction, normal file-DB close/reopen and retried candidate; semantic delete/detach/update/expire/supersede and late-index probes; lineage L0 survival after run cleanup; passed. Not a real-model crash-recovery test. |
| Explicit whole-scope forget and later restatement | Existing coarse-boundary tests, fresh-source relearning, native provenance coarse-boundary probe; passed. |
| Mixed operations and same-time durable ordering | Correctness mixed clauses and reverse-completion same-millisecond ordinal assertions; passed. |
| Old profile migration/unknown boundaries disclosed | No coarse-watermark clearing; no unknown-target hash reconstruction. Older run source IDs are reused where present, L0 retains new provenance. Truly absent ancestry is not invented. Replaying the failed deletion on a backup is not automatic repair of an already-deleted legacy target. |

Only affected derived assistant evidence is withheld. Original independent user B and L1 B remain available. A mixed assistant answer without segment-level attribution is not promised to retain every unrelated word. A request that already transmitted data before withdrawal cannot be retroactively unsent; this is not represented as having been erased.

## #42 original checklist

| Item | Evidence and result |
|---|---|
| All window boundaries plus 5K/10K, bounded foreground results | Actual `BotConversationMemory.search`/MemoryService/SQLite tests at 600/601/1600/1601/1800/1801/2000/2001/5000/10000 passed. The initial real Electron batch used 2102 records. A separate real Electron foreground supplement now passes at 5000 and 10000 records in independent Bots; see [scale evidence](memory-42-scale-live-2026-11-12.md). Smaller table boundaries remain production-service/SQLite tests, not separate model turns. |
| Importance, explicitness, recency, duplicate bindings; no-query semantics | Newer high-importance filler, low-explicit target versus explicit filler, duplicate bindings and old exact fact passed. Existing kernel/context suites preserve no-query selection behavior. |
| Lexical, disabled/unavailable semantic, semantic-only | Real storage/provider paths with controlled embedding computation passed. Separate 10000 stored 1024-D vector scale test visits the full legal vector set. Actual embedding-model quality is untested and not substituted by these probes. |
| Scope, status, expiry and async revocation | Scope service matrix; asynchronous delete/detach/update/expire/supersede; actual task project rebind during held embedding; frontdoor memory-disable during pending search; passed. |
| Query plan, expanded records, latency/memory | Integration/scale reports include SQLite plans and hydration counts. Five lexical queries hydrate fewer than 5000 records total, not 10000 DTOs per query; 10K-vector latency/loop/RSS budgets passed. No universal speedup claim. |
| L1 exists without usable original dialogue | IPC-created old fact was never supplied in prior user dialogue; actual model tool calls retrieved it in the 2102-record UI scenario and the independent 5000/10000-record supplement. |

No full repository regression, release build or packaging is implied. The extra explicitness, supersede and task-rebind probes are targeted tests only; product code did not change after the successful real batch.
