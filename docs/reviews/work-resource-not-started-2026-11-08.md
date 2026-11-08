# Work resource recovery: rejected tools and visible dispatch waits

Base: main a96bb89489312773c16fc37c2052668c7cbd1280.

## Changes

- Read the native Pi ToolTask checkpoint inside the host afterTool hook. Only the `call` phase (before execution) supplies not-started proof. Model text, tool error messages and diagnostic labels cannot supply it.
- Release only the exact active lease admitted in the current policy invocation. A previous quarantined action with the same ID retains its unknown effect. Rejection never releases a different held-input lease.
- Reconcile exhausted leases only when the persisted host execution ledger matches task, execution, tool call, attempt, verifier and not-started outcome. Unknown effects, mismatched identities and ambiguous attempts remain quarantined. Recovery does not replay the business operation or consume unrelated admissions.
- Persist pending-dispatch and exhausted-recovery blockers. Pending Work links to the source Work. Retry remains available for a closed source Work without reopening it or force-releasing unknown effects.
- Tell the foreground Bot to delegate requested writes under the existing scope and surface concrete per-action approval, rather than only asking for permission in prose. This does not expand scopes.

## Authorization behavior

Existing task-level authorization is preserved: auto mode plus Work and execution scope permitting workspace writes runs consecutive tools without per-command approval. Missing scope, readonly mode, explicit denial, workspace isolation, and unknown prior effects remain separate gates. An approval of one action does not become a permanent or task-wide write grant.

## Evidence

- `pnpm -s typecheck`: passed (scripts zero errors).
- `pnpm -s test:all -- --filter=work`: 79 passed, zero failed.
- `pnpm -s test:all -- --filter=durable`: 13 passed, zero failed.
- `pnpm -s test:work-approval-native` and `pnpm -s test:bot-work-phase3-resource-settlement`: passed after final safety refinement.

- Native SQLite/Pi/filesystem regression executes two real writes (including a new nested directory), then real read-only verification without any per-command approval under preauthorized task write scope.
- Native late guard block and throw both leave no file, no live resource lease and no unknown admission, including runtime reopen.
- Existing same-action historical unknown-effect regression remains quarantined, and unsafe executed side effects are not replayed after reopen.
- Seven persisted-proof recovery cases cover exact proof, unknown outcome, forged verifier, wrong task/attempt/call, and ambiguous attempts. Only the exact case releases the matching admission; parent binding, another admission and budget remain unchanged.
- Real desktop Electron `pnpm dev` with isolated HOME/data: pending explanation is visible, source navigation works, exhausted retry requires confirmation, and an unknown effect remains isolated after retry. The fixture uses real WorkService/ResourceGate data but no original native session store, so this is UI/safe-refusal evidence, not online-model end-to-end dispatch recovery.

## Limits

No original user Work, lease or test data was deleted or rewritten. Old quarantine without authoritative not-started proof is not automatically released. Online-model conversational compliance, full default suite, AT-SPI transport, packaged builds, and other platforms are not claimed by this change. The source supports targeted work/durable headless validation plus the isolated desktop acceptance above.
