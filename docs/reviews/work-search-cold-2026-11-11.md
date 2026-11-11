# Work list cold-search optimization, 2026-11-11

## Scope and method

Baseline is `300a675679250697e27861c48861d2e342a34aee`. Production changes are confined to `WorkListQuery.ts`; no schema, scope, status classification, ordering, watermark, or pagination contract changed. The independent regression/fixture commit `bd42a6a4` was fast-forwarded before final focused checks and GUI acceptance.

Measurements used isolated synthetic databases on Omarchy, serialized after other regression load finished. “Cold” means the Work page-result cache is bypassed in an existing transaction, **not** cold disk or OS caches. Each case has seven timed samples after a reference read. The fixture has 50,000 Work rows, mixed lifecycle categories, and 250 long reports. Full response hashes exclude only the nondeterministic watermark. Source hashes and raw timings are in the adjacent JSON.

## Change

- Normalize query terms once per distinct string instead of for every candidate row.
- Probe at most 32 scoped, visible rows using only scalar search fields. This chooses an execution plan, never a subset of results. When at least half match, a lazy SQLite CASE skips expensive related-detail text for positive scalar matches. Every miss still uses the original complete search document. Sparse/deep-only searches retain the original full-text plan.
- Skip the page-selection scan when the exact filtered count in the same transaction is zero.

An unconditional shortcut was rejected after it slowed deep-only searches by about 10%. The bounded plan probe avoids that measured regression without introducing a searchable-text cache.

## Paired query results

Milliseconds; medians. All ten full response hashes match the baseline.

| Case | Before | After | Change |
| --- | ---: | ---: | ---: |
| unfiltered | 136.54 | 137.47 | +0.7% |
| title-all | 503.14 | 199.51 | -60.3% |
| title-rare | 764.97 | 766.46 | +0.2% |
| goal-unicode | 393.11 | 361.25 | -8.1% |
| detail-tail | 391.39 | 374.54 | -4.3% |
| mixed-title-detail | 409.06 | 380.43 | -7.0% |
| derived-guidance | 485.71 | 455.97 | -6.1% |
| no-match | 712.13 | 341.69 | -52.0% |
| paused-page3 | 510.28 | 199.10 | -61.0% |
| closed-page-clamp | 706.57 | 220.66 | -68.8% |

The mixed full-text result was also walked through every page in both sort directions: exactly 250 distinct matches, with reverse ordering and no duplicates or omissions. The existing focused suite additionally covers scope/owner isolation, all status branches, derived guidance, archive/trash, host changes, cross-connection writes, transaction rollback, and bounded journal replay. New behavior assertions cover Unicode query changes, positive shortcut laziness, a deep-only row missed by the representative probe, complete fallback, and no second scan for zero matches.

## Actual Electron response

The real `BotWorkBrowser` and `useWorkQueryPage` ran through IPC into synchronous SQLite on the Electron main thread, with 50,000 synthetic rows (30,000 active). This is a component/main-process fixture, **not** full-product startup or a production-profile test. The normal 250ms search debounce is included. GUI results are one acceptance pass, not a statistical latency distribution.

- Broad title: main query 542.8 → 223.6ms; input to visible result 834.4 → 524.7ms.
- Empty result: main query 671.0 → 355.6ms; input to visible result 929.6 → 635.1ms.
- Mixed title/report: main query 405.0 → 362.0ms.
- Rare title: main query 817.7 → 789.6ms, broadly unchanged.
- Both passes verified 24-card bounds, classification counts, page 2, deep search, empty/clear, rapid replacement during the older main-thread query, and no renderer console errors. Screenshots were inspected locally.
- Renderer frame gaps during these samples were 16.8–33.4ms. This does **not** mean the Electron main thread was nonblocking: its synchronous query durations are explicitly reported above.

## Verification and remaining limits

Passed after integrating `bd42a6a4`: `test:bot-work-summary-query`, complete `typecheck` (web/node/scripts, zero errors), both real Electron acceptance passes, and all benchmark equivalence assertions. The initial GUI/focused attempt on `/tmp` failed at SQLite WAL initialization with `SQLITE_IOERR_WRITE`; rerunning with an external home-filesystem TMPDIR passed. The GUI harness exits nonzero on failure.

The new patch still needs the coordinated final 472-case headless regression, including the three crash-injection cases. The earlier 469/469 report is not claimed as a full pass for these new changes. No product build/package, real profile, external provider, or user data was used.

Search still runs synchronously. A sparse 50k title search remains about 766ms, and the existing heavier fixture (50k rows plus 200 much longer reports) measured about 1.65s. Moving reads off the main thread or changing the search index would need separate snapshot, invalidation, and lifecycle correctness work; this patch does not claim to solve those costs.

## Reproduce

```sh
node scripts/perf-work-list-search.mjs
TMPDIR=<external-short-temp-directory> env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-work-list-search-ui.cjs baseline
TMPDIR=<external-short-temp-directory> env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-work-list-search-ui.cjs candidate
TMPDIR=<external-short-temp-directory> pnpm -s test:bot-work-summary-query
pnpm -s typecheck
```

The benchmark writes only to `out/diagnostics/work-search/` and its isolated fixtures. UI HOME/config/userData are isolated; the actual application profile is not read.
