# Browser #46/#47 targeted follow-up (2026-11-12)

## Version and execution boundary

Production source: `a2b9c8d089c743a0d13344b99f726e5c6b327aa1`, isolated Git archive on Windows, Electron 44.5.1 / Electron Node 24.21.0. Browser production sources are unchanged from integrated `b6598be0`. No product source, user checkout, user profile, provider account or installed application was modified. Tests use isolated BrowserHost windows and synthetic pages. No full regression or six-task provider batch was repeated.

Run the supplemental tests with `node scripts/run-browser-46-47-followup.cjs`. This builds test-only bundles, not product/release artifacts. It requires an available Windows graphical session and installed repository dependencies. Serialize with other GUI tests.

## Results

- Real Electron supplemental suite: **15 groups passed**. Foreground and minimized modes now each verify actual submitted ordinary input, textarea, contenteditable, controlled React and Chinese values, plus explicit readonly, disabled, covered and rejected-controlled-field failures. Background task targeting with UI-selected unrelated tab remains covered.
- Actual finite renderer busy loops, without replacing `executeJavaScript`: caller abort, absolute deadline and tab destruction stop the caller before the 1.5-second busy loop completes. Another tab remains readable afterward. The concurrent-other-tab-while-A-is-pending property remains covered by the existing contract fixture, not claimed as a new simultaneous real-renderer measurement here.
- Real native stop integration: controlled model → real Pi Codemode → DurableDomainTools → real BrowserAutomationService waiting on actual busy renderer. Calling production `DurableBotRuntime.abort()` aborts the tool's native signal and ends the tool wait with AbortError. Recorded 47 ms is a single correctness observation, not a latency SLO or benchmark.

JSON evidence: [Electron](evidence/browser-46-47-followup/electron-results.json), [native stop](evidence/browser-46-47-followup/native-stop.json).

## #46 acceptance mapping

1. Task-bound background find/click/fill/wait and UI tab preservation: supplemental group 2 plus existing browser contract tests.
2. Closed tab, replaced node, ambiguity and document lifetime: supplemental groups 1, 4 and 15 plus existing document/nav contract tests.
3. Unrelated clock changes and real readonly/disabled/occlusion: supplemental groups 2, 3, 6 and 7.
4. Sequential multi-field edits: groups 2, 6 and 7 verify final submitted data.
5. Independent tab navigation, same-tab latest-wins and Gadget restoration: existing browser contract/Gadget tests in the original review; integrated contract rerun is recorded in [the integration review](browser-46-50-2026-11-12.md).
6. Full real-window-state input matrix: groups 2, 3, 6 and 7 now cover the previously missing foreground/minimized cases.
7. Existing tabs/popup/session/page preservation: previous dedicated suite evidence in the integration review; browser production file hashes were independently checked to match the preintegration evidence (allowing LF/CRLF normalization). This is preserved evidence, not a newly rerun popup/provider suite.

#46's remaining specific window-state evidence gap is satisfied. No newly reproduced product defect.

## #47 remaining limit

The actual stop button/renderer IPC/AgentService admission route was **not exercised end to end** in this supplemental run. Source confirms IPC AgentIpc.abort → AgentService.abort → DurableBotService.abort → DurableBotRuntime.abort for a Durable task, but reading that route is not a UI test. Native abort propagation is tested; full user-stop entry remains an explicit acceptance gap. Keep #47 open until that is tested or its acceptance scope is explicitly changed.

Read sub-wait cancellation, pre-dispatch no-input, post-dispatch unknown outcome, late receipt rejection and listener cleanup remain covered by the existing focused contract suite; they were not all repeated here.

## Failed driver attempts retained

The first directly piped Windows GUI launch produced only five progress records and no final JSON; it is not counted as passing. Redirected logs avoided that launch problem. A second driver incorrectly awaited the destroyed WebContents' underlying JavaScript promise after the browser caller had already stopped; that promise need not settle. The driver was corrected not to wait for a destroyed page. No production timeout, action or cleanup code was relaxed. An initial native-stop fixture used a data URL rejected by the real browser contract; it was corrected to an isolated file URL, without changing product URL policy.



## #47 user-stop entry follow-up (same day, closing evidence)

This later supplement resolves the user-stop gap above. Tested checkout is `895e1eff`; the intervening commit after `3da53d82` changes only #43 evidence documents, not production code. The report now records HEAD dynamically.

The isolated renderer mounts the **production ChatInput component and production Zustand store**, uses the **production preload**, and receives native mouse down/up at the real “停止生成” button. Its real callback invokes the original runControl action and AgentIpc.abort. The test registers the normal handler body against a fully initialized real AgentService, real AppDatabase and real Durable runtime. It does not replace the abort callback with direct service calls. The returned history is applied by the renderer; the test waits until its actual durable state is no longer busy before cleanup.

Only the model response is controlled, so the task deterministically reaches a browser read. A finite real renderer busy loop injects the fault; BrowserAutomationService itself is not replaced by a pending-Promise stub. The wrapper only starts this fault and records the real operation's signal/error. The rendered shell/selected task is a fixture, not the user's running application or a full installed-app startup test. Unused optional D2 diagram loading is external in this test bundle; no diagram is rendered.

Final result: actual click → correct task ID at IPC → AbortError with aborted native signal → AgentService abort returned → persisted history busy=false → renderer stopped=true. See [UI stop result](evidence/browser-46-47-followup/ui-stop.json). Run `node scripts/run-browser-stop-ui.cjs` in an available isolated GUI slot. It does not contact a real provider or repeat six-task/full-regression tests.

Original #47 acceptance mapping:
- Read/target/snapshot waits, common deadline: existing browser contract tests plus real busy-renderer abort/deadline supplement.
- Pre-dispatch cancellation: existing contract input count=0; post-dispatch unknown outcome and no replay: existing contract and failure-recovery tests.
- Late reply and document/request identity: existing latest-wins/document guards and navigation contract tests.
- Independent tab: existing pending-A contract plus real-tab recovery supplement; these are separately described, not conflated.
- Listener/timer cleanup and success/navigation/screenshot controls: original focused contract/recovery evidence and integrated rerun in browser-46-50 review.
- Real Electron renderer nonresponse/destruction: the 15-group supplement; actual user stop entry: this mounted production-button integration.

The first UI driver ended after the tool aborted but before the host IPC/history finished and closed its database too early. That result was rejected as incomplete. The driver now waits for host return, history and renderer state. Missing unrelated settings/profile IPC handlers in that first driver were connected to the real AgentService. Final run has no such errors. No product source was changed to make tests pass.

