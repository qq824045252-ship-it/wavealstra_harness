# Full regression, 2026-11-11

## Scope and isolation

- Omarchy, separate clone on `main`; no changes to the user's active checkout, Vivion, or issue #27.
- Starting revision: `300a675679250697e27861c48861d2e342a34aee`. Final tested source: `d2a8eaaef3c599464463a178837583d947fa528b`, including the regression fixes and cold Work-search optimization.
- The repository default full gate contains 472 headless scripts. GUI, NETWORK, DATASET, and ARTIFACT are separate categories, not implied by a default pass.
- Product build/packaging was not requested and is not performed.
- The crash suites were initially deferred. After the user explicitly authorized them, the complete default gate was rerun on the integrated main: **472/472 PASS**, including all three crash suites. No changes were made to issue #27 or the user’s active checkout.

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

## Final integrated validation

- `TMPDIR="$HOME/frtmp-regression" pnpm -s test:all`: **472/472 PASS, 0 failures, 0 known failures**, 4.5 minutes, on `d2a8eaaef3c599464463a178837583d947fa528b`.
- The exact completed test-name set matches `node scripts/test-all.mjs --list`. No default test is omitted. [JSON evidence](full-regression-2026-11-11.json) records every script and runtime.
- The earlier run of 469 non-crash tests passed on the regression-fix source. The new complete run also covers the subsequently merged Work-search optimization.
- The six environment-contaminated cases all pass with a short temporary root outside a repository. No product workaround or weakened assertion was used for those failures.
- `scripts/test-baseline.json`, test classification, and aggregate timeouts are unchanged. The final gate is the unmodified `pnpm -s test:all`, not the preliminary filtered runner.
- Final integrated `pnpm -s typecheck`: PASS, zero web/node/scripts errors. `git diff --check`: PASS before publication.

## Authorized crash-injection results

All three ran against isolated synthetic data and test-owned child processes. No production profile, user task, or live app process was killed.

1. **Phase 2 recovery: PASS (26.1 s).** Eight recovery checkpoints (outbox, accepted cancellation, pre-result, received inbox, cursor transaction, consumption transaction, effect receipt, and unknown effect), plus two foreground-generation/persisted-cancellation kills. Original execution identity, single effects, inbox drain, and cancellation persistence remain verified.
2. **Phase 5 continuous native story: PASS (13.6 s).** Ten steps on the same SQLite/native stores, two actual SIGKILL boundaries, unreleased owner leases verified, and OS-owner death/lease expiry checked before reopening. Both kills report `signalCode=SIGKILL`. `retain-one` executes once; `must-not-write` executes zero times; successful native writes total five, each marker once. This is real Pi Durable execution with controlled model responses and effects, not physical-phone or packaged-desktop acceptance.
3. **Gateway inbox crash: PASS (2.8 s).** Real strong kill preserves committed FIFO work; native recovery does not repeat the unsafe effect; replies and redelivery remain deduplicated.

The three designated suites cover **13 real strong-kill boundaries**. They required no additional product or fixture changes after the earlier fixes.

## Remaining validation outside the default gate

The repository also classifies 87 GUI, 41 NETWORK, 3 DATASET, and 3 ARTIFACT scripts. Four GUI scripts were run above, leaving **83 GUI, 41 NETWORK, 3 DATASET, and 3 ARTIFACT scripts not run in this task**. Their exact names and platform restrictions are listed in the JSON evidence under `remaining_not_run`.

- Remaining GUI coverage includes other desktop flows, Windows-only automation, Linux native computer-use, and packaged-app acceptance. Four selected real Chromium fixtures are not the complete GUI suite.
- NETWORK includes live model/gateway/browser/remote-device flows and must not be inferred from local fixture passes.
- DATASET: `test:google-workspace-write`, `test:terminal`, `test:task-terminal:live`.
- ARTIFACT: `test:image-resize-assets`, `test:oauth-build-assets`, `test:pi-codemode-assets`. These require authorized product build output. No build or packaging was performed.
- The hidden media-settings window could not produce screenshots in this Wayland session; its behavioral and actual viewport-layout assertions passed.

No claim is made that every release/platform/live integration has been accepted. The completed result is the full **default headless gate**, the three requested crash suites, integrated typecheck, and the four explicitly described GUI fixtures.
