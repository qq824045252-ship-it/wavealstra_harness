# Native frame document adapter

Implemented only `src/main/capabilities/browser/BrowserDocumentContext.ts` and the isolated executable fixture `scripts/browser-document-context-electron-test.cjs`. No renderer iframe component, shared service, schema, preload or package script was edited by this subtask. The cancelled iframe-removal task produced no edits.

## Contract

- `listBrowserFrames(wc)` enumerates the retained WebContents' native frame tree and returns `frameId`, `name`, `url`, `parentId` and `main`. The opaque ID combines Electron frame-tree-node ID and frame token; it is never used as a CDP frame ID.
- `bindBrowserDocument(wc, frameId, slot, scope)` binds the selected native frame and every ancestor. Omitted frame ID binds the main frame. It returns `identity`, `nativeFrame`, `evaluate`, `validate`, `prepare`, `mapPoint` and `dispose`.
- `evaluate` runs the existing `browserDocumentScript(slot)` observation identity and checks it around each asynchronous frame-local evaluation. Native frame membership, token, URL and navigation generation are checked around awaits. One per-WebContents native navigation listener allows synchronous `validate` to reject even same-URL reloads.
- `prepare` resolves exact iframe owners, then scrolls ancestors from outermost to innermost. Call it before reading the local target geometry. `mapPoint` converts local CSS coordinates to top-level CSS coordinates and validates hit-testing at every ancestor. Call it immediately before trusted root CDP input while retaining BrowserHost's native presentation lease.
- A random postMessage nonce identifies the exact parent owner by `event.source === iframe.contentWindow`, including open-shadow owners. It never guesses by URL, frame name, sibling ordering or Electron/CDP token equivalence. Listeners are removed after handshake/cancellation; owner entries are bounded to 64 per parent document.
- `dispose()` invalidates the context synchronously and removes only its own parent owner entries/listeners. Call it in `finally` after input-release cleanup. Releases must use the last dispatched root coordinates rather than attempting to map a closed or invalidated frame again.

The adapter does not attach a debugger or duplicate task ownership. The caller supplies the already authorized retained WebContents, reuses its native input session and remains responsible for target-node hit-testing/action receipts within the selected document.

## Verification

Executed on the local Electron 44.5.1 runtime:

```powershell
pnpm exec tsc --noEmit -p tsconfig.node.json --pretty false
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm exec electron scripts/browser-document-context-electron-test.cjs
```

Node TypeScript check passed. The Electron fixture passed eleven behavioral checks:

1. Native frame execution across `127.0.0.1 -> 127.0.0.2 -> 127.0.0.1`, with confirmed separate middle renderer process and a duplicate-URL sibling.
2. Root CDP input reaches the intended nested-frame button through two open-shadow iframe owners, positive axis scales, borders, padding and ancestor scrolling. The target recorded one trusted click; the sibling recorded none.
3. Trusted root CDP text insertion writes Chinese and emoji into the focused nested input and leaves the same-URL sibling untouched.
4. Recursive flattened child sessions of the same debugger map the native document nonce to exactly one default Runtime execution context. Its CDP frame ID retrieves Chromium AX data for the expected button, including backend DOM node identity.
5. Rotated ancestor geometry is rejected.
6. Ancestor occlusion is rejected.
7. Cancelled evaluation cannot proceed to mapped input.
8. Unknown frame identities are rejected.
9. Same-URL reload invalidates both synchronous validation and evaluated old references; rebinding gets a new document ID.
10. Idempotent context disposal removes its owner entries and rejects reuse.
11. Removed native frame invalidates the retained context.

Evidence is written to `out/diagnostics/browser-p0p1/document-context.json`, including the mapped point and actual frame-local trusted event coordinates. The test creates an isolated temporary HOME/userData and uses two local HTTP servers. Its fixture-only esbuild step writes to `out/tests/browser-document-context`; no product build/package was run.

The first hidden-window click did not arrive because the native surface had not been mapped. The final fixture shows its isolated window without activating it before navigation and waits for two animation frames before input. This is evidence that the production caller must retain its existing BrowserHost presentation lease. It is not evidence that hidden raw WebContents can accept input without that lease.

## Limits and integration requirements

Only positive axis-aligned transforms are accepted. Rotation, perspective, negative transforms, invisible/clipped/occluded owners or inaccessible owner mapping return `UNSUPPORTED_SCOPE`; they are not marked supported. Open shadow roots are covered; closed-shadow owner traversal is intentionally unavailable. A fresh native frame ID is required after native frame replacement.

The adapter cannot stop arbitrary JavaScript that was already dispatched into a renderer. Scope cancellation rejects its result and blocks later evaluation/input; it cannot undo page effects. Do not replay an uncertain mutating action.

The fixture verifies the adapter plus trusted Electron CDP delivery. Public browser tool integration, business assertions, transfers, diagnostics, dialogs, screenshot provenance and full application GUI acceptance remain the parent task's responsibility. Main-frame mocks may continue using the existing root path; the adapter itself requires real WebContents/WebFrameMain APIs.

The Runtime/AX mapping is a feasibility probe only. Production `BrowserDocumentContext` attaches no debugger and contains no CDP session registry. The parent may integrate this proven nonce mapping into its single shared debugger owner. Chromium emitted GPU shutdown diagnostics after the passing assertions on some runs; the tests exited successfully, but this fixture does not certify application GPU lifecycle acceptance.

Modern Web Guidance was searched for embedded document preview/isolation during the cancelled renderer task. No retrieved web-platform guide shaped this native Electron adapter, and no renderer implementation was changed.
