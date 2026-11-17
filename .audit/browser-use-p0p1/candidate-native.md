# Native Electron browser candidate

Design only. Production code is unchanged by this candidate. Work phases: grounding complete; caller and type sketches complete; cross-candidate synthesis belongs to the parent; implementation and acceptance remain pending.

## Problem

Complete the requested browser operations inside the existing task-owned Electron tabs. The existing browser already preserves background/minimized presentation, receives trusted input through its inspection debugger, and distinguishes dispatched actions from confirmed effects. Its observations and input targets are still main-document CSS selectors. Adding frames, events, files, human handoff and long collections independently to that representation would create multiple owners for document identity and debugger lifetime. This candidate makes the retained tab the owner of a native automation session and gives every observation an exact document and node identity.

## Usage (caller's view)

Keep one `browser_exec` tool. Derive the accepted request variants, tool documentation and internal discriminated union from `BrowserToolContract.ts`. Existing basic actions remain names within this contract; new fields use `target`, `scope`, `expect`, `dialogs`, and `captureDownload`. Flat selector/role/name input is parsed once into the same locator representation while repository callers are migrated. It is not a second execution path. The examples are the proposed contract, not currently supported calls.

```ts
// A frame/shadow checkout form. Observation supplies opaque scope/node references.
const page = await tools.browser_exec({ action: 'open', url: checkoutUrl });
if (page.isError) throw new Error(page.error);
const tree = await tools.browser_exec({ action: 'read', tabId: page.tabId, mode: 'accessibility' });
// The returned tree includes frame/shadow scopes and per-scope coverage.
const save = await tools.browser_exec({
  action: 'find', tabId: page.tabId, scope: paymentFrameScope,
  locator: { kind: 'role', role: 'button', name: { exact: 'Save' } }
});
if (save.isError || save.elements.length !== 1) throw new Error('Save target not unique');
const submitted = await tools.browser_exec({
  action: 'click', tabId: page.tabId, target: { kind: 'node', ref: save.elements[0].ref },
  dialogs: [{ kind: 'confirm', message: { exact: 'Save invoice?' }, response: 'accept' }],
  expect: { kind: 'all', predicates: [
    { kind: 'text', scope: receiptScope, locator: { kind: 'role', role: 'status' }, contains: 'Saved INV-42' },
    { kind: 'response', url: { exact: saveApi }, method: 'POST', status: 201 }
  ] }
});
// Check businessResult. An accepted click alone does not prove a saved invoice.
```

```ts
// Upload an actual task file, export once, and consume a verified artifact.
const uploaded = await tools.browser_exec({
  action: 'upload', tabId, target: { kind: 'node', ref: uploadInputRef },
  files: [{ path: approvedLocalCsv }],
  expect: { kind: 'text', scope: importScope, locator: { kind: 'role', role: 'status' }, contains: '128 imported' }
});
if (uploaded.isError || uploaded.businessResult.kind !== 'passed') throw new Error('Import incomplete');
const exported = await tools.browser_exec({
  action: 'click', tabId, target: { kind: 'node', ref: exportButtonRef },
  captureDownload: { fileName: 'invoice-export.csv' }
});
// Result includes download completion, absolute artifact path, bytes and SHA-256.
// Timeouts report a pending/interrupted download identity; never re-click blindly.
```

```ts
// A collection can stop incompletely; a continuation never claims full coverage.
const batch = await tools.browser_exec({
  action: 'read_collection', tabId, scope: gridScope,
  collection: {
    rows: { kind: 'role', role: 'row' },
    key: { kind: 'attribute', name: 'data-order-id' },
    advance: { kind: 'next', target: { kind: 'node', ref: nextPageRef } },
    terminal: { kind: 'enabled', locator: { kind: 'role', role: 'button', name: { exact: 'Next' } }, value: false },
    maxRows: 10000, maxSteps: 100
  }
});
// Rows have stable keys and source page/position. completion is complete or partial.
const handoff = await tools.browser_exec({
  action: 'handoff', tabId, reason: 'Complete your sign-in and two-factor challenge',
  resumeWhen: { kind: 'visible', locator: { kind: 'role', role: 'button', name: { exact: 'Account' } } }
});
// The UI exposes this exact tab and a Continue control. No credential is requested.
// Continue resumes by handoffId, verifies retained tab identity and re-observes it.
```

## Current execution chain and constraints

| Current owner | Evidence read | Consequence |
| --- | --- | --- |
| Public tool registration | `src/main/capabilities/builtin-capability-extension.ts:735` registers `browser_exec`, normalizes snake-case fields, calls `bridge.browser.execute`, materializes screenshots and routes vision. | Extend the real tool schema/result/materializer path, not only the service test API. |
| Task admission and retained tab | `BrowserAutomationService.ts:204` derives owner from durable invocation/task, filters `listTabs` by task, rejects foreign `tabId`, tracks last-operated tab independently of UI selection. | Every new action, event, cursor and handoff must inherit this authority. |
| Navigation/action outcome | `BrowserAutomationService.ts:140`, `:312`, `:368`; `AutomationScope.ts` | Preserve absolute deadlines, checks after awaits, input accepted versus observation failure, and no mutation replay after uncertain dispatch. Split business confirmation from input receipt. |
| Native presentation | `BrowserHost.ts:411`, `:591`, `:709` | `withAutomationSurface` serializes view presentation and restores user visibility/capture state. Automation must not call UI `selectTab` incidentally. |
| Browser input | `BrowserAutomationService.ts:436`, `BrowserNativeInput.ts` | Browser obtains the `browser-host` inspection session, suspends overlay and sends CDP Input through it. Retain this trusted path. |
| Inspection session | `PageInspectionService.ts:132`, `:163`, `:412` | One debugger session per WebContents; active different owners are rejected. Attach rejects an already attached debugger. Current event handler discards `sessionId`, and `DebuggerLike.sendCommand` lacks its third argument. |
| Current locators/read | `UiAutomationService.ts:103`, `:192`, `BrowserPageRead.ts:26` | Main document `querySelectorAll`, approximated role/name, document-only MutationObserver, selector attributes and main-frame coordinates. Read explicitly excludes iframe/shadow. No claim of full coverage is currently valid. |
| Popups/session | `BrowserHost.ts:95`, `:654` | Persistent shared browser login partition; native popup adoption retains opener and task identity. Do not create a second browser/context or change shared authentication. |
| User-input status | `DurableBotRuntime.ts:1300` | Pending native/nested tool details with `waitingForInput: true` already contribute to `waiting_input`. Handoff must connect to the actual request/continue lifecycle, not return an inert instruction string. |
| Existing real tests | `scripts/browser-task-execution-electron-test.ts:1` and `:229` | Isolated HOME/userData, real BrowserHost, controlled React form, trusted CDP input, background/minimized state and no-replay checks provide the fixture pattern. |

Installed `node_modules/electron/package.json` reports **44.5.1**. Local `electron.d.ts:19228` declares `WebFrameMain.executeJavaScript`, `framesInSubtree`, `detached`, `frameTreeNodeId`, `frameToken`, `processId`, and `routingId`. `electron.d.ts:7711` declares debugger `sendCommand(method, params, sessionId)`; message events also include `sessionId`. `electron.d.ts:13110` gives download events both originating WebContents and optional WebFrameMain. These are current local declarations, not assumed browser-library capabilities.

The parent-produced real probe `out/diagnostics/browser-p0p1/engine-probe.json` confirms native evaluation in a nested `127.0.0.1 -> 127.0.0.2 -> 127.0.0.1` tree, with a separate renderer process for the middle frame. It also demonstrates that Electron `frameToken` differs from CDP `frameId`, and the root `Page.getFrameTree` omits the OOPIF. Root auto-attach emits an iframe target plus child `sessionId`. This establishes frame execution and disproves token/tree shortcuts. It does **not** establish nested input geometry, recursive target attachment, file transfer or final browser acceptance.

## Shape

### Public and private types

The following sketch shows domain types. The actual implementation derives transport types from TypeBox and parses external/CDP payloads at the boundary. Opaque handles serialize as strings and are looked up in a task-owned registry. Callers never receive debugger sessions, runtime object IDs or Electron objects.

```ts
type Id<K extends string> = string & { readonly __brand: K };
type TabId = Id<'Tab'>;
type ScopeRef = Id<'Scope'>;
type NodeRef = Id<'Node'>;
type ScreenshotRef = Id<'Screenshot'>;
type ActionId = Id<'Action'>;
type HandoffId = Id<'Handoff'>;

type TextMatch = { exact: string } | { contains: string };
type Locator =
  | { kind: 'role'; role: string; name?: TextMatch }
  | { kind: 'label'; text: TextMatch }
  | { kind: 'text'; text: TextMatch }
  | { kind: 'placeholder'; text: TextMatch }
  | { kind: 'testId'; value: string }
  | { kind: 'css'; selector: string };
type Target =
  | { kind: 'node'; ref: NodeRef }
  | { kind: 'point'; screenshot: ScreenshotRef; x: number; y: number };
type Predicate =
  | { kind: 'visible' | 'attached' | 'enabled'; scope?: ScopeRef; locator: Locator; value?: boolean }
  | { kind: 'text'; scope?: ScopeRef; locator: Locator; contains: string }
  | { kind: 'value'; scope?: ScopeRef; locator: Locator; equals: string }
  | { kind: 'count'; scope?: ScopeRef; locator: Locator; equals: number }
  | { kind: 'url'; matches: TextMatch }
  | { kind: 'response'; url: TextMatch; method: string; status: number }
  | { kind: 'all' | 'any'; predicates: Predicate[] };
type BusinessResult =
  | { kind: 'not_requested' }
  | { kind: 'passed'; evidence: PredicateEvidence[] }
  | { kind: 'failed'; evidence: PredicateEvidence[]; reason: string };
type CollectionCompletion =
  | { kind: 'complete'; terminalEvidence: PredicateEvidence; uniqueRows: number; expectedRows?: number }
  | { kind: 'partial'; reason: 'budget' | 'stalled' | 'cancelled' | 'changed' | 'unknown_end'; uniqueRows: number; cursor?: string };

// Internal identities: these never appear in tool calls.
interface DocumentIdentity {
  tabId: TabId;
  webContentsId: number;
  frameTreeNodeId: number;
  documentEpoch: number;
  sessionGeneration: number;
}
interface NodeIdentity {
  document: DocumentIdentity;
  nodeRef: NodeRef;
  backendNodeId: number;
  runtimeContextId: number;
  semanticFingerprint: string;
}
type HandoffState =
  | { kind: 'waiting'; id: HandoffId; tabId: TabId; webContentsId: number; resumeWhen: Predicate }
  | { kind: 'resumed'; id: HandoffId; observationId: string }
  | { kind: 'invalidated'; id: HandoffId; reason: 'tab_closed' | 'runtime_restarted' | 'cancelled' };

class BrowserAutomationService {
  async execute(input: BrowserRequest, signal: AbortSignal | undefined, context: TaskContext): Promise<BrowserResult> {
    throw new Error('not implemented');
  }
}
class BrowserPageSession {
  async observe(request: ObservationRequest, scope: AutomationScope): Promise<Observation> { throw new Error('not implemented'); }
  async execute(request: PageAction, scope: AutomationScope): Promise<ActionResult> { throw new Error('not implemented'); }
  async readCollection(request: CollectionRequest, scope: AutomationScope): Promise<CollectionResult> { throw new Error('not implemented'); }
  dispose(reason: string): void { throw new Error('not implemented'); }
}
```

`BrowserRequest` is the union of `status`, `open`, `select_tab`, `close_tab`, `back`, `forward`, `reload`, `navigate`, `read`, `find`, `inspect`, `screenshot`, `wait_for`, `click`, `double_click`, `right_click`, `hover`, `drag`, `fill`, `press`, `scroll`, `select`, `check`, `upload`, `dialog`, `downloads`, `diagnostics`, `read_collection`, `handoff`, and `resume`. Each branch has its required fields, rather than a bag of optional values. Input branches share optional `expect`, `dialogs`, and `captureDownload`. `drag` has two observed targets and an explicit pointer or HTML drag-data mode; `press` carries an exact key chord; `fill` supports text or a validated native date/time value. Generic executable JavaScript is absent.

`BrowserResult` contains identity, bounded observation/evidence and a separate `dispatch`/input acceptance outcome, `businessResult`, optional download state and trace ID. Existing `effect: confirmed` keeps its current input-level meaning during caller migration. It must not silently change to business success. A failing business assertion leaves dispatch marked dispatched and never schedules the input again. Pending browser dialog/download results are explicit variants.

### Module ownership and call depth

| Module | Owned knowledge and changes |
| --- | --- |
| `BrowserToolContract.ts` | Request schemas, result variants, schema-derived TS types, action metadata used by docs/adapters. No duplicated action allowlists. |
| `BrowserAutomationService.ts` | Task authority, tab dispatch, current automation tab, durable outcome integration, host lifecycle. It stops routing browser operations through main-document `UiAutomationService`. App/artifact UI callers keep that service. |
| `browser/BrowserPageSession.ts` | One per retained tab. Frame/document registry, observed node references, pending action identity, event subscriptions, screenshot and cursor identities. Browser operations call this owner directly. |
| `browser/BrowserDom.ts` | Bounded bundled DOM functions for open-shadow traversal, text/label relations, native input/date setters, editor readback, renderer mutation and geometry stamps. No arbitrary user program evaluation. |
| `browser/BrowserCollection.ts` | Pure accumulation, stable-key deduplication, completeness and progress state. Its driver receives the page session's observe/action operations. It owns no second tab or debugger registry. |
| `artifact/PageInspectionService.ts` | Extend the existing debugger owner with multiplexed typed command/event access, child session IDs, detach generation and per-consumer domain leases. Inspection overlay, input, AX and diagnostics share this connection. |
| `BrowserHost.ts` | Sole tab registry and UI presentation. Add task-addressed history actions and a handoff presentation entry point; preserve native popup adoption and visibility restoration. |
| Existing tool materializer/user-input integration | Publish verified downloads/screenshots as task artifacts; expose handoff and Continue through existing task event/request facilities. Do not invent a parallel task waiting-state store. |

The dominant action chain is tool registration -> BrowserAutomationService -> BrowserPageSession, with the page session using the existing host presentation and debugger owner. Helpers contain bounded algorithms, not pass-through service layers. PageInspectionService owns transport and BrowserHost owns tabs; the page session owns only automation state. This follows boundary-discipline, model-the-domain and minimize-reader-load.

### Frame, DOM and accessibility resolution

Enumerate actual `wc.mainFrame.framesInSubtree`, including cross-origin descendants, and create a per-document nonce by executing the bundled observation bootstrap in each WebFrameMain. Electron frame-tree-node identity persists across navigation, so it is not a document identity by itself. Recheck `detached`, `isDestroyed`, retained WebContents and native frame identity before and after every await. Increment each frame's document epoch on navigation/context destruction; same-document navigation updates URL/geometry evidence without pretending the document was replaced.

Extend the existing debugger connection to use `Target.setAutoAttach` with flattened sessions and recursively configure child targets, with no global browser target enumeration. Enable Runtime/Page/DOM/Accessibility in each applicable session. Correlate native-frame nonces against default execution contexts enumerated from `Runtime.executionContextCreated`; a context probe reads the exact document token. Require a unique match and verify the native document token again after mapping. Never match by URL, frame name, sibling index, routingId or Electron frameToken. Root-only Page.getFrameTree is insufficient. Once correlated, CDP context `auxData.frameId` and parent-session `DOM.getFrameOwner` provide exact owner elements. A race yields stale/unavailable, never an approximate match.

AX observations use Chromium-computed names, roles and states, backed by DOM backend-node identity. DOM traversal supplies text, test IDs and explicit label/placeholder queries, scope ancestry and open-shadow boundaries. CSS evaluates independently within each declared document/shadow root; a composed traversal explicitly visits assigned slots/open roots and deduplicates nodes. Closed roots return excluded coverage. A scope can represent document, frame, open shadow root or element subtree. `find` returns bounded matches and exact refs; mutation requires one observed node. Locators are strict by default, with explicit exact/contains matching. A repeated role/name in another frame cannot resolve accidentally outside the scope.

Use the current body-text pagination behavior for ordinary text with a per-scope snapshot and revision. Every discovered open shadow root gets an observer, including roots discovered later. Observation reports included frames, inaccessible/destroyed frames, shadow coverage and truncation separately. Read tokens never imply all data in a virtualized collection was present.

The protocol names `Target.setAutoAttach`, `DOM.getFrameOwner`, `DOM.setFileInputFiles`, and `Accessibility.queryAXTree` are listed in the official [Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/), [DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/) and [Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/) references. Their Electron44 behavior must be proven by the real fixture; website tip-of-tree descriptions do not override the installed engine.

### Geometry, advanced input and visual actions

Compute input coordinates in top-level CSS viewport units. For nested frames, resolve each real iframe owner and transform the child's viewport point through its content quad, including border, scale and parent scroll; compose the chain. Validate clipping and hit-testing at every frame/shadow boundary. A plain bounding-box offset is inadequate for transformed frames. Calibrate CDP quad coordinate conventions against the installed engine fixture before selecting the transform implementation. Reject singular/unsupported transforms with explicit geometry evidence. Support normal nested scrolling and CSS transformed/scaled frames in the acceptance suite; do not silently narrow all frames to zero-border untransformed cases.

Use trusted CDP pointer/key input and explicit finally cleanup of only the operation's owned buttons/modifiers. Double-click sends the required counts/sequence and right-click generates contextmenu. Pointer drag moves through bounded waypoints; HTML drag-and-drop uses the same session's drag events/data path and tests actual drop payload. Native date/time uses the native setter plus input/change and value readback where Chromium keyboard entry cannot express the required format; report that strategy. Text/contenteditable/controlled editors use trusted editing and readback; Monaco/CodeMirror fixtures verify the application's saved value, not merely innerText. Existing hover paths, summary disclosure, select/check semantics remain supported through the same resolver.

A screenshot record stores tab, document tree generations, pixel dimensions, viewport CSS size, device scale/zoom, scroll/layout/visual revision and capture timestamp. Vision output carries screenshotRef and image-space coordinates. The session converts to CSS viewport coordinates and revalidates all provenance before dispatch. Scroll, resize, zoom, navigation, frame replacement or relevant layout/visual changes invalidate it. DOM mutation alone does not detect canvas/video animation: recapture the image region/full frame and compare before a coordinate action, returning `SCREENSHOT_STALE` on mismatch. For continuously changing pixels callers must capture again. A DOM-backed point uses a final hit-test; canvas actions retain screenshot evidence. Arbitrary coordinates without screenshot identity are invalid.

### Waits, business assertions and asynchronous events

Arm response/download/dialog watchers before input, assign an action ID and start sequence, and bound them by the same absolute action deadline. Wait predicates are a validated DSL with observed evidence, not `sleep`, network-idle assumptions or arbitrary JS. Read-only predicates may re-observe after legitimate navigation on the exact tab. Mutations are never retried as part of assertion waits. A server-response status can participate in a business assertion but does not independently prove displayed application state; support compound predicates and report each evidence item.

Track dialogs from Page events before dispatch, including alert/confirm/prompt and beforeunload. Predeclared response rules match kind and exact/contains message. Unmatched dialogs create a typed pending-dialog result with immutable dialog ID; no unconditional auto-accept. A later `dialog` operation answers only that ID in that session/generation. The event listener remains operable while a renderer execute promise is blocked by the dialog; it must not queue behind the action's presentation lock. Close/navigation honors the same beforeunload decision, and must coordinate with BrowserHost's existing `will-prevent-unload` handler so two policies never race. Test whether Electron's callback or CDP owns each dialog kind and select one owner for each.

Network/console tracing is per tab/session with a bounded sequence-indexed ring buffer and explicit gap/truncation markers. Record request identity, method, sanitized URL, status, failure, timing, frame and action interval. Console/errors include frame and level with bounded text. Attribute correlation as an interval unless an actual request initiator/identity proves more; do not call every concurrent request caused by the click. No cookies, Authorization, passwords or bodies are persisted by default. A diagnostics cursor returns events since a sequence, and action results reference the trace. Enabling a domain is reference counted so inspection cleanup cannot disable an active action watcher; detach fails watchers and invalidates old refs.

### File transfer and collection completeness

Upload resolves existing regular files through task file authority, verifies bytes/size and the exact input node, then uses `DOM.setFileInputFiles` in its frame session. Reject a non-file input, unexpected multiple selection and nonexistent file before dispatch. Filechooser events from custom controls use the same task/document identity and can become explicit pending chooser operations. Verify selected files in-page and, in the integration fixture, verify server-received bytes/hash. A set-files response alone is not successful import.

Download uses a single session-level `will-download` router keyed by the event's WebContents and frame. It registers action intent before input, assigns a collision-safe task output path synchronously using `setSavePath`, tracks done/interrupted/cancelled and verifies the finished local file before materializing the task artifact. Shared authentication must not turn into shared task download routing. An ambiguous concurrent download is reported, not attached to the latest action. Use one in-flight download intention per originating page/frame, exact URL/name filters when available and IDs for subsequent polling. Cancelled actions do not leave pending router ownership; partial files remain clearly incomplete or are cleaned by their own registry.

Collection reading requires an explicit grid/row scope, stable key strategy, advancement strategy and terminal evidence. Support pagination by observed next control, virtualized scrolling by observed container, and infinite scrolling/load-more with monotonic key accumulation. Preserve order/source page metadata and conflicting duplicate-row versions. Completion requires terminal evidence, no missing advertised row indices/count, and consistency of any query/sort/filter identity across steps. Reaching maxSteps, timeout or repeated viewport does not prove completion. Return partial with reason and a task/tab/document/query-bound cursor. Cursor expiry or changed filters invalidate continuation. A generic infinite feed with no provable end remains partial even when no new rows appear for several polls. Long runs checkpoint between bounded calls and release the presentation lease so another tab/task can advance.

### Tabs and human handoff

`open` always creates a new task tab; `navigate` retains the existing documented reuse semantics. `select_tab` selects the task's automation target, with explicit presentation only when requested. `close_tab` waits for actual destruction or reports beforeunload refusal/pending dialog. Back/forward/reload address that tab's navigationHistory and observe completion/failure; they do not invoke BrowserTabSurface's current visibility-gated UI back/forward helpers. Any closed tab invalidates handles; it never falls through to the UI-selected tab.

Handoff is a durable task-owned request with exact tab/WebContents identity, reason, expected resume predicate and one-shot request ID. It releases automation input/presentation leases and pauses mutations for that tab. The user explicitly chooses to show/focus it and completes login/2FA in the page. Continue returns to the pending native request, verifies that the retained tab exists and is still owned, evaluates the resume predicate and makes a fresh observation. Authentication navigation may replace documents, so retain tab identity and discard prior node refs. Shared auth changes in another tab do not transfer the pending request. Cancellation closes only the request; it does not close the user's authenticated tab. After application restart the old WebContents is gone: mark handoff invalidated and require a new observed tab/request, never silently bind to a matching URL. No credential/OTP extraction is added.

## Tradeoffs accepted

- We accept native frame/CDP routing and geometry work in exchange for retaining the exact Electron tabs, session, task ownership and trusted input without another browser process or debugging endpoint.
- We accept a page session that contains substantial state in exchange for one authority for frame references, event races and action outcomes. Helpers split algorithms, not ownership.
- We accept strict stale/ambiguous errors in exchange for avoiding actions against guessed frame/node identities. Dynamic visual targets may require another capture.
- We accept explicit partial collection results in exchange for truthful completeness. No generic adapter can infer an absent server-side dataset end.
- We accept native setter handling for date/select/file semantics in exchange for reliable application values, with action strategy and verified business effects visible in evidence.

## Alternatives considered

1. Keep adding fields to `UiAutomationService` and execute every operation against `wc.executeJavaScript`. This exposes frame conversion, node lifetime and event ordering to every caller and preserves duplicated semantic logic. It cannot observe cross-origin descendants through the top page DOM. Native per-frame execution plus a tab session has greater interface depth.
2. Attach a second debugger or expose a remote-debugging port to a framework. A framework can hide locator/actionability complexity, but a second connection conflicts with the existing inspection owner and changes tab/session ownership. A framework transported through the existing session is a real competing candidate; it should win only if its OOPIF, popup and lifecycle assumptions are demonstrably compatible and it removes more code than it adds.
3. Use native desktop coordinates and an external browser for unsupported web operations. This loses tab isolation and background/minimized behavior and violates the current browser policy. Rejected.
4. Match frames by URL/name/index or use Electron frameToken as CDP frameId. The live probe disproves the identity assumption; duplicate URLs and navigation races also make the fallback ambiguous. Rejected.

## Acceptance evidence required

All rows must run through the public browser tool adapter/schema and real BrowserAutomationService -> BrowserHost -> Electron execution path in an isolated HOME/userData. Node unit tests may validate parsers/accumulators but cannot satisfy these rows. Never use the real profile or credentials.

| Scenario | Required real evidence |
| --- | --- |
| Frame and shadow identity | Two origins, nested OOPIF including return to first origin, same-URL sibling frames, navigation during resolution, open shadow inside frame and frame inside open shadow. Save using the exact scoped button and assert server mutation once. Old refs must fail before dispatch after frame replacement. |
| Geometry/actionability | Nested scrollers, borders, non-unit device scale/zoom, CSS scaled/rotated iframe, occluded target and moved target. Trusted event arrives at intended element; clipping/unsupported transform fails explicitly. |
| Semantics | Chromium AX name from labels/aria-labelledby, hidden/disabled states, repeated names in two forms/scopes, shadow slots and a summary disclosure. No cross-scope accidental action. |
| Business result | Click accepted but server rejects; click times out after server commit; route redirects while asserting; repeated text before action. Report separate acceptance/assertion result and exactly one server write. |
| Dialogs | Alert, accept/dismiss confirm, prompt text, unmatched dialog and beforeunload cancel/accept; dialog during blocked renderer promise. No deadlock, wrong default acceptance or dismissal of another tab's dialog. |
| Transfers | Multipart server receives exact bytes/hash from nested-frame file input; real attachment download completes and artifact bytes/hash match. Interrupted download, duplicate names, concurrent other-task download and cancelled chooser cannot leak ownership. |
| Collections | Virtual grid recycles DOM nodes, duplicate rows across pages, delayed infinite append, advertised count mismatch, page loop, filter change and explicit end marker. Exact expected set only reports complete; all incomplete cases report partial with reason. |
| Advanced input | Contextmenu, dblclick, modifier chord cleanup after cancellation, pointer and HTML data drag/drop, native date/time, React controlled input, contenteditable and a complex editor saved by its own app. |
| Tabs/handoff | Open distinct same-URL tabs, popup ownership, back/forward/reload, close refused then accepted, another task selected. User completes a deterministic login/OTP fixture; Continue resumes the exact tab with fresh refs; close/restart/wrong-task resume fails safely. |
| Diagnostics/vision | Failed request and console error in nested frame correlate to tab/frame with explicit event gaps. Capture-click succeeds unchanged; scroll/zoom/resize/frame replacement and canvas redraw each reject prior screenshot points before dispatch. |
| Isolation and cancellation | A stalled page action cannot block B on a different tab. Cancelled operation cannot send later input, release another operation's input, consume another download/dialog, or steal foreground. Run foreground, background and minimized variants. |
| Existing behavior | Existing hover path, checked/select, disclosure, controlled Chinese input, long text/cursor, popup and durable no-replay tests continue to pass. |

Run `pnpm -s typecheck` and the relevant existing `test:browser-*`, `test:ui-automation-cancellation`, durable composition/interruption, inspection/capture tests and new real Electron P0/P1 fixture via package scripts. Query package.json/test-all classification for exact script names rather than inventing commands. Test scripts may bundle their own isolated fixtures through pnpm, as existing tests do; no product `build`, packaging or install is authorized. Full default, GUI and artifact gates must be reported separately when actually run. This design document and the frame execution probe are not acceptance of the P0/P1 behavior.

## Synthesis decision

Pending the parent's cross-candidate comparison. This candidate recommends the native session design as the base because it centralizes identity and events under the existing Electron ownership model. The strongest possible graft from a framework candidate is a proven locator/AX/name or actionability implementation behind the same opaque node API, if its licence/runtime/dependencies and exact browser integration pass real fixtures. Do not retain two browser executors after synthesis.

## Open questions and risks

- Can the Electron44 probe establish recursive auto-attach and reliable nonce/context correlation for nested return-to-origin frames before implementing actions? This is the first executable spike, not a reason to stop for user approval.
- Which installed-engine quad coordinate convention and transform chain passes nested-frame hit-testing at fractional scale? Require the fixture before declaring the geometry contract complete.
- Does Electron's beforeunload interception supersede CDP in any lifecycle path? Resolve with real tests and keep one response owner per kind.
- Which current user-input request component owns Continue and cancellation after the concurrent Bot-removal changes? Re-read that live chain at implementation time; the native pending request, UI and durable status must agree.
- Can an existing task artifact authority safely expose approved upload paths and materialize download files without copying a second policy into the browser? Reuse it when identified; fail before dispatch if authority cannot be established.

## Next implementation step

Extend the rerunnable real Electron probe to prove recursive child-session mapping, nonce identity and nested-frame geometry, then implement the single shared debugger/session owner and migrate all browser actions to its exact node resolver before adding P0/P1 operations.
