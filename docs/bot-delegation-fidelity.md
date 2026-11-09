# Bot delegation fidelity

The foreground Bot can plan and split work without another approval. Its summaries,
calculations and proposed checks are not authenticated user instructions.

## Runtime contract

- `BotDelegationInput` reads user messages through the host's persisted send receipts
  and the Work's intent snapshots. New requests receive a Work-owned immutable copy
  in the same acceptance transaction, so removing the original Bot/chat does not
  erase the task's source. It never takes a model-supplied quote or message ID.
- Sources are bounded by the execution's intent and source versions. Later messages,
  already delegated tasks and foreign conversations are not inherited. The pending
  dialogue since the preceding delegated request is retained as role-labelled
  context, so a clarification such as “HTML” does not lose the earlier data or
  restrictions. Explicit references
  retain their original roles. The full user text is independent of the short goal
  displayed in the UI. Directly entered structured user requirements are retained.
- Execution inputs separate `userRequest` from `delegationPlan`. Field and constraint
  item provenance is traced through the snapshot history: a title-only user edit
  does not adopt an inherited model calculation.
  Calculations, constraints and assumptions in the latter must be checked against the
  former. A planner-only contradiction is corrected autonomously, not treated as a
  new user decision. Real conflicts in the user's instructions still need clarification.
- Foreground-created criteria receive the host-owned `assistant_proposal` origin.
  They remain useful checks but cannot become mandatory user acceptance gates or
  demands for user verification. Directly entered user criteria retain their gates.
  A user's explicit positive, negative or pending feedback adopts a proposed check
  as a user criterion; a negative result still blocks completion. The UI separates
  suggested checks from user acceptance progress.
  Existing permissions and explicit artifact acceptance are unchanged.
- Normal dispatch, persisted retry, recovery and gap-only continuation all retain the
  bound original input. Continuations remain limited to their remaining steps.
- A bound receipt whose message identity no longer matches is an input integrity
  error; the host must not fall back to treating the model's summary as user text.

## Validation and limits

`pnpm -s test:bot-delegation-fidelity` exercises real SQLite receipts, foreground tools,
intent snapshots, adapter submission, restart, continuation, amendments, long input,
role/tenant isolation and user-authored acceptance gates. The sales fixture deliberately
puts an incorrect calculated total in the model plan and verifies the original rows
reach the executor unchanged. The implementation contains no sales-specific rule.

This contract mechanically preserves provenance; it does not prove that every model
will calculate correctly or follow the provenance instructions. Live model testing is
separate from deterministic regression tests. Historical stored criteria are not
silently reclassified. Old direct-user criteria are preserved when the foreground
  revises its suggestions, and the tool explicitly reports those retained criteria.
  Changing or withdrawing a directly entered criterion still uses the existing user
  editing/review entry point; the model cannot silently waive it. The pending-dialogue
  boundary is structural, not a semantic relevance classifier: the executor must
  still distinguish relevant clarification context from unrelated unassigned chat.
