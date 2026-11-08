# Unknown resource effect resolution

Original base: `8a44bc56b26b9ad3836df74b8cff6d13be10881c`; rebased without conflicts onto `ba10d318871877b30796096e4d017106d2042ecf` (main, PR #19 general-mode naming migration) before publication. This change provides an audited exit for old quarantines without deleting user data or fabricating native not-started evidence.

## Recovery contract

1. The source Work displays the exact resource token, native action, original command where available, task, workspace, and resource scope.
2. The user requests stopping that original execution. The control validates the full Work version, exact lease/action/binding and exhausted recovery generation, persists an audit, and invalidates the binding against future tools.
3. Recovery stops the exact original native binding, verifies its owned children have stopped, and drains/releases input. Only then is a persistent ready receipt recorded. The resource remains quarantined.
4. The user now inspects the final effect and records either **did not occur** or **occurred**, with evidence and scope confirmation. Editing content or receiving another version invalidates confirmation. Uncertain submissions retain their operation ID for deduplicated retries.
5. Recovery rechecks quiescence and input cleanup. In the same transaction it releases that lease, settles the exact admission/approval (`released` for no effect, `consumed` for occurred), clears its external-effect blocker, and updates projections. It does not replay the original action or mark the whole Work successful.

The separate preparation stage prevents a user from inspecting before the original tool has stopped and then submitting a stale conclusion. Pending probes cannot be bypassed. Both preparations and reviews survive reopening; operation audits remain in the outbox. Existing quarantines require no destructive migration.

## Scope

Unknown shell execution remains host-scoped: a cwd does not constrain absolute paths, subprocesses or external effects. This change does not falsely narrow old host quarantines. Precisely scoped normal actions retain existing scope handling. Missing native stores or unprovable stopped state remain blocked with the recovery reason; a user checkbox alone cannot release them.

## Verification

- Typecheck: passed.
- Architecture and architecture graph: passed, without relaxing the WorkService 2,500-line limit.
- Review UI component suite: 28 passed, including the two-stage form, stale confirmation, pending-probe suppression and uncertain-submit operation reuse.
- Resource settlement regression: both user conclusions, exact settlement, wrong identity/version, rollback, reopening and subsequent pending dispatch passed. The dispatch transport in that service test is a stub.
- Native approval regression: real DurableRuntime abort/inspect/scanTasks, stopped preparation, review/release, and later preauthorized multi-file disk writes with zero per-tool approvals passed. This is native runtime execution, not an online-model conversation.
- Phase 2 recovery: an initial concurrent filtered run timed out on effect-receipt; the isolated full phase-2 recovery suite passed, including strong-kill effect-receipt and effect-unknown.
- Electron visual acceptance: blocked. Two isolated `pnpm dev` attempts lost the Vite process with exit 137 and showed a white window. The form was not visually accepted in the running desktop app. No claim of a complete real-user-profile recovery is made.

No production profile or old lease was cleared manually. The final default-suite outcome is recorded below after completion.

Default suite: 392 passed / 2 failed. `test:atspi-transport` failed because the host denies creating the private AF_UNIX D-Bus socket (`Operation not permitted`); this is an unmet environment prerequisite, not a pass. `test:ipc-channel-inventory` found the existing main-branch `remoteAccess:detectCloudflared` channel absent from its frozen inventory. After checking its main/preload registration, the inventory was regenerated and that test passed independently. No failure baseline was relaxed. Thus 393 distinct default cases have passing results and the AT-SPI environment case remains failed; this is not a claim of one fully green default-suite run.

Independent review caught one additional race before publication: a failed final native/input probe must invalidate a previously recorded user inspection. The final implementation removes that active readiness/review in the same recovery transaction, preserves the original outbox audit, exhausts recovery with a precise reason, and requires a fresh preparation and inspection. Regression cases cover both resumed execution and unclean input; later quiet probes cannot revive the stale conclusion.

After the safety fix, the full default suite ran again: **393 passed / 1 failed**, solely the same AF_UNIX prerequisite. The following validation is repeated after the PR #19 rebase.

PR #19 rebase validation completed: typecheck, native approval/real-disk recovery, settlement and 28 UI component cases passed; full suite again 393 passed / 1 AF_UNIX prerequisite failure. Main then advanced through PR #20 startup/performance work to `6b25fb30b0bd1560bc3dd34db7c3bccf2a9c55ec`. This patch was again rebased without conflict, retaining both intervening merges, and typecheck passed on that final base. No old IPC inventory was overlaid on the newer main.

Final-base full default suite: **396 passed / 1 failed**, solely the host AF_UNIX/D-Bus prerequisite. Final typecheck passed. Independent integration review found no new stop/quiescence issue from PR #20. Electron visual acceptance remains blocked as described above.
