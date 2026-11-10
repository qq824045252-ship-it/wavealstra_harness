# Stable personal Bot preferences in Work

## Confirmed gap and narrow fix

Work already resolves the executing Bot's scope from its persisted execution binding. The problem was not a missing memory system: the foreground reads stable private memory without a query, while Work's request-time projection filters L1 by the current query and only supplements project baseline. A preference such as `默认使用简短中文列表` disappeared for `统计季度库存数量`.

The regression was run against the original projection and failed on the missing preference assertion. The fixed projection supplements at most six active personal Bot `preference` / `identity` / `constraint` records. Existing total byte/item budgets, ID deduplication, source revisions, current scope and explicit kind filters remain in effect. It does not indiscriminately add unrelated facts. Team Work does not gain a new private baseline. No UI, approval flow, database schema or parallel memory store was added.

## Verification

- Typecheck passed, zero new script errors.
- `test:bot-work-review-memory`, `test:bot-memory`, `test:bot-memory-runtime` passed.
- Regression covers unrelated query, one-copy evidence, correction, deletion, ordinary-task isolation, team exclusion, unrelated fact exclusion, `kinds:[fact]` and `scopeTypes:[project]` filters.
- Non-fault headless gate: **413 passed / 0 failed / 0 known / 0 regression**, 2.4 minutes. The existing 20 separately deferred recovery/fault-injection cases were excluded using a temporary runner, not a changed baseline.

### Six real-model native Work tasks

An isolated temporary HOME and actual Electron development renderer were used with `opendesign/deepseek-v4.1-flash-eco`. The user message naturally requested a stable formatting preference; extraction persisted it. A new conversation with a distinct ID was created before dispatching the Works. No memory rows were manually inserted for this live run.

| Task | Outcome | Actual memory behavior |
|---|---|---|
| Inventory sum | succeeded, 17 + 29 = 46 | original preference in native L1 request and final deliverable |
| Meeting agenda | succeeded, 15-minute three-part plan | original preference in native L1 request and final deliverable |
| Walking itinerary | succeeded, non-live suggestion explicitly labeled | original preference in native L1 request and final deliverable |
| Customer-service rewrite | succeeded | natural correction persisted; new preference in native L1 request and final deliverable |
| Unit conversion | succeeded, 2.5 km = 2500 m | corrected preference in native L1 request and final deliverable |
| Departure checklist | succeeded | natural forget persisted; neither old nor corrected marker in new Work evidence or deliverable |

Each Work made 3–4 real native model calls. The assertions inspect transmitted L1 evidence, not just the foreground's claim. The six persisted deliverable summaries were independently checked (including 46 and 2500); they show original preference ×3, corrected preference ×2, forgotten ×1. The strengthened scenario also performs those deliverable checks directly. Reports return to the Bot conversation; screenshot confirms the existing layout, not a new UI design.

Reproduce:
`BOT_WORK_DEV_HEADLESS=1 BOT_FRONTDOOR_MODEL=opendesign/deepseek-v4.1-flash-eco pnpm -s test:bot-frontdoor:live --work-memory`

## Limits and follow-up

This validates new Work executions and fresh projection after correction/forget, not a year-long watch or every in-flight continuation. Deleting memory already used by a persistent execution still invokes the existing historical evidence revocation path, which can request a fresh context. That separate recovery behavior was not weakened or claimed solved here. Native file dialogs, physical desktop input and crash injection were not tested. Production instance and production data were not modified.
