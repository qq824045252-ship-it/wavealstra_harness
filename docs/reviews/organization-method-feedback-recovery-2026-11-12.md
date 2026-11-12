# Organization recovery and method feedback

Observed on real-model organization story B at main 702acd49: a saved creation intent resumed from a fresh user turn reported contact_failed with “方法纠正缺少当前用户的真实请求”. Read-only inspection confirmed its original assistant turn was completed.

Cause: acceptOrganization correctly retains the original receipt for Work source/delivery. mutate commits Work acceptance before returning query(..., originalReceipt); that result projection unconditionally invoked method correction, whose real active-user check rejects the old completed receipt. This is a host bridge bug, not a generated methodCorrection parameter. Acceptance can already be committed despite the reported contact failure.

Fix: operation response projections do not capture method feedback. Only explicit collaboration query from a currently authenticated user turn invokes it. Receipt/source validation and original delivery identity are not relaxed.

Regression uses the production BotWorkMethodFeedback callback, real SQLite and real organization/collaboration services. Before the fix, the archived/completed-origin resume fails with the same contact_failed error. After the fix it resumes with the original Work source, and replay produces neither a second Work nor another schedule. Explicit current-user correction still reaches the real callback, and completed-turn queries remain rejected. Organization 18 groups, cross-channel contract, method-feedback regression and typecheck pass. No running live instance was changed. Real-model replay on the fixed version remains for the unified gate.
