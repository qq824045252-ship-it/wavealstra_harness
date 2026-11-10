# Current preferences in Work and Watch result delivery

## Findings

Normal Watch ticks do **not** reuse one old persistent execution forever. `WorkDispatchQueue` allocates a new task/binding; Durable opens the corresponding new conversation. Continuation dispatch and team watch cycles also create new execution tasks. Therefore an old memory ledger's revocation check is not itself evidence that every later Watch tick is blocked.

The real reproducible defect was in the foreground result review: backend results followed the saved personal formatting preference, but the separate `BotWorkResultTurn` had no current personal memory. Nine observed pre-fix reports omitted the preference in the user-visible summary, while retaining it only inside the raw execution record. Previous reports could also be mistaken for current formatting guidance.

## Fix

- Resolve current, bounded personal Bot preferences from the trusted execution task binding. Team tasks gain no private preference baseline.
- Inject the current preference through the existing ephemeral evidence path. No raw preference copy is added to persisted review `context_json`.
- Persist only a SHA-256 fingerprint for cache identity and delivery checks.
- Watch and ordinary Work discard an obsolete review when preferences change before delivery, and use a new fingerprint-qualified review request identity rather than replaying a cached Durable response.
- Explicitly treat previous reports as historical observations, not current formatting instructions. Current preferences affect the natural-language reply, not facts, tools, completion/stop decisions or JSON schema.
- Original histories and the existing revoked-evidence guard are unchanged. No new approval or UI was introduced.

## Native verification

Typecheck: zero new script errors. `test:work-watch-supervision`, `test:bot-work-automatic-completion`, and `test:work-watch-goal` (31 checks) passed. New assertions cover correction while delivery is pending, forgetting during model review, dropping stale replies, empty-preference re-review and no raw preference persistence.

Default non-fault headless gate: **413 passed / 0 failed / 0 known / 0 regression**, 2.3 minutes. The 20 previously deferred recovery/fault-injection cases were excluded using a temporary runner; no baseline or official runner change.

## Real-model verification

Scenario: `BOT_WORK_DEV_HEADLESS=1 BOT_FRONTDOOR_MODEL=opendesign/deepseek-v4.1-flash-eco pnpm -s test:bot-frontdoor:live --watch-memory`.

Six different Watch types read real synthetic files: inventory total, pending-item count, earliest meeting, Celsius-to-Fahrenheit conversion, project-status summary and expense total. Each uses a real two-minute timer, actual native model execution and the real foreground result model. The test learns a preference naturally, corrects it, then forgets it; it checks each phase's native deliverable and the visible summary **before** the appended raw record. New-phase executions are selected by admission time after memory persistence, not by a naive round index (creating six watches can cross a timer boundary).

Final live checks: **18 / 18 passed** (six task types × three preference phases). The native deliverable and user-visible foreground summary both followed the original preference, then the corrected preference, then omitted both old markers after natural forgetting. Each selected phase used a different execution task ID; the Work remained active between rounds. All six test watches were then paused. Additional timer rounds can occur while the six scenarios are being created or awaiting other observations; this is not a claim that only eighteen executions occurred.

## Boundaries

Temporary isolated HOME and development instance only. No production data or production instance changes. This is multi-round Watch evidence, not a year-long soak or crash recovery claim. Same-binding in-flight memory revocation still uses the pre-existing guard; the fix does not authorize sending revoked historical context or replaying business actions. Old already-delivered reports remain historical records.
