# Minimized browser screenshot follow-up, 2026-11-11

## Confirmed layers

The earlier full screenshot-suite timeout had more than one cause. This follow-up supersedes the pending screenshot limitation in the initial verification report.

1. **Fixture precondition race.** In plain Electron 44.5.1 on the same Hyprland/Wayland session, `showInactive(); minimize()` immediately did not minimize the window. Waiting 250 ms or 1500 ms did. Waiting for `ready-to-show` alone also did not guarantee native mapping. The original fixture waited indefinitely for a minimize event after a request issued too early. It now retries only its own isolated window transition with a 3 s bound and requires `isMinimized() === true`.
2. **Actual screenshot producer stall.** Once genuine minimization was established, the real BrowserHost could time out waiting for Chromium's screenshot frame even though the transferred WCV reported `document.visibilityState === "visible"`. Native visibility refresh on the exact leased surface recovered the frame. A single 300 ms refresh passed initial checks but failed a repeat; the final implementation uses a bounded 300/700/1500/3000 ms recovery sequence. It does not reissue the screenshot command, emulate the viewport, or restore/focus the main window. All pending timers are cleared when the lease releases.
3. **Native temporary-window destruction restored the main window.** A plain-Electron control, with no MyBuddy code or WCV transfer, showed that displaying then destroying an empty inactive temporary window asynchronously restored an already-minimized window. Without a shown temporary window the main window remained minimized. Hiding before close and changing native window type/focusability did not fix it. BrowserHost now keeps at most one empty noninteractive presenter while its main window is minimized, reuses that exact presenter, and destroys it on main-window restore/close or host disposal. The real browser WCV is returned to the main window after each capture; the parked presenter has no child page content.

## Verification

All runs use the existing independent checkout and temporary profiles. No production process, user data, desktop settings, package, or installation was changed. No new process crash injection was added.

The final screenshot implementation passed the complete real-Electron suite three times consecutively, 64 checks per run (the third after rebase). Coverage includes 50 changing screenshots across hidden, inspector, blocker, genuinely minimized and visible states; local-file preview; real hide/minimize/blocker transitions during capture; prompt cancellation; late native results; queued timeout/cancellation; stale layout/navigation rejection; and subsequent recovery.

The strengthened checks validate the actual minimized state after native events settle, exact presenter ID reuse, an empty/nonfocusable presenter, the WCV's original ownership and viewport, cleanup after explicit restore, no windows after disposal, and no delayed state changes after recovery timers have expired. This is not a skipped/minimization-simulated pass.

Typecheck, capture-mode 26/26, browser-automation-recovery, browser-builtin-electron and classification audit passed. The full headless suite was not run for this scoped fix. Windows GUI and packaged-release acceptance were not run. The timing recovery is an empirically verified bounded workaround for the tested native rendering path, not a claim that every compositor/driver has been exercised.

See `minimized-capture-results.json` for the final full-suite result and per-capture hashes, sizes and timings. The real-model regression is recorded separately; screenshot pixels/state transitions are tested directly in Electron, while the existing model batch covers six distinct browser/Gadget DOM and navigation tasks.

The additional six-type real-model batch passed 6/6 using actual response model `opendesign/deepseek-v4.1-flash-eco`: 26 tool calls and zero unexpected tool errors. The one intentional stopped-preview navigation recovered correctly. See `minimized-followup-live-summary.json`. This batch ran against the final BrowserHost implementation before the conflict-free rebase over the separately completed Gadget export commit; focused type/capture/browser checks were repeated after rebase.
