# Native source HTML drag

`BrowserHtmlDrag.ts` exports:

```ts
htmlDragFromSource({
  protocol, // existing PageInspectionSession, no additional debugger
  input,    // UiNativeInput sending root-viewport coordinates
  scope,    // AutomationScope with pinned-document guards
  points,   // validated source/destination path in root viewport CSS pixels
}): Promise<void>
```

The caller owns the surface lease and root coordinate mapping. Source and destination must already be resolved from valid observations. This API does not accept caller-provided drag data or files, and does not mark a business assertion confirmed.

The operation subscribes to Chromium's `Input.dragIntercepted`, enables drag interception, and sends trusted mouse down/moves from the source. Moves carry both `button: 'left'` and the held-button modifier; the held-button modifier alone did not start a native drag in Electron 44.5.1. Eight interpolated moves per supplied segment cross Chromium's threshold. After the actual source `dragstart`, it forwards the original bounded native data to `dragEnter`, `dragOver`, and `drop`. MIME items, titles, base URLs, and any native source file list are preserved; no external payload is invented. The protocol behavior is documented by the [Chrome DevTools Protocol Input definition](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json).

If the source emits no native drag after the movement and a bounded 500 ms interception wait, the operation fails `UNSUPPORTED_SCOPE`. It does not synthesize dragstart, switch to another gesture, or replay the drag. The caller's scope still bounds the entire operation. A WeakSet prevents overlapping operations on the same protocol owner.

Cleanup waits for the last native command to settle. On cancellation before drop, an intercepted drag needs both `dispatchDragEvent: dragCancel` and `Input.cancelDragging`; the latter alone left an intercepted drag active in the actual test. The operation then releases only its held mouse button and disables its owned interception, even after cancellation. Its subscription and owner marker are removed. No shared debugger domain is disabled and no debugger is detached. A successful drop that completes after caller cancellation is still recognized as dispatched; cancellation does not undo already delivered input.

## Real evidence

`scripts/browser-html-drag-electron-test.cjs` uses Electron 44.5.1, an isolated temporary profile, the real PageInspectionSession, and the production browserNativeInput transport. `out/diagnostics/browser-p0p1/html-drag.json` records five passing checks:

1. Actual source dragstart and target drop are trusted. The target receives the source's runtime-generated plain-text and HTML data exactly.
2. Cancellation after native dragover sends no drop, cancels the native drag, disables interception, and leaves mouse movement with zero held buttons.
3. Cancellation after mouseDown releases that operation's button before a source drag occurs.
4. A nondraggable source fails without a fabricated payload or replay.
5. A subsequent explicit drag succeeds after both cancellation and rejection; the shared inspector stays attached.

Passed commands:

```powershell
pnpm exec electron scripts/browser-html-drag-electron-test.cjs
pnpm exec tsc --noEmit -p tsconfig.node.json
```

Unset inherited `ELECTRON_RUN_AS_NODE` before the Electron command. These are focused native module checks in one document. Public semantic drag integration and cross-document source/target drag acceptance belong to the caller's tests; this evidence does not claim them or full product acceptance. No product build, package, or live user profile was used.
