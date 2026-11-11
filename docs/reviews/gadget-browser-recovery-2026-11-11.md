# Gadget preview and managed browser recovery

## Two different failures

The reported Windows session successfully opened one Gadget, later received connection refusal at its old port, then succeeded after `gadget_open` returned a new port. The original process-exit cause was not recorded, so this change does not claim to identify it retrospectively.

A separate real Electron baseline on Omarchy demonstrated the single-document issue: A → B → A reused WebContents 2 and lost the unsaved input in A, while the Gadget PID remained unchanged and its health check stayed running. Replacing the browser document did not stop the Gadget service. Normal explicit service stop/reopen independently reproduced old-port refusal and a new port.

## Repair

- Native managed tabs retain independent documents, inputs, history and capture owners. Task ownership is separate from visible-tab selection. Popups stay in the built-in browser and retain their opener semantics.
- The renderer returns to a retained tab by identity, including after internal URL navigation, task switches and panel dismissal. Dismissing the panel is different from explicitly closing a tab.
- Gadget navigation resolves known loopback preview origins within the calling task's visibility. An explicit `gadgetId` supports unambiguous recovery after a port collision or application restart. Reused ambiguous ports are rejected; the localhost alias receives the same scope check.
- Recovery never replays a source edit, click, fill or key press. Async service recovery cannot overwrite a newer navigation in its target tab.
- Source revisions and local-file timestamps distinguish revisiting an unchanged document from loading edited source. Only source writes invalidate Gadget tabs; renaming/moving metadata does not. Hidden source changes are refreshed on later selection without activating the tab in the background.
- Per-Gadget lifecycle queues serialize start, health, stop and restart. The former `startOne → stop → starts` self-wait is removed. Reuse requires a live owned child and an actual HTTP health response.
- Structured diagnostics distinguish explicit stop, restart, unexpected exit, startup failure and health failure. Exit code, signal, PID, previous URL, stderr and timestamps are recorded when actually available. A pre-spawn failure never borrows a previous child's exit details.

## Verification on the isolated Omarchy checkout

No production checkout, profile or running user instance was changed. No application package/build or shortcut was produced.

- TypeScript: web, main and scripts checks passed.
- Native tab lifecycle: 10 behavior groups passed, including beforeunload cancellation, popup parent retention, shared session, blockers and resource cleanup.
- Actual BrowserView + Electron IPC + native BrowserHost: 5 behavior groups passed, including task changes after internal navigation, address blur/tab-switch races, dismiss/background navigation/remount and last-tab close.
- Existing browser popup, refresh and screenshot regressions passed; screenshot suite retained 64 checks.
- Gadget/browser integration: 10 groups passed, including A/B input preservation, task/loopback scope, normal-stop stale URL recovery, no write replay, single-child concurrent recovery, explicit close, target-tab race protection, file updates and ambiguous-port refusal.
- Gadget runtime, source/blueprint, renderer binding and browser failure-recovery focused tests passed. Failure injection ran only after normal lifecycle coverage and only against fixture-owned processes.
- Six distinct tasks using the actual `opendesign/deepseek-v4.1-flash-eco` model and production tools all passed: table calculation, form filling/submission, target-blank navigation, local HTML, running Gadget update, and stopped Gadget recovery/update. The final stopped-preview case recovered port 41087 to 42097 and modified source exactly once. Seven task-owned tabs for six task owners coexisted.

Local evidence is under `out/diagnostics/gadget-recovery`, `out/diagnostics/browser-tabs`, `out/diagnostics/browser-tabs-ui`, and `artifacts/gadget-browser-recovery-live/final-results.json`. Generated diagnostic files remain local as required by repository policy.

## Aggregate gate qualification

One full headless run executed 452 cases: 440 passed and 12 failed initially. The run used a repository-local temporary directory because the machine's `/tmp` quota was exhausted. Seven failures were fixture-environment effects (Git ancestry or Unix socket path length) and passed when rerun with a short private temporary directory outside the checkout. Four declaration/test contracts were synchronized and rechecked: store fields, IPC inventory, credential-import ordering and the renderer refresh assertion.

The remaining `test:bot-work-phase3-handoff` failure also reproduces in pristine main at `fdbc0b7`: the test expects an owner registered without explicit authorization to be rejected, but `handoffOwner` returns success. This unrelated existing failure was not changed or added to `test-baseline.json`. The aggregate run is therefore not reported as a completely green suite.

This is Omarchy/Linux acceptance. Windows/macOS GUI acceptance and the full aggregate GUI/ARTIFACT suites were not run. Retained documents live for the current application process; unsaved page state is not promised to survive an application restart.
