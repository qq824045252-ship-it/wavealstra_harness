# Browser screenshots and scoped Computer Use Stop

Delivered on 2026-10-03. Hidden browser screenshots now return current page pixels, and the Computer Use Stop control cancels that operation while the parent Pi task can continue with its native tools.

## Cause and repair

The browser's WebContentsView initially had no usable viewport. Once dimensions were supplied, hidden native views could still execute DOM reads and clicks while screenshot requests returned empty pixels, `UnknownVizError`, or never completed. Reconnecting CDP, nudging dimensions, and parking the view outside the window did not reliably produce fresh frames.

BrowserHost now supplies an initial viewport and owns one serialized screenshot path for `browser_exec` and `ui_exec(target=browser)`. When the page cannot present frames in the main window, the same view temporarily moves to an opacity-zero, mouse-transparent, nonfocusable native window. Its document, cookies and debugger session remain the original ones. Hiding the window, minimizing it, or adding a panel blocker during capture activates this same rendering path. Cleanup reapplies the latest renderer layout and visibility after the native snapshot finishes.

The screenshot command captures the viewport without device emulation or dimension nudges. Caller cancellation and the total deadline include queue admission. Native work drains before another screenshot enters; cancelled or stale results cannot become tool images. A permanently unresponsive native request remains isolated behind the queue rather than overlapping subsequent requests.

The Stop control previously called `AgentService.abort`, cancelling the entire task. It now aborts the task's Computer Use operation scope. Pending Windows requests, screenshot materialization and Vision work observe that signal; a cancelled scope cannot retry desktop actions. Task completion releases the scope, and a late failure from an older scope cannot settle a newer run's overlay. The overlay displays "等待下一步" between actions and leaves Stop clickable during actions.

Electron and Chromium source inspected for the capture semantics: [Electron CapturePage](https://github.com/electron/electron/blob/v44.5.1/shell/browser/api/electron_api_web_contents.cc), [Chromium PageHandler](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/content/browser/devtools/protocol/page_handler.cc).

## Validation

- [Real Electron regression](../artifacts/computer-use-browser-repair/production-capture/results.json): 60 checks. Includes 50 continuous, content-changing screenshots across hidden, inspector, blocker, minimized and visible states; transitions during capture; cancellation before and after the native acknowledgement; late results; deadline-bound queue admission; navigation and layout invalidation. Temporary native windows and debugger owners are released, and the original inspector remains attached.
- [Final packaged desktop acceptance](../artifacts/computer-use-browser-repair/desktop-live-final/results.json): two cases passed using `commandcode/deepseek/deepseek-v4.1-flash-fast`. The real model read a random visual marker solely from native screenshot tool images, clicked the fixture exactly once, and read the changed pixels. The actual overlay Stop produced a cancellation tool result, followed by a successful native `write` in the same task.
- [Before click](../artifacts/computer-use-browser-repair/desktop-live-final/browser-native-0.png) and [after click](../artifacts/computer-use-browser-repair/desktop-live-final/browser-native-1.png) are the actual tool-result PNG files. Temporary test credentials were removed; renderer errors were empty.
- [Pi native core comparison](../artifacts/pi-native-core-tools/results.json): 16/16 passed, `hostCalls=0` for `read`, `write`, `edit`, and `bash`.
- Typecheck, production build, remote build, browser recovery, capture mode and actual browser refresh passed. Computer Use run, overlay, recovery, automation and media cancellation transaction tests also passed during this repair.

## Running build

The final portable is `C:\Users\servi\AppData\Local\Programs\MyBuddy\portable\release-computer-use-browser-20261003-final\win-unpacked\MyBuddy.exe`.

Accepted `resources/app.asar` SHA-256: `b5628c521efca39389910ee32038c0280c742128ff3ae9bf114c593bd92d3adf`.

[Deployment evidence](../artifacts/computer-use-browser-repair/deployment.json) records idle checks, a consistent database/settings/shortcut backup, the updated desktop shortcut, renderer readiness, remote health and the independent post-launch persistence check. Existing user configuration is preserved. The portable contains the working tree used for the build; unrelated concurrent changes remain outside this repair's Git commit.

The first packaged acceptance stopped on a harness selector quoting error; its screenshot case passed. The corrected harness was rerun against the final exact archive. Earlier diagnostic failures are retained locally. Automatic approval rejected cleanup of older diagnostic temporary directories; those directories remain, with their test processes exited.

## Package consolidation

On 2026-10-03 the user confirmed that the later desktop exits were intentional. The additional deployment-recovery experiment was withdrawn; these exits are not evidence of a crash.

Only the accepted final portable above remains. Cleanup removed 12 obsolete complete packages and one incomplete package from the portable directory and repository build outputs, reclaiming 16,663,964,204 bytes (15.52 GiB). Desktop and Start Menu shortcuts both target the retained executable.

[Cleanup evidence](../artifacts/package-cleanup-20261003/results.json) records the resolved package paths, inventory, FastCopy exit codes, absence checks, retained archive hash, and the original desktop process remaining alive. The [one-time cleanup script](../artifacts/package-cleanup-20261003/cleanup.mjs) ran from Git Bash, rejects redirected paths and tracked source files, and checks for active package processes before each deletion. A final scan of the package roots found only the retained MyBuddy executable and archive.

## Reproduce

```powershell
pnpm run test:browser-screenshot-electron
pnpm run test:computer-use-run
pnpm run test:computer-use-overlay
pnpm run test:media-artifact-transaction
pnpm run test:pi-native-core-tools
pnpm run typecheck
pnpm run build
$env:COMPUTER_USE_DESKTOP_EXE = 'C:\Users\servi\AppData\Local\Programs\MyBuddy\portable\release-computer-use-browser-20261003-final\win-unpacked\MyBuddy.exe'
$env:COMPUTER_USE_MODEL = 'commandcode/deepseek/deepseek-v4.1-flash-fast'
$env:COMPUTER_USE_ARTIFACT_DIR = 'artifacts/computer-use-browser-repair/desktop-live-recheck'
pnpm run test:computer-use-desktop
```
