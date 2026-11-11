# Managed built-in browser tabs

The native `BrowserHost` is a registry of sandboxed `WebContentsView` documents. It does not substitute an external browser. Every tab shares the existing `persist:extension-browser` session, while its document, history, capture generation and screenshot queue are independent.

## Ownership and selection

- `ensureTab({ key, taskId?, gadgetId?, activate? })` returns a `BrowserTabInfo`. Identity is the pair `(taskId, key)`, not the current URL. Shared `browserTabKey(url, gadgetId?)` gives `gadget:<id>` or `url:<initial-url>`; do not add a second task prefix.
- `getTabHost(tabId)` returns a fixed `BrowserPageHost` or `null`. Keep that handle for the entire automation operation. It does not follow the UI's selected tab. A removed tab must be reported unavailable, never silently rebound to another document.
- `BrowserPageHost` exposes `inspectionWebContents`, `url`, `captureVersion`, `navigateForAutomation`, `captureScreenshot`, and `readDocumentHtml`.
- `navigateForAutomation(url, signal?, { reload? })` preserves the existing document for an already-loaded identical URL unless a source revision requires explicit reload. It never changes UI selection.
- `markGadgetUpdated(gadgetId)` marks matching tabs dirty without navigation, UI activation or service startup. The next selection/open refreshes that source once. Ordinary reopen never refreshes; cancelled beforeunload retains the old page and explicit refresh remains available.
- `selectTab(tabId)` normally only switches native visibility and the active inspection target. It does not reload or destroy the previous document. The renderer keeps `{id,key,url}` per task so returning after internal navigation or a hidden-panel update restores the actual native tab, rather than opening a URL-derived duplicate.

## Compatibility and lifecycle

- Existing unkeyed `open(url)` / `navigate(url)` continue to operate on the selected legacy page. Existing file reopen refresh behavior is retained for unkeyed calls.
- Keyed `open(url, options)` creates or selects its managed document; reopening the same keyed document preserves DOM/JS state. `activate:false` never displays another tab over the current one.
- `close()` remains the legacy panel-dismiss operation. It hides the page without destroying retained tabs. `hide`, `show`, bounds, and modal blockers remain supported.
- Explicit `closeTab(id)` honors `beforeunload`. A cancelled close keeps the tab. A confirmed close removes its native view, inspection ownership, runtime probe binding and WebContents. `dispose()` closes every retained WebContents and screenshot presenter.
- Closing the last tab of a task does not close other tasks or disable the attached browser. `attached` indicates the host window exists even when no tab is selected.

## Popups

`target=_blank`, `window.open`, and `about:blank` script popups become managed tabs. They adopt the exact WebContents supplied by Electron's `createWindow` callback, preserving the opener, request body and Chromium navigation semantics. Allocating a replacement child instead can deadlock the native popup handshake. `openerTabId` identifies the source for automation; task/gadget association is inherited. Popup tabs outlive a closed opener. No external application is launched.

## IPC / preload

Existing methods remain. Additions are `getTabs()`, `ensureTab(options)`, `selectTab(id)`, `closeTab(id)`, and `onTabsChanged(callback)`. The state contains `activeTabId` plus serializable tab descriptors (`id`, stable `key`, `taskId`, `gadgetId`, `openerTabId`, current `url`, title and loading state). Tab-specific events must not overwrite a newer renderer navigation intent.

## Verification

- `test:browser-tabs-electron`: real native documents, A→B→A input/JS preservation, task isolation, in-flight fixed handles, shared-session popups/opener scripting, cancelled/confirmed close, blockers and resource cleanup.
- `test:browser-tabs-ui`: actual BrowserView with real Electron IPC and native BrowserHost; task switches after URL navigation, address blur, panel remount after background navigation, new/closed tab controls.
- Existing `test:browser-builtin-electron`, `test:browser-refresh`, and `test:browser-screenshot-electron` preserve their behavioral coverage. Screenshot fixture inspection follows each tab's capture owner.

All GUI tests use isolated profiles. If the machine's `/tmp` quota is exhausted, set `TMPDIR` to a private directory under `out/tests`; never use the user's live profile.
