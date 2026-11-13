# Saved result file actions — 2026-11-13

## Scope

The Work result attachment card now has Preview, Open with system app, and Save (Save As). Preview retains the existing WorkFilePreview path and behavior. System opening and saving accept only content-addressed saved artifacts, never a mutable original-file fallback.

System applications receive a separately verified copy, so ordinary editing in the external application does not modify retained evidence. Save As validates the source again after the native dialog, writes a complete verified temporary file, and only then atomically replaces the selected destination. Cancellation does not write a destination. The main process checks the host window, its main frame, renderer URL, snapshot path, regular-file identity, and SHA-256. Reads/copies use 64 KiB buffers.

HTML export is explicitly a single-file copy, not a website bundle. Registered CSS/image/JS dependencies remain available to the existing internal preview but are not exported by these buttons. The UI explains this distinction. External applications do not have the internal preview sandbox.

## Verification on integrated main (parent 2efe672a)

- `node scripts/test-guard.mjs node scripts/saved-artifact-actions-test.mjs`: PASS. Exact version, external editable copy, cancel, overwrite, protected storage, mutable/outside/tampered/missing sources, source deletion while dialog is open, actual Windows hardlink/junction, missing target parent, external-app error.
- `node scripts/run-tsgo-ui-test.mjs scripts/saved-file-actions-dom-test.tsx`: PASS. Three labels, unchanged preview callback, exact request identity, duplicate-click guard, saved/canceled/error states, missing snapshot.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json`: PASS.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json`: PASS.
- `node scripts/test-all.mjs --audit`: classification check PASS; not a full-suite execution.
- Independent read-only review: no confirmed blocking defect after streaming, IPC and save-path revisions.

No Codex test tasks, esbuild, product builds, packaging, or real user data were used. Existing UI test selectors were updated to the new Preview label while retaining their assertions. The larger phase5 UI test compiled with TypeScript, but its Node execution was blocked by the existing runner's unsupported third-party markstream CSS import; it is not recorded as passing.

## Remaining boundaries

Native Windows Save As dialog/default application end-to-end interaction and the full regression suite have not been run for this change. Parent-directory/target identities are checked immediately before atomic replacement; Node has no portable directory-handle-relative rename API, so this is not a claim of isolation against a hostile same-user process racing filesystem namespace replacement. Previously selected files remain unchanged on source-validation or temporary-copy failure.
