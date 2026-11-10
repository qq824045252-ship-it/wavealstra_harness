# WorkService responsibility split

## Boundaries

`WorkService` remains the public facade. Actor resolution, version/idempotency checks,
transaction admission, receipts, outbox and post-commit projection publication stay in
one control path. Extracted modules do not own transactions and do not change policy.
In particular, artifact invalidation may commit useful facts even when a control returns
`ok: false`; moving that branch must not turn it into a rollback.

## Batch 1

- `WorkProjectionBuilder`: read-only projection composition and subscription presentation.
  Receives narrow readers, not the whole facade or a database connection.
- `WorkDeliverableMutations`: submission, acceptance/rejection, feedback and criterion
  attestation mutations. Calls run in the existing facade transaction. Acceptance and
  its semantic result card remain atomic.
- `WorkControlTypes`: shared internal control result/actor types; no runtime dependency.

WorkService falls from 2,515 to about 2,064 lines. This is a responsibility boundary,
not a line-count workaround. Public IPC and service signatures are unchanged.

## Responsibility roadmap (status below)

1. **Closure**: cancellation, closure preconditions, settled check, terminal writes,
   stopped-execution blocker cleanup. Keep a single `tryCloseSettled` shared by all
   execution/admission/blocker reconciliation paths.
2. **Pause/resume and delegation**: separate pause/backlog transitions from owner/member
   handoff. No duplicated transaction wrapper.
3. **Intent mutations**: creation/amendment, criterion reconciliation and input snapshots.
   Keep creation replay and observed-source compare-and-swap in the facade.
4. **Execution coordination**: dispatch admission and execution settlement adapters,
   retaining persisted binding identities and current outbox ordering.
5. **Subscriptions**: configuration, schedule synchronization, source ingestion. Rebase
   after the independent changes-only watch fix before extracting these methods.

Do not create one giant replacement LifecycleService or one file per trivial method.
Use narrow repository/service interfaces and explicit callbacks, not `WorkService` or
`any` as a dependency. Each batch retains observable behavior and is separately tested.

## Batch 1 verification

- Typecheck including scripts: pass.
- Architecture graph: 5/5 pass, no baseline relaxed.
- Review projection/control/execution, memory, projection retention, Phase 5 review and
  delivery dedup, automatic completion, conversation feedback: pass.
- Added a real SQLite boundary regression: receipt-write exception rolls back submitted
  result/evidence/Work/outbox together; submit and accept replay create no extra rows;
  repeated projection reads change no Work tables.
- No crash/kill/fault-injection campaign, production restart, schema migration or version
  bump. A transaction exception in the focused boundary test is not a process crash.
- Live-model UI verification is reported separately; headless/service tests alone are
  not evidence of desktop usability.

## Batches 2–3

- `WorkClosureMutations` owns the one shared settled/closure implementation, cancellation,
  terminal state and closure-card writes. The facade still owns artifact capture and
  control/transaction admission.
- `WorkPauseResumeMutations` owns pause/backlog transitions.
- `WorkDelegationMutations` owns owner handoff and participant insertion.
- All ten moved bodies were mechanically compared against their originals. WorkService
  is now about 1,847 lines. Typecheck, architecture, control, collaboration, automatic
  completion, delivery dedup and Phase 5 review checks pass.

Live normal-flow check on Omarchy: an isolated Electron dev instance using the real
DeepSeek model created a once Work, produced the requested three-area home plan,
returned it to the Bot conversation and closed `succeeded` without human acceptance.
The older live fixture waited for the raw summary prefix, whereas the current renderer
shows structured conclusions; the fixture now checks all three requested areas inside the exact persisted result
message and uses the current completed tab. The full real-model UI fixture passed on
rerun, including independent foreground result-thinking, one returned result and
completed-list visibility. Screenshot was inspected; it is not a physical-input test.

## Batches 4–5

- `WorkIntentMutations` owns creation facts, amendments, criteria reconciliation and
  intent snapshots. Facade retains initial and in-transaction actor checks, creation
  idempotency/receipt and observed-source compare-and-swap. Subscription/deadline
  callbacks still call the existing implementation.
- `WorkDispatchMutation` owns immutable execution binding creation and dispatch facts.
  Recovery-source SQL remains a narrow facade callback; its read order is unchanged.
- WorkService is now 1,466 lines, with seven domain modules plus shared internal types.
  No new runtime dependency cycle, schema, IPC, policy or approval was introduced.
- Typecheck, architecture 5/5, control, review control (12 scenarios), review execution,
  automatic completion, schedule-clock and watch-scheduler checks pass.
- Subscription extraction is deliberately pending the independent watch fix. Native
  submission receipt/settlement coordination and shared control admission remain in
  the facade for now; existing `WorkExecutionSettlement` is reused, not duplicated.

Final real-model UI completion was rerun after the Intent/Dispatch extraction and passed.

## Batch 6: subscription extraction after watch integration

Rebased onto watch fix `827b46e`. Subscription configuration, schedule/deadline
synchronization and Phase 4 mutations now live in `WorkSubscriptionMutations` (253
lines), with three explicit SQL operations in `WorkSubscriptionStore` (23 lines).
Facade remains 1,265 lines and retains identity, transactions, schema validation and
receipt/replay handling. Eight method bodies were mechanically compared; typecheck,
control, watch scheduler and architecture checks pass.

A separate interleaved A/B configuration replay regression reproduced a pre-existing
bug: replay of A returned B's generated subscription ID. This extraction deliberately
preserves it; the next independent fix will persist the exact operation result rather
than using service-wide scratch state.

## Independent fix: stable subscription identity on control replay

The A/B/replay-A regression was red before the fix. Configure now stores its generated
subscription ID inside the original operation receipt's private `_controlResult` JSON,
atomically with the subscription and Work mutation. Reply and replay read that exact
receipt, including after a normal database reopen; Work DTO parsing strips the internal
metadata. There is no new table/schema or control/approval path.

Legacy receipts without result metadata use an explicitly supplied ID only. An old
receipt whose generated ID was never stored returns no ID rather than another call's
ID; replay does not rerun the mutation or create a replacement subscription.
Interleaving, reopen, old-receipt non-guessing and no DTO metadata leakage now pass.
WorkService is 1,270 lines after this independent correction.
