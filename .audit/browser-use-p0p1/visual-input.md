# Screenshot-bound browser input

This subtask adds only `src/main/capabilities/browser/BrowserVisualInput.ts`, `scripts/browser-visual-input-electron-test.cjs` and this document. Public tool actions/schema and screenshot materialization remain with the parent.

## API and integration

```ts
const visual = new BrowserVisualInput();
const target = { owner: taskOwner, tabId, host: retainedBrowserPageHost };
const capture = await visual.capture(target, captureScope);
// Deliver capture.screenshot and preserve capture.captureId and viewport metadata.
await visual.click(target, { captureId: capture.captureId, x: imageX, y: imageY }, actionScope);
// Or visual.scroll(target, { captureId, x, y, deltaX, deltaY }, actionScope).
```

Coordinates are image pixels within the referenced screenshot. Capture results include PNG bytes, capture ID, top document ID/URL, screenshot pixel dimensions, CSS viewport dimensions, scroll position, device scale and browser zoom. The input methods return the mapped top-level CSS point and `dispatched: true`. They set `AutomationScope.dispatched`, but leave `confirmed` false: sending trusted input does not prove an application/business result.

Both capture and action methods must run **outside** another `BrowserPageHost.withAutomationSurface` callback. They obtain that existing native presentation lease themselves. Under the lease they use the same `browser-host` PageInspectionSession and its `captureScreenshot`, then its trusted input adapter. Calling `host.captureScreenshot` from inside the lease would queue behind itself. Reading initial viewport provenance outside the lease also failed on a hidden native view with a zero viewport, so the implementation collects both pre/post state and pixels within one lease.

The module attaches no additional debugger. It reuses an existing inspection session, and releases a newly acquired session only when it has no protocol subscribers. Existing capture-mode restoration and hidden/minimized presentation remain BrowserHost responsibilities.

## Provenance and stale rejection

The bounded in-memory registry defaults to 24 entries and a two-minute maximum age. It stores task owner, tab/host identity, WebContents identity/version, the complete native frame tree up to 256 frames, each frame's document nonce/URL/viewport/scroll/visual viewport/mutation revision, browser zoom, image dimensions and a SHA-256 hash of decoded pixels. It does not retain PNG buffers or persist files.

Immediately before input, under the same native presentation lease:

1. Validate ownership, retained tab/host, age and image-space coordinate bounds.
2. Re-read all document/frame and viewport state.
3. Capture fresh pixels through the shared inspection session.
4. Compare decoded pixel hash and dimensions, then compare page state again.
5. Convert the image coordinate to CSS viewport coordinates and consume all capture references for that owner/tab before dispatch.

Pixel comparison detects canvas/video repaint that does not mutate DOM. Frame document nonces reject same-URL child navigation even when the top document version and screenshot pixels are unchanged. A rejected stale action sends no input. Once dispatched, the capture cannot be replayed, including after a timeout or cancellation.

Click cleanup sends mouse-up using the already-dispatched root coordinate. It does not try to resolve a frame or screenshot again after cancellation/navigation. `invalidate(owner, tabId?)` clears references when task/tab lifetime ends; `dispose()` clears the registry.

## Executed verification

```powershell
pnpm exec tsc --noEmit -p tsconfig.node.json --pretty false
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm exec electron scripts/browser-visual-input-electron-test.cjs
```

The latest Node TypeScript check passed. Fourteen checks passed using actual BrowserHost tabs and native screenshot/input paths, with isolated temporary HOME/userData and local HTTP fixtures:

1. A screenshot-coordinate canvas click in a hidden task tab records a trusted event without selecting that tab or showing the user's window.
2. A dispatched capture cannot replay its click.
3. Canvas-only repaint with zero DOM mutations rejects the old capture before input.
4. Scrolling invalidates old coordinate provenance.
5. A fresh screenshot maps correctly through 125% browser zoom.
6. A zoom change invalidates a prior capture.
7. Resizing the target native viewport invalidates a prior capture.
8. Foreign task/tab ownership and out-of-image points are rejected.
9. Reloading a hidden child at the same URL invalidates its old capture despite unchanged top version and visible pixels.
10. Same-URL main-document reload invalidates the old capture.
11. Fresh screenshot scrolling sends a trusted wheel event and moves the owned page.
12. An already-aborted coordinate action sends no input.
13. The bounded registry evicts older captures.
14. Cancellation triggered by the actual mouse-down event still releases that button and leaves the capture consumed.

Evidence is in `out/diagnostics/browser-p0p1/visual-input.json`. The test's bundles are in `out/tests/browser-visual-input`; no product build/package, live profile or credential access was used.

An initial resize assertion mistakenly resized the UI-selected other tab. It correctly did not invalidate the untouched background target. The final test resizes the actual retained target's native surface and observes stale rejection.

## Limits

Comparison is exact over all decoded pixels. Animation, caret blinking or video may require a fresh capture; there is no guessed tolerance region. Normal browser zoom is supported and tested. A visual viewport with pinch scale or offset is explicitly rejected because its image-to-CSS mapping has not been proven.

The lease serializes this host's native automation and prevents accidental surface substitution. It cannot freeze arbitrary webpage JavaScript between the final comparison and native input dispatch. The implementation minimizes this interval and rechecks state, but does not claim atomicity against a malicious or continuously animating page.

This is adapter/native evidence. Public browser `capture`/`click_at`/`scroll_at` exposure, vision-result plumbing, business assertions and complete application acceptance are separate parent work.
