# Side browser menu occlusion — 0.1.69

## Cause and reproduction

The extension menu is renderer DOM, while BrowserHost's WebContentsView is a
native child view above that DOM. In 0.1.68 the top menu and mode dropdown did
not register visibility blockers. The lower menu rows therefore remained in
the DOM but were covered by the browser and could not receive desktop clicks.
CSS z-index cannot change native child-view stacking.

Replayed the original path against the accepted 0.1.68 package with an isolated
HOME/userData and a real Gadget: Open → top menu. The native-window screenshot
shows only the first two menu rows above the webpage, and the regression fails
because the native view is still visible while the menu overlaps its bounds.
Evidence: `out/diagnostics/browser-menu/before/{top-menu.png,results.json}`.

## Ownership change

ExtensionTopBar now owns one existing `useBlockNativeSurfaces` token for the
overlay it actually renders: the top menu without file tabs, or the file
flyout with tabs. ExtensionModeDropdown owns its own token while open.
HtmlArtifactView no longer separately owns the flyout's visibility; its text
prompt uses the same shared hook with an independent token.

The invariant is that each rendered overlay keeps both native surface hosts
blocked until that overlay closes or unmounts. A nested menu cannot release
its parent's token. Bounds reports continue to flow through the existing
main-process visibility synthesis and cannot override blockers. No navigation,
reload, document destruction, new IPC channel, timer, or CSS stacking workaround
was introduced.

## Verification

`scripts/gadget-task-desktop-test.cjs` runs the full application on a real
Windows desktop, using temporary profile directories and fixture data. It now
checks native visibility as well as DOM geometry, because synthetic clicks
alone can pass even when a native view obscures their target.

- Both menus display all six choices and overlap the browser's bounds while
  the browser is hidden. Screenshots use desktopCapturer, which includes native
  child views, rather than BrowserWindow.capturePage.
- Layout reports while open do not reveal the browser.
- Escape restores the same document, including in-memory JavaScript state.
- HTML artifact and browser flyouts both hide their native surfaces.
- Closing a nested dropdown retains the pinned flyout's blocker.
- Closing the panel while its flyout is open leaves the browser closed;
  reopening releases all old blockers and displays the browser again.
- The existing Gadget editing, clipboard, resumed-agent flow and cancellation
  regression cases still run.

Release evidence is retained under `out/diagnostics/browser-menu/`: typecheck,
full headless gate, build/package, packaged payload verification, actual
packaged desktop results/screenshots, and shortcut read-back.

Results: typecheck passed with zero new baseline errors; all 247 headless
tests passed; all nine packaged desktop scenarios passed at 0.1.69. The
packaged payload contains all 588 unpacked entries and starts the worker at
the version specified by `EXPECTED_PI_VERSION`. Desktop and Start Menu
shortcut target, working directory, icon and application identity were read
back and matched the accepted build.
