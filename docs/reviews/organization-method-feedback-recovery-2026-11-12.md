# Organization recovery and method feedback

Observed on real-model organization story B at main 702acd49: a saved creation intent resumed from a fresh user turn reported contact_failed with “方法纠正缺少当前用户的真实请求”. Read-only inspection confirmed its original assistant turn was completed.

Cause: acceptOrganization correctly retains the original receipt for Work source/delivery. mutate commits Work acceptance before returning query(..., originalReceipt); that result projection unconditionally invoked method correction, whose real active-user check rejects the old completed receipt. This is a host bridge bug, not a generated methodCorrection parameter. Acceptance can already be committed despite the reported contact failure.

Fix: operation response projections do not capture method feedback. Only explicit collaboration query from a currently authenticated user turn invokes it. Receipt/source validation and original delivery identity are not relaxed.

Regression uses the production BotWorkMethodFeedback callback, real SQLite and real organization/collaboration services. Before the fix, the archived/completed-origin resume fails with the same contact_failed error. After the fix it resumes with the original Work source, and replay produces neither a second Work nor another schedule. Explicit current-user correction still reaches the real callback, and completed-turn queries remain rejected. Organization 18 groups, cross-channel contract, method-feedback regression and typecheck pass. No running live instance was changed. Real-model replay on the fixed version remains for the unified gate.

## Cross-path duplicate admission found by the same live story

The model used arrange(create), lost its committed creation acknowledgement, then arrange(existing) for the newly created target with the same source message, title and goal but reworded constraints/criteria. This produced a second intent; subsequently resuming the original produced another Work. This is distinct from the receipt/feedback exception above.

The admission transaction now bridges that exact same source task to its original creation intent using the real immutable creation receipt. Exact title, goal, mode and watch identity are required; there is no fuzzy semantic merge. A changed plan or configuration is returned as an explicit conflict referencing the saved intent, without applying the changed fields or creating another Work. An exact retry resumes the saved intent. A different task title/goal for the same target remains independent. Existing duplicate historical rows are not deleted or rewritten.

Production-service SQLite regression now covers commit-then-throw creation, changed-plan arrange(existing), fresh-turn original resume, repeat resume without another schedule, exact equivalent retry, and a legitimate second task in the same user request. It fails against the pre-fix admission path and passes after the change. Organization 19 groups and typecheck pass. Fresh real-model revalidation remains assigned to the unified gate.
