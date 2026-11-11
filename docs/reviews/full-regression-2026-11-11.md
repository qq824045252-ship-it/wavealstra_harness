# Full regression, 2026-11-11

## Scope and isolation

- Omarchy, separate clone on `main`; no changes to the user's active checkout, Vivion, or issue #27.
- Starting revision: `300a675679250697e27861c48861d2e342a34aee`.
- The repository default full gate contains 472 headless scripts. GUI, NETWORK, DATASET, and ARTIFACT are separate categories, not implied by a default pass.
- Product build/packaging was not requested and is not performed.
- Per the latest sequencing instruction, the three crash-injection suites remain deferred while issue #27 optimization is ongoing. This report covers the other 469 default scripts and selected GUI checks, not a complete 472-script pass.

## Confirmed fixes

1. Restore the credentials bootstrap as the first application import. New Google Workspace imports had moved it below service imports; retain the existing Linux password-store initialization guard rather than weaken the test.
2. Update the handoff fixture for the retired tool-scope permission gate. Default permissions must not block a valid owner handoff. Retain and strengthen rejection checks for nonexistent, foreign-user, disabled, and unchanged owners, plus atomic delegation adoption.
3. Update review-projection fixtures for bounded Work summaries. A selected Work absent from the current page must remain available for on-demand detail; invalid Bot identity still clears the selection.
4. Fix the Work-detail Electron fixture's false-success exit status. Its obsolete 100 ms search wait ran before the product's 250 ms debounce and threw an assertion, but `app.quit()` returned exit 0. Verify the original failure now returns exit 1, then wait for the actual result and retain all detail/search assertions.
5. Fix media-settings viewport verification on Wayland. Resizing a hidden native window left all three cases at 1280 px. Explicit Chromium viewport emulation now asserts and tests 1280/760/480 px, including the one-column mobile layout.

## Preliminary diagnostics

- Typecheck passed with zero web/node/scripts errors.
- The first attempt was interrupted after `/tmp` writes returned errno -122 (quota) and SQLite IOERR. This was an environment failure, not a product pass or new failure baseline.
- A second phase ran the 469 non-crash scripts: 460 passed and 9 failed. Six failures were fixture-environment contamination because the temporary root was inside the checkout (inherited Git/AGENTS restrictions or overlong Unix socket address). The final run uses a short temporary directory outside any repository. The other three failures are the fixes above.
- The failing scripts were `atspi-transport`, `bot-work-phase3-handoff`, `bot-work-review-projection`, `durable-subagent`, `linux-session`, `packaged-package-json-guard`, `subagent-acceptance-gate`, `subagent-acceptance`, and `subagent-worktree`.
- Existing team recovery and media-capabilities DOM passed in the preliminary phase. No changes to the known-failure baseline, test classification, timeouts, or skipped-test lists.

## GUI checks

- Work browser: real Chromium, 137 synthetic Works, bounded pages, full-text search, status filters, selection, refresh/shrink/grow, 440 px layout: PASS.
- Work detail: 390/760/1440 px, full goals, exact original request, structured reports, stale-response protection, goal-only search without full-Work reads: PASS after the fixture fixes. The negative-path run confirmed exit 1 before replacing the stale wait.
- History paging: personal and team at 1440/760/390 px, 100/100/50 pages, repeated click protection, navigation interruption, concurrent append, focus, anchor preservation, late height growth, viewport resize, EOF/latest: PASS.
- Media capabilities: 16 behavior groups and real 1280/760/480 px layout assertions: PASS. Hidden-window screenshot capture is unavailable in this Wayland session (`UnknownVizError`/timeout); this is not a screenshot or packaged-app acceptance claim.

## Final validation

- Final default selection excluding the three expressly deferred crash suites: **469/469 PASS, 0 failures, 0 known failures**, 3.8 minutes.
- The set of completed test names was compared with `node scripts/test-all.mjs --list` minus the exact three deferred names. No other default test was omitted. Per-script status and runtime are in [the JSON evidence](full-regression-2026-11-11.json).
- The six environment-contaminated cases all passed after using an external short `TMPDIR`; no production workaround or weakened assertion was applied for them.
- All four selected GUI fixtures passed after the documented fixes. Remaining GUI, NETWORK, DATASET, ARTIFACT, and packaged-app validation were not run and are not claimed as passing.
- Final `pnpm -s typecheck`: PASS, zero web/node/scripts errors. `git diff --check`: PASS.
- `scripts/test-baseline.json` and `scripts/test-all.mjs` are unchanged.
- Deferred and **not run**: `test:bot-work-phase2-recovery`, `test:bot-work-phase5-native-story`, `test:gateway-inbox-crash`. Do not interpret this report as 472/472 or as crash-recovery acceptance.
- This result tests the source of this change on parent `300a675679250697e27861c48861d2e342a34aee`; a concurrent Work-search optimization has not yet been integrated and must report its own validation.
