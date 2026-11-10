# Watch changes-only verification — 2026-11-10

## Scope and fix

An isolated real-model run reproduced a host delivery defect: the model described its first observation as silent, but the host still posted that result. `changes_only` and `notifyInitial` are now explicit persisted watch options. Existing watches without the option retain every-check delivery.

Scheduled observations use a structured observation contract, but model prose is **not** proof of equality. Native execution records complete read receipts from that binding's committed tool results. Only complete direct file/knowledge reads with matching source identities can suppress unchanged results. The last matching read attempt wins, including errors, empty/malformed receipts and partial reads; earlier successful receipts cannot hide a later failed observation. Missing evidence remains visible. Rejected/superseded results and incomplete scope cannot be silenced. Same-millisecond deliverables use persistent insertion order.

The feedback projection suppresses redundant progress for quiet observations and emits one result for a change. This is whole-source content comparison, not arbitrary webpage-property or semantic equivalence detection.

## Real task evidence

Isolated Omarchy dev profile, actual Magpie `opendesign/deepseek-v4.1-flash`, real minute clock, actual source file, no production database changes and no crash/force-kill injection.

Work: `work-730e8430-4bb2-49fc-9af7-61f182b15879`.

| UTC | Observation | Messages to original conversation |
| --- | --- | --- |
| 12:16:21 | WAITING initial baseline | 0 |
| 12:17:13 | WAITING unchanged | 0 |
| 12:18:24 | READY after normal application restart and source change | 1 result, no duplicate progress |
| 12:19:18 | READY unchanged | 0 |

The test closed its own Electron application normally and reopened the same isolated profile between rounds two and three. Conversation identity and persisted watch options were retained. A natural-language pause followed by 70 seconds of real waiting produced no new execution. 1280px and 390px screenshots were inspected without horizontal overflow.

Local artifacts: `out/diagnostics/bot-watch-changes/live/` (not committed; includes report, screenshots, provider requests and dev log).

Factuality limitation: the model correctly reported the READY identifier but volunteered a byte count of 20, whereas independent read-back measured 19 bytes. That prose did not drive equality or delivery. This run is not certification of every sentence in the model's summary.

## Verification

- `typecheck`: passed.
- `test:work-conversation-feedback`: passed, including persistent database reopen, same-timestamp ordering, rejected results, malformed/unknown observations and full-read followed by partial/error receipt.
- `test:bot-work-review-execution`: 17 regressions passed, including exact committed read output and preservation of failed attempts.
- `test:bot-watch-intake`, `test:bot-watch-scheduler`, `test:bot-watch-creation`: passed.
- `test:bot-frontdoor:live --watch-changes`: four real rounds, normal restart, same-conversation routing, quiet unchanged results and pause passed.
- CJS syntax and diff whitespace checks passed.
- Independent read-only review found no remaining blocking issue.

The final last-attempt failure-path hardening followed the healthy live run and was verified by native/SQLite regressions and typecheck, not by an additional real-model failure injection.

Before rebasing, `test:architecture-graph` exposed the pre-existing 2515-line WorkService limit violation (HEAD already contained 2515 lines); this patch does not modify WorkService or relax its limit. Publication rebase verification is recorded below. The full suite and crash tests were not run.

## Limits

No production watch was migrated or certified. Event-driven watches, arbitrary search/webpage properties, screenshot semantics, shell output and nested-agent summaries are not proven comparable by this implementation and must not be described as reliably silent. No multi-day outage, team-watch or crash-recovery claim is made.

## Publication rebase verification

Rebased without conflicts onto main including the independent WorkService responsibility extraction. Typecheck, feedback, 17 native execution regressions, watch intake/scheduler/creation and architecture graph all passed after the first rebase; the final additional Intent/Dispatch extraction rebase is rechecked before push. No WorkService source changes are included in this patch.
