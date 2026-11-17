# Managed built-in browser tabs

The native `BrowserHost` is a registry of sandboxed `WebContentsView` documents. It does not substitute an external browser. Every tab shares the existing `persist:extension-browser` session, while its document, history, capture generation and screenshot queue are independent.

## Browser routing

- Agent HTML and web interaction uses `browser_exec` in a task-owned built-in tab. Prefer navigate plus `after: { mode: "text" }` when the goal is to open and read. Report unavailable or failed navigation; do not substitute a system browser or native Computer Use. Background automation can keep its tab without stealing foreground focus.
- Ordinary app HTTP(S) links, including localhost, open in the sidebar. Registered HTML artifacts may also render in their isolated preview; links leaving that preview stay inside the app. System browser launch is reserved for explicit UI controls. OAuth provider links are handed to the user for manual authorization rather than launched automatically.

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

### Hover menus and form controls

`browser_exec` supports `hover`, `scroll`, `select`, and `check`. `find` and `inspect` return visibility, disabled state, bounds, checkbox state, and native select options. `read` includes a bounded option summary. `inspect` returns at most 80 options and reports `optionsTruncated`.

A flyout can close between separate calls. For a menu such as 账簿 → 凭证汇总表, pass its hover ancestors with the final click:

```javascript
await tools.browser_exec({
	action: "click",
	role: "link",
	name: "凭证汇总表",
	hover: [{ role: "button", name: "账簿" }],
	after: { mode: "interactive" },
});
```

The `hover` array accepts one to eight locators. Each locator can specify `selector`, `role`, `name`, or `text`. The service discovers and hovers each ancestor in order, then discovers the target. All steps share one fixed tab, one native presentation lease, and one deadline. An existing observed reference keeps its node identity. A replaced node is rejected rather than rebound to another node.

Native `<details>` disclosures appear through their first `<summary>` control, with role `button` and an `expanded` state. Hidden descendants report `hiddenBy` with the observed summary reference needed to reveal them. Nested disclosures report the outermost closed ancestor first. The service does not expand disclosures automatically. Successful actions through an observed reference also settle pre-action failures for that returned element's proven `#id` alias.

The real task `日历任务笔记三合一Gadget设计` exposed missing summary semantics, an attempt to click a copy button inside a closed disclosure, and a recovery card left after `#capInput` was successfully filled through its node reference. Its native journal also contains ordinary request errors: `fill.value` instead of `fill.text`, an `after.maxChars` value below the schema minimum, and a selector that did not match the document. These errors are distinct from unsupported frames or Shadow DOM. The original Gadget HTML and data were served read-only in an isolated Electron profile to verify summary discovery, disclosure expansion, copy-button visibility and capture-input filling. No live task state, source data, pending submissions or system clipboard was changed. Rerun that optional check by setting `BROWSER_GADGET_FIXTURE_DIR` to the Gadget's `code` directory before `pnpm -s test:browser-task-execution-electron`.

`scroll` uses `delta_x` and `delta_y`, with positive values moving right and down. Without a locator, it sends wheel input within the current viewport. With a locator, it scrolls the observed container. `select` accepts an array of option values in `values`, dispatches DOM `input` and `change` events, and checks the accepted selection. These select events are synthetic. Custom dropdowns use `hover` and `click`. `check` accepts `checked: true` or `false` and does not click when the requested state already holds. `press` focuses the element and sends the key without an extra click.

Clicks scroll the target into view with instant behavior, sample stable geometry, and check several points inside the visible client rectangles. They wait up to 1.5 seconds within the invocation deadline for transient visibility or occlusion to clear. Hidden ancestors and disabled fieldsets are detected. A persistent obstruction returns blocker metadata. A trusted input receipt is awaited in the original document before dispatch, allowing a confirmed link click to navigate without reporting the expected document replacement as a failure.

Navigation can start after the trusted click receipt, even while `isLoadingMainFrame()` still reports false. If the same retained tab changes document during `after`, the service restarts only its read-only observation against the new document. The original deadline still applies. The input action is never repeated.

Successful corrected actions resolve matching pre-action recovery notices. A successful link navigation uses `sourceUrl` to settle the failed click on the page it left. Semantic locators distinguish different menu items. Errors include dispatch evidence in the model-visible response. Unknown effects require readback before any repeat submission.

The real Electron regression includes a collapsed flyout whose child is initially invisible, hover-path navigation, partial occlusion, ancestor opacity, transient visibility, nested scrolling, single and multiple select, checkbox idempotence, and an Enter-triggered submission count of one. These are isolated local fixtures. They do not establish acceptance on an authenticated 柠檬云 account. This earlier hover-only checkpoint excluded frame documents and Shadow DOM; the capability reference below supersedes that boundary.

The earlier 2026-11-17 hover-only run passed the browser contract, recovery, Durable composition, native tool policy, UI recovery and cancellation, built-in browser, managed tabs, and task-execution tests. The task fixture opened a slow report three times and received exactly three report requests, including navigation during after-observation. Screenshot regression passed 64 checks on a standalone repeat; its first run failed a minimized-window visibility assertion, so stability is not established by that repeat. Full typecheck remained blocked by concurrent Bot/Work removals and their remaining script imports. Full headless, GUI, and ARTIFACT gates were not run.

- `test:browser-tabs-electron`: real native documents, A→B→A input/JS preservation, task isolation, in-flight fixed handles, shared-session popups/opener scripting, cancelled/confirmed close, blockers and resource cleanup.
- `test:browser-tabs-ui`: actual BrowserView with real Electron IPC and native BrowserHost; task switches after URL navigation, address blur, panel remount after background navigation, new/closed tab controls.
- Existing `test:browser-builtin-electron`, `test:browser-refresh`, and `test:browser-screenshot-electron` preserve their behavioral coverage. Screenshot fixture inspection follows each tab's capture owner.

All GUI tests use isolated profiles. If the machine's `/tmp` quota is exhausted, set `TMPDIR` to a private directory under `out/tests`; never use the user's live profile.

## Browser automation capability reference

The current tool supports selected nested same-origin and cross-origin iframe documents, open Shadow DOM, and Chromium accessibility observation. Existing application iframe previews remain in place. `BrowserHost` owns tabs and native presentation. `PageInspectionSession` owns the debugger; automation, diagnostics, accessibility, screenshot capture, and selection UI share it. Exiting selection mode does not detach active diagnostic consumers.

`frames` returns opaque native frame identities. Pass `frameId` to document observation and input actions. A context binds the selected document and every ancestor by native frame identity and a per-document nonce. Reloads, removed frames, changed owners, and ancestor occlusion reject stale input. Frame geometry supports borders, padding, ancestor scrolling, and positive axis scale. Rotated or perspective geometry returns `UNSUPPORTED_SCOPE`. Child documents are observed explicitly rather than silently merged into the parent.

DOM observation searches open shadow roots. Text reading follows assigned slot nodes, and input hit testing and focus follow the composed tree. Closed roots are excluded. `within` must select one container. `exact`, `label`, `placeholder`, and `testId` refine locators. `accessibility` returns bounded Chromium names, roles, and states for one document. `find({axNodeId,documentId})` converts a node from the latest AX snapshot to an observed DOM reference. AX node numbers alone are insufficient because backend IDs can collide across renderer processes.

`assert` accepts 1 to 16 `expect` conditions. The supported kinds are `url`, `text`, `value`, `count`, and `state`. Input actions can also include `expect`. `businessResult` reports those conditions independently of `outcome`, which records input dispatch and receipt. Failure retains the last condition evidence. Password values are redacted. An observation or assertion never repeats a mutation.

`response` and `download` are armed before their associated action under a per-page operation queue. Responses must belong to requests started after arming. Diagnostics record bounded requests, responses, failures, console messages, and exceptions, including child-target session identity. URLs omit credentials, query strings, and fragments. These are time-window associations, not proof that a particular request was caused by a particular handler. Response status alone does not establish business success.

`upload` accepts 1 to 20 regular files under the trusted task directory and an observed file-input reference. Canonical path checks reject directory escapes and junction escapes. Native multiple selection requires a multiple file input. Chromium receives actual files through the selected Runtime context, and the returned FileList is checked. Upload does not submit the form. `download` waits for actual completion and returns path, byte count, and SHA-256. The registered tool also registers a file artifact. Registration failure retains the completed download and action outcome; it does not invite another click.

`dialogRules` provides one-shot alert, confirm, prompt, and beforeunload answers. `diagnostics` reports a pending dialog, and `dialog` answers its exact ID without joining the blocked page action queue. Electron's unsupported prompt wrapper requires a guarded internal adapter; unknown Electron handler shapes fail explicitly. Site-owned prompt overrides remain unchanged. Native prompt return values preserve string, empty string, default text, and cancellation null. For beforeunload, navigation, history, reload, and close can prearm an accept or dismiss rule. An unmatched request is safely canceled. A late accept does not recreate the discarded navigation; the caller must explicitly retry the original operation with a rule. A denied navigation is settled before a retry can proceed.

`collect` requires stable row keys, cell selectors, and an explicit terminal rule. It combines virtualized or paginated rows and can scan horizontal virtual columns using numeric column indices. Row and column indices start at zero. `queryIdentity` identifies a filter revision. Supply it when filters can change without a URL change. A `scroll-end` rule requires `expectedRows`; reaching the current bottom alone does not prove an infinite feed is complete. Budget exhaustion, gaps, changed filters, conflicting rows, and missing progress produce `partial` with a reason. A continuation remains bound to the task, tab, document, and query. When the result exceeds the inline character budget, `collectionFile` contains all collected data as checked JSON and `collectionArtifact` identifies the registered artifact. `outputTruncated` refers to the inline preview, not the saved JSON.

`click` supports `button:right`, `clickCount:2`, and control, alt, shift, or meta modifiers. `fill` supports sequential Unicode text and contenteditable controls. Native date, time, datetime-local, month, and week fields use an explicit synthetic setter strategy and verify validity. Native select change events are also synthetic. `drag` uses observed source and destination references. The pointer path retains and releases its own input. HTML5 source-data transfer is selected with `dragMode:html`; it uses Chromium interception and the real source data rather than caller-supplied file paths.

`screenshot` returns a one-use `captureId` and viewport metadata. `click_at` and `scroll_at` require that capture and screenshot pixel coordinates. The service validates the exact task, tab, frame document tree, viewport, scroll, zoom, and decoded pixels before sending browser-local input. Canvas-only changes invalidate the capture. Animated content or caret changes can therefore require a fresh screenshot. Unsupported pinch offsets fail explicitly.

`open`, `select_tab`, `close`, `back`, `forward`, and `reload` operate on the current task's retained tabs. Closing waits for actual destruction, and same-document history changes count as navigation completion. `handoff({tabId,reason:'login'})` or reason `2fa` presents the existing tab and uses the real persisted conversation interaction. Human waiting is outside the page action deadline. Only an affirmative user answer issues a token. `resume({tabId,token,expect})` checks current page conditions on that same tab and consumes the token only after verification. User secrets remain in the browser; the agent cannot supply its own completion answer.

The focused fixtures exercise the actual Electron engine, public service, registered tool, Durable Code Mode, real user-interaction service, and artifact registration. They use isolated profiles and local servers. They do not establish authenticated-site acceptance on 柠檬云 or replace the repository-wide headless, GUI, and packaged ARTIFACT gates. No product build, package, installation, commit, or push was performed for this change.

## 现场报告回归补充

普通容器的名称使用自身文本，不把整个后代子树聚合成容器名称；显式角色控件仍保留完整组合文本。因此展开子菜单不会让 body 或导航容器和“账簿”菜单锚点撞名。确有同名目标时，歧义错误返回有界 `candidates`，这些引用同步记入当前文档观察，可直接选择其中一个继续操作。定位歧义由 Agent 修正，不创建需要人工恢复的卡片；结果未知的实际输入仍保留原有保护。

可信输入回执只在事件路径包含预期节点时确认。监听期间的其他可信事件不会提前将回执判失败。原始 hover 菜单夹具、名称和引用两种祖先定位、真实重复名称，以及先发生无关可信点击的干扰用例均有隔离 Electron 回归。

Gadget 导航还会查询当前任务持久对话及原生归属的子对话中的成功宿主回执，以恢复应用重开后丢失的进程内端口映射。只使用结构化工具字段，不从用户文本、模型陈述或页面源码推断归属。恢复后仍走 GadgetService 的任务可见性校验；未知或歧义的端口不猜测，不重放输入。此路径与 `gadget_read` 的结构化分页通过真实 Durable Code Mode 组合用例验证。柠檬云登录态过期仍属于站点状态，未以本地菜单测试替代真实登录后验收。
