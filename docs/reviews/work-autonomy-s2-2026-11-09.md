# Issue 18 S2: persistent exact-action continuation

Base: `24496b83dc61edff32bc46593c796748cbb81641`.

## Delivered contract

- A deferred approval is the logical action identity. Its private durable payload retains normalized tool arguments, the original tool envelope, original conversation identity and effective working directory. The UI receives status and reasons, not the payload store.
- Built-in path actions freeze canonical cwd and target (including new-file suffixes), then recheck before claim/admission. A changed symlink target invalidates the unexecuted action rather than reusing its old authorization. This supplements, not replaces, the existing filesystem boundary.
- Approval and queued execution intent commit in the same SQLite transaction. A unique native receipt and a compare-and-swap claim bind one native leaf operation to the logical action. Repeated decisions, polling, delivery and model retries do not create another effect.
- A completed or failed source execution does not automatically invalidate a still-current deferred action. Only the claimed exact action receives terminal-binding admission; unrelated operations remain forbidden. Work lifecycle, owner epoch, input/intent, authorization, current tool policy and resource checks still apply.
- The native continuation executes the frozen leaf without a new model turn. MCP envelopes and child conversations are retained. Code Mode executes through its normal VM, while deferred effects are resumed as individual native tool leaves, never by rerunning the enclosing script.
- Reopening an expired/ignored card is not approval. It produces a fresh decision opportunity. A new delivery generation prevents an old, unexecuted terminal native receipt from stranding a later explicit approval.
- Consumed effects clear the original not-started gap. Unknown effects retain reconciliation obligations and are not replayed. Deterministically unexecuted failures remain distinct from unknown effects.
- The conversation and detail views expose queued/running, ignored/refreshable and completed/unknown states. Final continuation facts are delivered to the originating Bot conversation idempotently. Settling one action does not declare the entire Work accepted or completed.
- The schema addition is registered in AppDatabase's current-schema additive initialization. It does not increment the database version, rebuild the user database, erase old approvals or release historical resource quarantines.
- Invalid payloads are isolated so they cannot starve healthy queued work. Already-running/unknown/settled effects are not relabeled as never executed when payload verification fails.

## Verification

Focused commands:

- `pnpm -s typecheck`
- `pnpm -s test:work-approval-defer`: 16 checks, including late approval, duplicate claims, mismatched parameters, owner epoch invalidation, expiry refresh, unknown effects, oversized-payload rollback, corrupt-payload isolation identified credential-value rejection, target drift and stale-delivery fencing.
- `pnpm -s test:work-approval-ui`: 19 React DOM/IPC checks; these are not a substitute for desktop evidence.
- `pnpm -s test:work-team-approval-native`: real local file execution and member/workspace/tool boundaries.
- `pnpm -s test:work-conversation-feedback`: durable original-conversation delivery, restart, rollback and no model turns.
- `pnpm -s test:architecture` and `pnpm -s test:architecture-graph`.

Real Electron desktop evidence was collected in an isolated temporary profile, without changing the user's live database:

1. Send a real Bot task that performs an independent read and defers a file write lacking scope.
2. Wait for the original executor to complete, then restart the application.
3. Approve the original card through the actual UI. The exact file is written, the action becomes consumed and the not-started gap disappears.
4. Model requests remain **6 before and 6 after approval**. No model turn or already-completed read is rerun.
5. A second run exercises **ignore → reopen original card → separate checkbox authorization → exact write**. The settled card remains available in history.

These desktop tests used a controlled model transport to produce deterministic tool calls, with real Electron, IPC, WorkService, Pi durable execution, SQLite and filesystem writes. They are not evidence of an online provider/Judge transport test.

## Explicit boundaries

- This is S2, not closure of Issue 18. S3 historical host-resource conflicts, S4 watch/Remote/Gateway and S5 real Judge transport remain separate work.
- Code Mode resumes the frozen leaf, not an arbitrary dependent script suffix. Remaining goal acceptance still requires its normal evidence; no automatic whole-Work success is inferred.
- Existing approvals without complete saved payloads are not reconstructed from human-readable detail. They require a newly specified exact action.
- No general credential-reference resolver was introduced. Identified credential operations/secret-bearing parameters are not persisted as replay payloads; their limitation is explicit. This is not a claim that heuristic text recognition is a universal secret detector.
- The complete process-kill matrix at every SQLite/native/side-effect commit boundary and real external-provider effect tests must not be inferred from passing restart/duplicate-delivery tests.

## Final gate result

On the final frozen implementation, `pnpm -s typecheck` passed with zero script errors; `pnpm -s test:all` completed in 3.0 minutes with **399 passed, 0 failed, 0 known failures and 0 regressions**. The earlier candidate run also passed 399/399. The final native suite additionally verifies an expired native delivery followed by refreshed independent approval; the new delivery is not trapped behind the old terminal receipt.
