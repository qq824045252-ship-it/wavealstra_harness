# Work failure recovery without quota gates

This revision removes Work quota admission and the separate “待你决定” navigation. A failed execution is not automatically a request for the user to approve a retry.

## Recovery contract

- Native success, failure and stop share one history reader. It crops at the next user input before collecting successful writes, reads and partial answers. Failure diagnostics are separate from output.
- A terminal execution is inspected once for retained evidence, including historical failed executions whose old projection discarded artifact references. This path only finds and inspects the original receipt; it never resubmits the original input.
- Failed, current, adopted execution bindings generate a durable continuation even when there were no subagent items. The continuation carries the original directory, original intent, successful subitems and retained artifacts. A stop or invalidation does not automatically restart work.
- Continuation identity is persisted before submission. Restart resumes the same request and receipt, not a second root task.
- A repeated failure without new artifact/subitem evidence switches to read-only delivery of existing results and explicit gaps. If that also fails, the owner records an unsuccessful conclusion. True unresolved effects remain accounted for; they are not represented as successful or cancelled effects.
- Unknown external effects are never blindly replayed. Recovery reads and reports existing facts instead. A late unknown receipt changes the recovery action policy too. Ordinary unrelated work is not blocked by this recovery's uncertainty.
- Completed effects and files are retained. Pure error strings are not proposed deliverables. When older error-only proposals are replaced with recovered output, the old proposal remains superseded history.

## Visibility

Useful partial results and recovered answers return to the originating Bot conversation. Execution failures and operational recovery messages are progress, not artificial owner decisions. Only genuine missing user input stays a question. Cleared operational diagnostics do not produce another notification for every internal transition.

## Verification

`test:bot-work-automatic-recovery` exercises root failure without subitems, physical retained output, restart identity, user-stop semantics, no-progress finalization and unknown-effect readback. `test:bot-work-review-execution` covers bounded history scans, failed/stopped artifacts, late evidence and idempotent legacy repair. Real Electron validation uses a temporary HOME and an explicitly local HTTP model fixture; it must not be described as an online-model run.

See [Work quota retirement](bot-work-no-quota.md) for the distinction between removed quota behavior and inert historical data retained in existing user databases.
