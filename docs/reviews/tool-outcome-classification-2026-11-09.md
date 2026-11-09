# Browser pre-execution failure settlement

Base: main `8aa1d73`.

## Confirmed defect and change

`DurableToolPolicy.afterTool` treated a failed potentially mutating browser call as unknown even when the browser service rejected its parameters before accessing the browser. `settleWorkAdmission` then created an external-effect blocker.

BrowserAutomationService now validates the complete browser request before accessing its host. On validation failure it writes a host-owned durable checkpoint scoped to tool name, call ID, native task ID and conversation ID. Settlement consumes only this checkpoint, never model arguments, result details or error strings. The original failure remains visible to the model. This exact admission is released without an unknown-effect blocker. No authorization settings or existing Work data are changed.

Errors after execution begins remain conservatively unknown. A failed process may have already created output. Pure read failures remain released under existing classification. This is not a blanket conversion of failures to success or not_started, and it does not clear historical unknown records.

## Verification

- Typecheck: passed, including scripts zero errors.
- `test:durable-tool-policy`: passed. Actual durable runtime checks invalid file URL and missing selector; started navigation failure remains unknown; read failure releases; forged output cannot produce host proof. A real child process writes a file then exits 2, retaining unknown.
- `test:browser-automation-recovery`: passed.
- Electron production BrowserHost/BrowserAutomationService: invalid file URL and missing selector leave URL/focus unchanged; a subsequent real click updates the document counter. Passed with isolated userData.
- Full headless suite: 396 passed, 1 failed (`test:expert`). An independent unmodified main `8aa1d73` clone reproduces exactly 73 passing/5 failing expert assertions. Baseline was not changed. Full gate is not reported as green.
- Full browser screenshot GUI suite is not green: first run timed out in inspector capture; second run passed hidden/inspector/blocker screenshot checks but exceeded the overall timeout during the minimized-window case. The new preflight/continue scenario passed both runs.
- Initial `/tmp` quota exhaustion was addressed by moving only this independent clone and its test TMPDIR onto the regular disk; no user profile or other worker data was removed.

## Not covered / separate follow-up

A real online-model replay of the user's full HTML task was not performed. The Windows user's four existing blockers and running binding were not modified. Shell/Python and screenshot-process failures cannot be declared not_started from exit text alone. Artifact discovery and a running binding that never receives a terminal observation are separate issues, not fixed by this change.
