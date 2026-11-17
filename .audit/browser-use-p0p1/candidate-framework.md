# Candidate: reusable browser engine behind the existing host

## Problem and ground truth

`browser_exec` is registered in `src/main/capabilities/builtin-capability-extension.ts` and forwarded through the durable tool bridge, including structured output. `BrowserAutomationService.executeManaged` resolves task-owned `BrowserHost` tabs and pins a `BrowserPageHost`; actions run on that fixed page with cancellation/retention guards. `BrowserHost` owns WebContentsView, popup ownership and presentation/capture leases. Its `PageInspectionSession` is the one debugger owner; `BrowserNativeInput` uses that session for trusted CDP input. `UiAutomationService` currently supplies browser action logic as well as application UI automation. `BrowserToolContract.ts` currently has a flat TypeBox schema and 14 actions. This candidate retains this browser, session, ownership, and UI; it is not an external Chrome launch.

## Caller usage

```ts
const result = await engine.perform({ task, tab, signal, command: {
  kind: 'click', target: { frame: [{ role: 'iframe', name: 'Payment' }],
    within: [{ role: 'dialog', name: 'Confirm' }], query: { role: 'button', name: 'Pay' } },
  expect: { kind: 'text', target: { query: { role: 'status' } }, contains: 'Paid' }
}});
// result distinguishes not-dispatched, dispatched/unknown and confirmed.
const capture = await engine.perform({ task, tab, signal, command: { kind: 'capture' } });
await engine.perform({ task, tab, signal, command: { kind: 'visual-click',
  capture: capture.value.identity, point: { x: 20, y: 40 } } });
```

The agent never receives a raw framework object, transport, or JavaScript evaluator. The actual `browser_exec` contract is a schema-derived discriminated union matching these operations. `task` is supplied by the bridge, not chosen by page content or by the model.

## Shape

A reusable **BrowserEngine** owns locator evaluation, actionability, waits/assertions, events and trace, backed by a narrow **PageDriver** interface. The candidate implementation is a maintained, version-pinned automation engine capable of accepting an injected transport to an existing target. Research feasibility before naming a package: Playwright's documented `connectOverCDP` attaches to a browser endpoint with lower fidelity and warns that unsupported launch arguments may break features; its Electron API documents launching the app, not injecting an existing Electron `Debugger` as transport. Electron provides child-target `sessionId` in `sendCommand` and debugger message events. Current `PageInspectionSession` drops that event session ID and `send` does not accept it. Thus Playwright stock is **not** a demonstrated drop-in. Do not add it or expose a remote-debugging endpoint as if compatible. If a framework requires internal monkey-patches, unconstrained browser-wide CDP, a second debugger owner, or a separate browser, reject it and implement the same domain interface with the native driver. A proof of concept must demonstrate compatibility before selecting it.

```ts
type TaskId = string & { readonly taskId: unique symbol };
type TabId = string & { readonly tabId: unique symbol };
type Generation = string & { readonly generation: unique symbol };
type Target = { frame?: readonly SemanticQuery[]; within?: readonly SemanticQuery[]; query: SemanticQuery };
type SemanticQuery = { role: string; name?: string } | { text: string; exact?: boolean } | { selector: string };
type Predicate = { kind: 'state'; target: Target; state: 'visible'|'hidden'|'enabled'|'checked' }
  | { kind: 'text'; target: Target; contains: string } | { kind: 'url'; matches: string }
  | { kind: 'count'; target: Target; equals: number };
type CaptureIdentity = { tab: TabId; document: Generation; viewport: Generation; image: Generation;
  width: number; height: number; scale: number };
type Command =
  | { kind: 'observe'; target?: Target } | { kind: 'wait'|'assert'; predicate: Predicate; timeoutMs: number }
  | { kind: 'click'; target: Target; button?: 'left'|'right'; count?: 1|2; modifiers?: readonly string[]; expect?: Predicate }
  | { kind: 'fill'; target: Target; text: string; expect?: Predicate }
  | { kind: 'drag'; from: Target; to: Target; modifiers?: readonly string[] }
  | { kind: 'upload'; target: Target; files: readonly TaskFileRef[] }
  | { kind: 'download'; trigger: Target; destination: TaskFileDestination }
  | { kind: 'dialog'; dialog: DialogId; response: 'accept'|'dismiss'; promptText?: string }
  | { kind: 'collect'; grid: Target; strategy: CollectionStrategy; identity: RowKeySpec; budget: CollectionBudget }
  | { kind: 'capture' } | { kind: 'visual-click'; capture: CaptureIdentity; point: { x: number; y: number } }
  | { kind: 'history'; direction: 'back'|'forward'|'reload' }
  | { kind: 'handoff'; reason: 'login'|'2fa' } | { kind: 'resume'; handoff: HandoffId }
  | { kind: 'diagnostics'; since: TraceCursor };
type Outcome<T> = { dispatch: 'not_started'; error: EngineError }
  | { dispatch: 'dispatched'; effect: 'unknown'; error: EngineError }
  | { dispatch: 'dispatched'; effect: 'confirmed'; value: T };
interface BrowserEngine { perform(request: { task: TaskId; tab: TabId; command: Command; signal: AbortSignal }): Promise<Outcome<unknown>>; }
```

`TaskFileRef`, destinations, row-key specs, budgets, dialog IDs and handoff IDs are validated opaque capabilities, not arbitrary paths or scripts. The code sketch is illustrative: implement explicit variants for keyboard/modifier, date, contenteditable/editor and scroll; derive tool schema and types from one authoritative contract. Frame path uniquely resolves each nested frame; scoped locators resolve within the selected document and open shadow roots, and ambiguity fails. Cross-origin OOPIFs require target discovery and per-session event routing. Closed shadow roots and inaccessible browser/OS chrome report unsupported, not complete. Waits re-evaluate named predicates until deadline with cancellation; `assert` returns actual evidence on failure. Capturing a coordinate binds document/navigation, native surface dimensions, viewport, scroll, device scale and screenshot identity; check all immediately before input, fail stale on mismatch. Frame/DOM identities are revalidated after every await.

Collection has explicit strategies (next-page, scroll container, load-more), a stable row key, bounded pages/items/time and no-progress detection. Result includes unique rows, coverage evidence and `complete | partial(reason)`; only an observed terminal condition makes it complete. Mutable/unstable or keyless datasets cannot claim completeness. Upload resolves authorized task files, verifies existence and applies to the pinned input; downloads associate an initiated download with the task/tab and return actual written artifact after completion, failure/cancel distinctly. JS dialogs need event registration before trigger; native OS dialogs remain a separate class. Handoff pins the exact task-owned tab/session, releases input, presents it for the human and resumes only after explicit user continuation with identity checks; it must never read or capture 2FA secrets.

Modules: `browser/BrowserHost` remains lifecycle and surface authority; `artifact/PageInspectionService` remains sole debugger owner, gains typed multiplexed child-session routing, subscriptions and ownership-safe disposal; `browser/engine` owns driver, selectors, waits, completeness and trace; `capabilities/BrowserAutomationService` is the policy/tool boundary and delegates; file and handoff services retain their existing domain ownership. Network/console events are bounded, redacted by default (no secrets, cookie/authorization headers, or bodies), scoped to task/tab and explicit collection; action traces include timing, target, dispatch/effect and failure, not arbitrary page data. Target auto-attachment and domains must coexist with overlay inspection and avoid mutating other tabs.

## Synthesis decision

Framework candidate only; parent arena will compare independent candidates. Deep interface hides event routing, retries, target mapping and session lifetimes while exposing semantic commands and evidence. Do not claim framework adoption until its transport and operations are proven on Electron 44 and the shipped app. Retain native engine as the likely pragmatic base if the research spike fails.

## Tradeoffs accepted

- Accept a compatibility spike and potentially native implementation in exchange for retaining one debugger and the actual task-owned browser.
- Accept explicit partial collection and bounded diagnostics in exchange for honest completeness and controlled data exposure.
- Accept strict stale/ambiguous rejection in exchange for avoiding wrong-page or replayed side effects.

## Alternatives considered

1. Direct stock Playwright connection over browser CDP: attractive locators and waits, but browser-wide endpoint and debugger interaction, WebContentsView mapping, surface leases and framework fidelity are unproven; not acceptable without a scoped broker and real integration proof. Electron launch replaces lifecycle and is incompatible with the goal.
2. Extend only `UiAutomationService`: smaller initial diff but exposes browser frame/session, transfer and handoff invariants to an unrelated application UI abstraction and risks duplicate owners.
3. Native driver behind the same domain engine: no external framework coverage guarantee, but fits current debugger and presentation ownership; use if injected framework transport is not supported and validated.

## Open questions and risks

- Can a pinned maintained engine use a supported injected transport, target-specific child sessions and Electron 44 without owning debugger attachment, browser-wide discovery, process lifetime or arbitrary JS? If not, reject the dependency.
- Can real OOPIF actionability, shared inspector, downloads and dialogs coexist with the framework's session setup and teardown? Are target identities stable through navigation, popup and DevTools detach?
- What exact user-visible action signals human completion, and how are tab closure and cancellation shown while preserving the same session?

## Verification and next step

First run a disposable research spike against the existing `BrowserHost` and one shared `PageInspectionSession`: nested two-origin OOPIF + open shadow locator, trusted click, competing inspector, detach and cancel, while another task owns a separate tab. No broad remote-debugging socket. Reject framework if the route relies on private APIs or violates ownership. Then run end-to-end fixtures **through the real registered `browser_exec` tool bridge**, not merely `BrowserAutomationService`: task isolation/popup/history; duplicate names and stale nodes; nested cross-origin frames/shadows; waits and explicit assertion failures; real file byte verification; JS dialogs; virtualized, paginated and infinite lists with terminal and partial cases; drag/right/double/modifiers/date/editor; event redaction and trace ordering; background/minimized screenshot and scale/scroll/navigation stale rejection; pinned login/2FA human handoff and resume; cancel/close/detach at every async boundary and dispatched-unknown no-replay. Use isolated profiles and real native input, and separately report GUI/session and packaging gates when actually run. Existing `scripts/browser-task-execution-electron-test.ts` exercises real Electron host/service and is useful fixture grounding but does not alone prove the registered tool bridge or all new capabilities. No tests or package installs were run for this design.

Primary references: [Electron debugger](https://www.electronjs.org/docs/latest/api/debugger), [Playwright Electron API](https://playwright.dev/docs/api/class-electron), [Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp).
