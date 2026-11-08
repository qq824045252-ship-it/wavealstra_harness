# Work review friction follow-up (2026-11-08)

## Scope

This follow-up addresses the fourth-round user report: repeated version acknowledgement for six criteria, an otherwise literal read rejected because it ends with `; echo $?`, and closure rejection without named necessary gaps. Existing user Work records are not cancelled or changed by this patch.

## Product changes

- The real-environment feedback form supports explicit selection of several conditions covered by the same environment and evidence record. It submits a single existing `recordUserFeedback` operation. Empty selection retains the current single-condition behavior. Different required environments must be submitted separately. Selecting checkboxes is not acceptance; the user still submits a result.
- State, owner, intent, input and artifact guards are unchanged. No automatic rebasing or confirmation of external updates was added. Failed batches do not partially apply; operation retries remain idempotent.
- Successful closure still requires all necessary execution gaps to be resolved. The close area lists each gap's task, reason, status and source binding. The rejection also names up to ten gaps and directs users to the full list. Manual acceptance does not erase execution history or silently convert failed subitems to success.
- Bare relative literal paths were already supported. The added command form is only a controlled system read followed by exact `; echo $?`. The whole string is parsed before execution. The host renders the actual exit code without launching a shell or executing `echo`; other chained commands remain subject to the original guard. Existing FD/path/lease validation is preserved.

## Verification

- Focused backend review tests cover atomic multi-condition feedback, wrong-environment rollback, stale guard rejection and idempotent replay.
- React lifecycle tests cover explicit multi-selection, one API call, snapshot binding, differing environments, no automatic replay on external changes, and named gap presentation.
- Native runtime tests cover actual read output, bare relative targets, exact status echo, forbidden compound commands, no extra read approval and restart behavior.
- A real nonzero system-command result is passed through the same output renderer used by the tool to verify that stderr and failure exit status remain intact. The deliberately invalid test option is not admitted by production parsing.
- Before the user stopped further testing, typecheck, focused backend review (21 checks), React review UI (25 checks), native permission and real-system-command regressions completed successfully. The nonzero exit-code case was also checked.
- The aggregate run was interrupted before a complete default-suite result was recorded. Completed groups were successful, but this is not a full-suite pass.
- Real Electron launch attempts did not produce a completed acceptance result: the first exited 137 under concurrent load, and subsequent UI work was stopped. No complete real-UI or online-model validation is claimed.
- Further tests were stopped at the user’s request. The user will run acceptance locally; this patch is published without waiting for additional tests.
