# Native Electron prompt and beforeunload

## Root cause

Electron 44.5.1 replaces the page's `window.prompt` with a function that throws `prompt() is not supported.` before Chromium can emit `Page.javascriptDialogOpening`. This is explicit in [Electron's renderer window setup](https://github.com/electron/electron/blob/v44.5.1/lib/renderer/window-setup.ts). Merely obtaining Blink's original prompt does not fix manual responses: Electron's [`-run-dialog` handler](https://github.com/electron/electron/blob/v44.5.1/lib/browser/api/web-contents.ts) immediately invokes the native callback with `(false, '')` for prompt dialogs. A delayed CDP answer therefore receives `null`, even though an immediate rule can appear to work by racing that callback.

Electron's [`RunBeforeUnloadDialog`](https://github.com/electron/electron/blob/v44.5.1/shell/browser/api/electron_api_web_contents.cc) is different: it emits `will-prevent-unload` and immediately resolves the native callback from `event.defaultPrevented`. An asynchronous manual answer cannot hold that native callback open.

## Implementation

- `src/main/capabilities/browser/BrowserPrompt.ts` owns one adapter per exact WebContents. Startup checks the private Electron handler's count, arity, and prompt branch before replacing it. An unknown shape fails with `UNSUPPORTED_SCOPE`; no second debugger or renderer IPC is introduced.
- Only the prompt branch is intercepted. Alert and confirm delegate to the original handler. The callback is retained until the exact prompt ID is answered or the adapter is disposed; accepted empty text, accepted default text, and cancellation retain the native string/null behavior.
- A same-origin, temporary blank iframe supplies Blink's actual native prompt function. The temporary node is removed immediately. The replacement calls the native function with the real page window as receiver, so Chromium identifies the correct main/child frame. Only the recognized Electron shim is replaced; a site's custom prompt function is preserved. No DOM prototypes are patched.
- The existing inspector installs the adapter for future root/child documents. Current native frames are refreshed through WebFrameMain, including OOPIFs. New-document initialization works before an initial inline page script. This remains a guarded Electron-internal dependency, not a stable public Electron prompt API.
- `BrowserPageEvents.ts` publishes native prompts through the existing `currentDialog`, rule, and answer flow. Native prompt callbacks are authoritative; the CDP prompt event is not answered independently. A late close event cannot clear another prompt whose native callback is still pending.
- `BrowserHost.ts` changes only the beforeunload handler/import: an active adapter takes the synchronous decision before the normal manual system dialog. Prearmed rules accept/dismiss that actual WebContents. The CDP beforeunload event receives the same cached decision, which also releases Chromium's protocol dialog state.
- Disposal cancels the held prompt, restores only this adapter's original native handler, unregisters its own listeners/scripts, and restores the page wrapper only if the site has not replaced it. Shared inspector domains remain enabled.

## Explicit limits

Unmatched beforeunload safely cancels the original navigation and leaves a pending informational dialog. A late `dismiss` clears it. A late `accept` fails with `UNSUPPORTED_SCOPE`: the caller must prearm an accept rule and explicitly retry the original operation. The adapter does not guess whether the original operation was navigation, back, reload, or close.

After a denied navigation, `loadURL` rejection and `Page.javascriptDialogClosed` alone can precede Chromium's navigation cleanup. `BrowserPageEvents.settleNavigationDialog(scope)` tracks the native beforeunload synchronously, awaits the close event, and then acknowledges `wc.executeJavaScript('true')` on the same WebContents. The caller invokes it while handling the denied navigation before returning the failure. It never retries navigation. Disposal rejects unresolved waits, and the caller's scope bounds each await separately so a canceled wait cannot later dispatch the renderer barrier. The real prompt test uses this production helper, with no fixed sleep or separate test-only close waiter.

The internal Electron handler guard intentionally rejects an incompatible Electron version or a second owner. Sandboxed documents which prohibit native modal dialogs retain Chromium's restrictions. Existing application iframe previews were preserved; no renderer component was removed.

A newly created WebContents has no committed renderer document. Attaching the shared inspector and awaiting `DOM.enable` before any load can stall. The production service first commits `about:blank` on that exact task tab, then installs instrumentation and rules before the requested first navigation. `refresh()` skips frames with an empty URL; it does not try to execute scripts before that bootstrap.

## Actual evidence

`scripts/browser-prompt-electron-test.cjs` runs real Electron 44.5.1 with a temporary profile, actual BrowserHost/WebContentsView, and actual shared PageInspectionSession. The single test bundle keeps the BrowserHost/BrowserPageEvents adapter registry identical. It does not launch the product or use a live user profile. Evidence: `out/diagnostics/browser-p0p1/prompt.json`.

Twelve behavior checks passed:

1. Unmodified actual page prompt reproduces the original Electron exception.
2. A real button's synchronous prompt remains pending for 200 ms and returns Chinese/emoji text after a manual answer.
3. Empty text, default text, and cancel/null retain native semantics.
4. Two consecutive native prompts use ordered, distinct callbacks.
5. The original confirm flow remains functional.
6. A real cross-origin OOPIF's prompt returns its answer in that child.
7. A site-owned prompt replacement is preserved.
8. Prompt in an initial inline script on a new document receives the prearmed answer.
9. Actual beforeunload dismiss/accept rules control the tab with zero native system-confirm calls.
10. Unmatched beforeunload cancels safely and rejects guessed late navigation acceptance.
11. Disposal restores the original Electron native handler and page wrapper.
12. A fresh task tab bootstraps through `about:blank`, arms prompt handling, and answers an inline prompt on its first requested navigation.

Commands passed (unset inherited `ELECTRON_RUN_AS_NODE` for Electron tests):

```powershell
pnpm exec electron scripts/browser-prompt-electron-test.cjs
pnpm exec electron scripts/browser-beforeunload-service-electron-test.cjs
pnpm -s test:browser-page-events-electron
pnpm -s test:browser-accessibility-electron
pnpm exec tsc --noEmit -p tsconfig.node.json
```

`scripts/browser-prompt-probe.cjs` is the independent root-cause probe; its delayed response demonstrates why restoring the native function without intercepting Electron's immediate prompt rejection is insufficient. The focused passes above are not full repository, packaged-product, or desktop acceptance.

The public service regression in `scripts/browser-beforeunload-service-electron-test.cjs` originally reproduced `NAVIGATION_FAILED: ERR_FAILED` on the immediate accepted retry before the production helper was wired into navigation error handling. With production integration it passes four checks: two consecutive deny/accept navigation cycles, denied reload preserving the original document followed by accepted reload producing a new document, and denied close retaining the exact tab followed by accepted close destroying it. Every retry is a separate explicit `BrowserAutomationService.execute` call. The test uses no direct settling call or fixed wait; native system-confirm count stays zero. Evidence is `out/diagnostics/browser-p0p1/beforeunload-service.json`.
