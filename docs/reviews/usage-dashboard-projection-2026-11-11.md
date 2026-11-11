# Usage dashboard: narrow streaming heatmap projection

Date: 2026-11-11. Baseline: `c8410b286e9402fdfddf51d45a32c4103de49693`.

## Necessary window, unnecessary payload

The default “today” dashboard also shows 53 weeks of activity and current/longest streaks. **Its 371-day read is required and remains intact.** The selected range still drives summary, models, skills and daily peak. The UI's “all” option is 3650 days, not a new yearly option.

The original short-range path fetched complete usage rows for both the selected range and the heatmap window. At 300,000 events, the heatmap materialized 285,000 rows with model, session and performance payloads that its daily bins never use. This is a synchronous production service path, independent of React development overhead.

The change adds a 14-column projection consumed synchronously with SQLite iteration. It retains timestamp order and passes rows through the exact same extracted coverage normalization into the unchanged JavaScript daily aggregation. The full selected-range query and every downstream aggregation remain intact. Ranges of 371 days or more continue reusing their complete selected-range rows.

No SQL SUM, UTC regrouping, cache, new index, new pagination, reduced window, asynchronous architecture or changed skill-file behavior was introduced. No Vivion or #27 implementation was modified.

## Real service measurement

The standalone Node benchmark calls real `AppDatabase` disk SQLite and the production `UsageStatsService.dashboard` directly. It is not an Electron click-to-visible latency benchmark. Calls were made serially with 10k/100k/300k synthetic events. About 95% lie in the 371-day window, including 5% today; coverage includes missing/known/unknown/zero values and mixed source kinds. Current-style durable session identifiers are synthetic. A separate case adds 32 actual old JSONL files, approximately 17 MiB in total, to preserve whole-file skill scanning.

Fixed clock: 2026-11-11T12:00:00Z. The original commands did not override TZ; the same host's default was subsequently verified as Asia/Shanghai. The current-host confirmation is explicitly separate from per-process measurements. All runs used warm OS cache; no cold-disk claim is made.

Default today window, median of five warm calls:

| Events | Baseline wall | Candidate wall | Change | Baseline → candidate process CPU |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 29.9 ms | 26.8 ms | −10.6% | 31.1 → 28.9 ms |
| 100,000 | 463.0 ms | 329.6 ms | −28.8% | 657.0 → 355.1 ms |
| 300,000 | 1761.5 ms | 1290.9 ms | −26.7% | 2220.6 → 1344.3 ms |

The queued zero-delay timer is delayed by approximately the same wall duration. **Large ledgers still block the main event loop for about 0.33/1.29 seconds. This is a reduction, not elimination of blocking.** CPU is process-wide user+system, not a thread-only measurement.

For 100k/300k with a 30-day selection, wall medians were 450→364 ms and 1652→1427 ms. The unchanged 371-day branch measured 566→596 ms and 2028→2120 ms against the first baseline; a reverse-order frozen baseline measured 649/2234 ms. These samples establish neither an improvement nor a reliable regression for that branch. No “all” window speedup is claimed.

At 300k/default-today, after-call heap snapshots had a maximum of 889→122 MiB and RSS snapshots 1328→281 MiB. These are GC/process-order-dependent snapshots, **not transient peaks, steady-state budgets or leak evidence**. The accompanying JSON includes medians, extrema and all cases rather than only the best result.

A diagnostic baseline attributes most time to full-row SQL materialization/hydration. Candidate iteration is not captured by the old `.all()` timing hook; its diagnostic residual includes SQLite iteration and must not be called pure JavaScript. Plain measured calls have no per-row instrumentation.

## Memory versus time decision

A benchmark-only source override tested collecting the narrow rows with `.all()` instead. In a controlled three-sample range1 comparison, bulk reduced 300k wall time from 1240 to 1127 ms, but RSS-after maximum rose from 196 to 399 MiB and heap-after from 62 to 215 MiB. Whole-process CPU changed by about 1%. The delivered code keeps streaming to avoid that extra retention. This experiment did not edit product source.

## Equivalence and validation

- All 12 scale/range/legacy cases exactly matched the frozen baseline's complete dashboard DTO using deepStrictEqual, including floating values, models, skills, daily bins and streaks. Their hashes also match the initial baseline.
- New default headless regression: 281 whole-dashboard comparisons across 11 real disk fixtures. It also independently checks every queryRows field and coverage normalization, not just two paths sharing a helper.
- Boundaries include empty data, UTC/Shanghai/New York, DST changes, leap day, exact range cutoffs, future dates, 0/negative/fractional ranges, missing coverage rows and actual read-only failure to create the coverage table, known zero versus unknown, raw totals differing from component sums, disposed/non-call rows, same-timestamp floating-point accumulation, and insert/update/delete freshness.
- Legacy skills retain whole-file scanning, duplicate-file suppression, range-only file selection, missing/malformed files, old skill messages, sorting and top20 behavior.
- SQLite iterator early return and consumer exceptions release their statements; subsequent writes, queries, DDL and close pass.
- Existing usage-stats: 163 assertions passed. Usage reconciliation: 30 passed. Classification audit passed with 477 headless and 88 GUI tests; the new real-app GUI test is explicitly Linux-only because its process identity/cleanup uses `/proc`.
- Final full typecheck passed: web, node and scripts, zero errors. Final syntax and classification checks passed.
- The real Linux dev application passed Today/30 days/All (3650 days), 371/3650 individual daily-cell values, all model/skill pages, weekly/cumulative/daily switches, unknown/partially known/known-zero display, Escape and reopening. Rendered fields matched real IPC DTOs, renderer errors were zero, and the independently identified test main process exited. This uses CDP/DOM activation, not native physical-input acceptance.
- Existing display limitation: the unchanged “All” heatmap compresses 522 weeks into fixed width, making cells too dense. Data/DOM equality passed, but this is not claimed as visually fixed. No renderer or CSS was changed.
- The independent full default gate is requested after publication; no previous commit's result is claimed for this candidate.

No product build, packaged application, Windows UI, provider/network or cloud CI pass is claimed.

## Reproduce from this commit

Use a short writable temporary directory outside the repository. The runner creates and cleans only its own isolated profile. The following establishes every input required by the comparison script:

```sh
export TMPDIR=/home/vivion
export TZ=Asia/Shanghai
USAGE_SOURCE_REF=c8410b286e9402fdfddf51d45a32c4103de49693 node scripts/perf-usage-dashboard.mjs 10000,100000 baseline
USAGE_SOURCE_REF=c8410b286e9402fdfddf51d45a32c4103de49693 node scripts/perf-usage-dashboard.mjs 300000 baseline-large
node scripts/perf-usage-dashboard.mjs 10000,100000,300000 candidate
USAGE_SOURCE_REF=c8410b286e9402fdfddf51d45a32c4103de49693 SAMPLES=1 DIAGNOSTICS=0 node scripts/perf-usage-dashboard.mjs 10000,100000,300000 baseline-reverse
node scripts/perf-usage-dashboard-compare.mjs
pnpm -s test:usage-dashboard-projection
pnpm -s test:usage-stats
pnpm -s test:usage-recon
env -u ELECTRON_RUN_AS_NODE pnpm -s test:usage-dashboard-dev
```

The adjacent JSON preserves measured source hashes, distribution summaries, diagnostic samples, complete candidate DTOs and exact comparison results. Individual warm samples were not saved in the original runs; the runner now records them for future runs. The post-measurement runner changes improve profile isolation, environment metadata and recording only; product source hashes remain those measured. Runtime files/screenshots remain under out/diagnostics/usage-dashboard and usage-dashboard-dev.
