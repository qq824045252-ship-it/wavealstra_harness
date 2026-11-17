# Chromium accessibility integration

This subtask adds only `src/main/capabilities/browser/BrowserAccessibility.ts`, `scripts/browser-accessibility-electron-test.cjs` and this document. The parent owns the shared inspection-session protocol/replay changes and public browser-tool wiring.

## Consumer contract

```ts
const accessibility = new BrowserAccessibility(inspectionSession, observationSlot);
const tree = await accessibility.snapshot(documentContext, scope, {
  maxNodes: 200, maxChars: 30000, maxDepth: 24,
});
const matches = tree.nodes.filter(node => node.role === 'button' && node.name === 'Confirm payment');
// Preserve ambiguity. The caller chooses a unique scoped node before acting.
const node = matches[0];
if (matches.length !== 1 || !node) throw new Error('Target must be unique');
const target = await accessibility.resolveNodeRef(documentContext, node, scope);
// target is {selector, tag}, using the UI engine's existing WeakMap identity.
// Retain the original document context for subsequent action validation.
accessibility.dispose();
```

`snapshot` returns frame/document identity, bounded AX nodes, a truncation flag and explicit coverage. Chromium supplies roles, accessible names, descriptions and states. Nodes include `documentId`, `nodeId`, optional `backendNodeId`, `role`, `name`, `ignored`, `states`, and per-node metadata truncation when applicable. The state allowlist includes checked, disabled, selected, expanded, readonly, required and focus/editability states. Editable values and arbitrary properties are not exported.

Snapshots explicitly say `actionableRefs: excluded`. `resolveNodeRef` is a separate exact conversion for a node present in the latest returned observation of that document. It uses `DOM.resolveNode` in the mapped default context and a document-guarded `Runtime.callFunctionOn` to register `window.__mybuddyUiRefs` and `data-mybuddy-ui-ref`. It rejects disconnected/non-element nodes, releases its own remote object and does not infer selectors from text or DOM positions.

Pass the whole AX node to `resolveNodeRef`, not just `backendNodeId`. Real nested tests demonstrated that backend IDs can collide between renderer processes. The method requires the source document ID and checks it before sending any protocol command.

## Session and frame ownership

The observer subscribes to the existing `PageInspectionSession`; it never attaches a second debugger or opens another browser. It recursively enables default Runtime contexts and Accessibility in child iframe sessions using flattened auto-attach. The native `BrowserDocumentContext` nonce is evaluated in each candidate default Runtime context. A unique exact nonce match supplies the session and CDP frame ID. No URL, native frame token, sibling position or name is used for identity matching.

Context destruction, context clearing, child detach and inspector detach invalidate state. Native context validation runs before and after asynchronous work, including final AX and DOM results. The caller's existing `AutomationScope` controls deadlines and cancellation. A cancelled snapshot sends no new command.

`dispose` removes only this observer's subscriptions/state. It never sends domain-disable commands or detaches the shared debugger. Domain enablement and child attachment remain with the inspection connection owner until that owner releases the connection.

The shared inspection connection must replay current `Runtime.executionContextCreated` and `Target.attachedToTarget` events to a new subscriber. Calling `Runtime.enable` twice does not emit existing contexts again. This was reproduced with a real already-enabled Runtime and initially caused a timeout. The parent's live protocol replay fix was then tested with actual `BrowserPageEvents.start()` before AX construction, and again by disposing/recreating the AX observer while keeping diagnostics active.

## Executed verification

```powershell
pnpm exec tsc --noEmit -p tsconfig.node.json --pretty false
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm exec electron scripts/browser-accessibility-electron-test.cjs
```

The latest Node TypeScript check passes. The Electron 44.5.1 fixture passes ten behavioral checks:

1. Main-frame AX snapshot reads a native label and excludes child document controls.
2. OOPIF accessible names come from native labels and `aria-labelledby`, including open-shadow labels, required/readonly, mixed checkbox and disabled states. Duplicate names remain separate nodes.
3. Recursive child attachment resolves a nested frame returning to the root origin, including its computed accessible name and exact DOM node reference.
4. Resolved refs stay stable and appear only in the observed child document, not the main page or a same-URL sibling.
5. Foreign-document and removed-node reference conversion fails.
6. Node/character budgets report truncation and invalid limits are rejected.
7. An aborted snapshot sends no protocol command.
8. Same-URL navigation rejects the old native context and fresh binding maps the new context.
9. A new AX observer uses replayed current child sessions/contexts after prior observer disposal.
10. Diagnostics started before AX continue receiving console events after AX disposal. The shared debugger stays attached and no domain-disable command is sent.

The fixture uses isolated temporary HOME/userData, local servers on `127.0.0.1` and `127.0.0.2`, actual `PageInspectionSession` and `BrowserPageEvents`, and actual Chromium Runtime/Accessibility/DOM commands. Output is in `out/diagnostics/browser-p0p1/accessibility.json`; fixture-only bundles are in `out/tests/browser-accessibility`. No product build/package was run. Some earlier passing runs emitted Chromium GPU teardown diagnostics; the latest run exited cleanly.

## Remaining boundaries

This module snapshots one exact frame at a time. It does not merge child documents or claim all page data is covered. Depth, node, metadata and output budgets can truncate results; callers must preserve the flag. Exact DOM conversion supplies an observed selector, not proof that a later action was accepted or that a business operation completed.

Public tool/schema integration, UI-engine use of Chromium semantic names, input actionability, screenshot provenance and full application acceptance remain separate parent work. This fixture proves the real engine and shared-session adapter, not the entire user workflow.
