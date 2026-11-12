# Issue 33: saved-version previews

## Implementation

Based on main `bbfd7cb9`; implemented in an isolated clone, without changing the user's running application or working tree.

- Work attachment entries keep inline preview. HTML uses a unique-origin sandboxed frame served by the existing ArtifactProtocol/MIME runtime. MarkdownArtifactView and read-only CodeView reuse ordinary-mode renderers. Source switching preserves the current HTML interaction; closing releases the preview. System application opening remains an explicit secondary action, not proof that a window appeared.
- HTML registration captures an immutable dependency manifest. Relative HTML/CSS/JS, CSS URLs and literal import/fetch references are resolved within the workspace and copied as content-hash snapshots. No mutable-directory fallback occurs during viewing. Limits: 128 resources, 8 MiB/file, 32 MiB/bundle.
- Later resource registration in the same input refreshes a new version while retaining the old manifest, including when the original HTML was subsequently removed. Same HTML bytes with different resource manifests remain separate Work versions. Cancellation and replay retain existing semantics.
- Result and milestone reports freeze their manifest. An older report with no manifest explicitly stays a legacy single-file preview rather than acquiring newer CSS/JS.
- Generated content receives no Node or application preload/IPC bridge. Version-specific origins and allowlisted resources prevent cross-version access. HTTP navigation is routed to the existing internal BrowserHost, not shell.openExternal. Closing clears version storage; reopening starts a new isolated preview.

## Verification (targeted, not full regression)

- `pnpm -s typecheck`: PASS, scripts new errors 0.
- `test:saved-artifact-preview`: PASS. Actual registration function, late CSS, deleted original HTML, cancellation after preparation, replay, immutable old/new resources, integrity, owner lifecycle and negative navigation.
- `test:durable-artifact-registration`: PASS.
- `test:bot-work-milestones`: PASS, including SQLite storage of identical HTML with distinct manifests.
- `test:bot-work-phase5-review-ui`: 18 React lifecycle scenarios PASS; exact target, stale async responses, close, retry, frozen legacy manifests and same snapshot/latest resource selection.
- `test:saved-preview-desktop`: PASS in real Electron on Omarchy using synthetic documents and an isolated profile. Production file reader, protocol, saved preview service, React components and BrowserHost are exercised. HTML renders; CSS stays v1 after original changes; JS/localStorage works; source switching preserves interaction; internal links load an actual BrowserHost destination; relative subpage works; no bridge/Node/parent access; reopening resets state and preserves draft; missing snapshot/retry; Markdown/JSON/CSV viewers. Fixture uses the application's CSP.
- `test:work-artifact-desktop`: PASS, existing running/recovery/immutable-path/open-error behavior.
- `test:bot-work-delivery-desktop`: PASS, natural milestone entry, frozen A-v1, mutable/unregistered B disabled, replay, two widths, error/retry and legacy final result.
- IPC inventory: PASS after intentionally adding the two saved-preview channels. Test registration audit and diff whitespace check PASS.

The delivery-desktop fixture initially failed to bundle because reusing CodeView pulls Monaco CSS/fonts into a fixture which had no CSS loader. Its test-only build command now supplies the existing worker stub and CSS-empty loader. This is not a product failure or waived regression.

Independent review identified and fixed two defects before publication: legacy reports acquiring newer resource manifests, and deleted source HTML producing an entryless refreshed manifest.

## Evidence and remaining limits

Reproducible scripts are committed. Local generated outputs are `out/tests/saved-preview-desktop-results.json`, `saved-preview-html.png` and `saved-preview-data.png`; screenshots were visually checked. Test windows/profiles were independent of the user's app and were closed after the run. An expected missing-file error is deliberately generated; a nonfatal Electron GPU mailbox warning occurred on window/frame cleanup.

This is genuine Electron integration testing, **not a live-model batch or full running-app acceptance**. No model calls were made, so it does not claim six real-model tasks. The user's original project-management demo, drag-and-drop workflow, Windows/junction-specific behavior, and actual archived conversation navigation have not been separately exercised here. The regular BrowserHost route is tested against a local HTTP page, not a third-party account.

Resources generated through runtime-computed paths cannot be inferred automatically. External network dependencies are explicitly warned and blocked by preview CSP; they are not advertised as a complete offline copy. Historical snapshots without a manifest show a missing-dependency notice. Interactive state is ephemeral and is not a Gadget-save operation. Existing Gadget copy/save code was not modified; this report does not substitute for its independent regression suite. These boundaries must remain visible rather than declaring every Issue 33 checkbox proven.
