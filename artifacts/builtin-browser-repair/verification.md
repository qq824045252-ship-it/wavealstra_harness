# Built-in browser repair, 2026-11-11

## Evidence and diagnosis

The supplied screenshot was correlated with the exact Windows execution diagnostic and its durable tool record, read-only. That invocation was `browser_exec.navigate` to a previously returned loopback Gadget URL and failed with Chromium `ERR_CONNECTION_REFUSED (-102)`. Its original tool result contained the reason; the execution diagnostic persisted an empty diagnostic list.

In that task, 24 of 25 browser operations succeeded. The recorded application startup happened between the original Gadget open and the refused navigation. Opening the Gadget again returned a new process/port, after which navigation succeeded. This establishes an expired preview URL across an app restart, not a provider failure or proof that `gadget_update` killed its server. No production database or history was rewritten.

Separately, the pre-repair BrowserHost sends every HTTP(S) `target=_blank`/`window.open` request to `shell.openExternal`. An untouched main snapshot reproduced this in a real isolated Electron instance: the destination was not reached in the WCV and the external-open recorder counted one launch. The repaired test reaches both popup destinations using the same WCV, with zero external launches.

## Changes

- HTTP(S) page popups stay in MyBuddy's sandboxed Electron browser, preserving its session and tool visibility. The explicit user command to open externally is unchanged.
- `browser_exec.read` returns visible interactive targets with verified CSS selectors. It does not copy editable values into target metadata, omits hidden controls, bounds the target list, and retains the existing fresh-observation safety checks.
- Browser text preserves rendered table-cell tabs and line breaks. The live test exposed the previous `textContent` concatenation of `17` and `3` into `173`.
- Navigation failures retain their machine code and underlying cause. Refused local preview connections point to `gadget_open` for a current URL rather than blindly retrying an old port or switching browsers.
- `gadget_update` reports saved-source success separately from current preview health and URL. A stopped preview requires reopening; the source edit is not replayed.
- The production extension-to-durable adapter and native/codemode observer preserve bounded, redacted structured error details. Informational reading markers and ordinary command exit codes keep their original classification. Historical empty diagnostic rows are not backfilled.

## Verification scope

Runs use an independent main checkout and temporary profiles. Production processes, user data, and unrelated edits were not changed. Tests run on the Omarchy desktop; Windows was used only for read-only diagnosis. This is not a packaged-release or Windows GUI acceptance claim.

Focused checks: typecheck, builtin-capabilities, browser-automation-recovery, durable-tool-diagnostics (native and codemode), diagnostics-rules, task-diagnostics, local-capability-checks, gadget-blueprint, gadget-preview-recovery (normal start/stop/reopen), browser-builtin-electron, and test classification audit. The full headless suite was not run for this scoped change. No new process crash/fault injection was performed.

The live harness calls the actual gateway model with production browser and Gadget extension definitions and actual BrowserHost/BrowserAutomationService/GadgetRuntime implementations. It is a real Electron/model tool loop, not the entire application's main-UI agent flow. Synthetic fixture pages and an isolated database are used; no real credentials or user content are sent.

Six distinct task classes are required per batch: rendered table arithmetic, form fill/submit, target-blank navigation, local HTML preview, running Gadget update, and stale URL recovery after normal preview stop. The last deliberately requests the refused URL once, verifies the error, saves once, opens the current preview, then reads the saved result.

Initial six-case discovery batch completed all six, but included three avoidable model tool mistakes from missing selectors plus one intentional refused connection. Its initial fixture system text incorrectly promised structured targets; this was removed and the caveat retained in the evidence. A subsequent selector-only batch passed five cases and encountered a model gateway `fetch failed` on the sixth; it is retained as failed, not counted as a browser pass. Final evidence is recorded separately in `live-summary.json` after all six finish.

The machine's per-user `/tmp` quota blocked a setup attempt. Only test profiles were moved into the isolated checkout and rerun; no unrelated temporary data was deleted.

## Final results

Final source passed all six real-model tasks using selected and actual response model `opendesign/deepseek-v4.1-flash-eco`: 26 real tool calls, zero unexpected tool errors. The only error was the intentional stopped-preview navigation. Table text was explicitly observed as separate tab-delimited cells; form controls used observed selectors. The saved edit was performed once in each Gadget case and preview recovery obtained a current URL before navigating.

The existing full screenshot regression passed ten captures each in hidden, inspector and blocker modes, then timed out in its minimized phase. The narrower existing `--local-preview-only` run passed navigation, read, click and a nonempty screenshot. The full screenshot suite is not claimed as passed.
A separate plain-Electron probe on the same Wayland session confirmed `BrowserWindow.minimize()` produced neither a `minimize` event nor `isMinimized=true` within the probe interval, without involving BrowserHost. This explains the existing suite's event wait; no system settings or test assertions were weakened.

Independent focused code review found no blocking regression in routing, target metadata, diagnostics, or update/preview separation.

## Follow-up: minimized screenshot limitation resolved

Further real-window investigation distinguished the original fixture mapping race from actual native capture and temporary-window lifecycle problems. The full screenshot suite subsequently passed with real minimization and strengthened delayed-state/cleanup assertions. See [the follow-up evidence and scope](minimized-capture-followup.md); the earlier paragraph remains a record of what had and had not passed at the initial commit.
