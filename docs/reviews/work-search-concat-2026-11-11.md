# Work search allocation follow-up, 2026-11-11

## Scope and implementation

Baseline: **9f93c0263c28a443e5ed9964f4cecd7c0cb3586e**. This is a small performance-only follow-up, not a new search feature or an off-main-thread architecture. The only production change is the outer search-document assembly in WorkListQuery.ts. User-authored issue #27 scheduling/recovery code and Vivion work are untouched.

The previous left-associated SQL || chain repeatedly copied a report-containing string when adding later fields and separators. SQLite's native concat builds the already non-NULL detail suffix in one allocation. The scalar prefix stays outside concat with its original || operator, preserving NULL propagation. Field order, separators, subqueries, normalization, scope/ownership, exact counts, status, page clamping, sorting, result-cache invalidation and public APIs are unchanged. Internal concatenations are deliberately retained. No schema migration, index, dependency change, product build or packaging was introduced.

The fixed better-sqlite3 13.0.3 dependency contains SQLite 3.53.4; its concat implementation copies explicit byte lengths, including embedded NULs. Static review confirmed each suffix argument is non-NULL and already TEXT. This is not a claim that arbitrary raw BLOB values or every possible database encoding are interchangeable under concat.

## Interleaved measurements

50,000 synthetic Work rows, 250 reports. Both implementations use the same database and alternate execution order for six rounds, with the first observation separated and five samples retained. Each call bypasses the page-result cache; prepared statements, SQLite pages and OS caches may be warm. These are not process-cold or disk-cold measurements. Complete result hashes, excluding the nondeterministic watermark, match in all nine cases.

| Report bytes each | Query | Before median ms | After median ms | Reduction |
| ---: | --- | ---: | ---: | ---: |
| 21,014 | DeepReportTail | 352.33 | 343.47 | 2.5% |
| 21,014 | NoSuchTerm_测试 | 354.26 | 347.55 | 1.9% |
| 21,014 | Synthetic 49999 | 388.67 | 379.01 | 2.5% |
| 126,014 | DeepReportTail | 464.46 | 461.39 | 0.7% |
| 126,014 | NoSuchTerm_测试 | 461.01 | 448.10 | 2.8% |
| 126,014 | Synthetic 49999 | 489.91 | 471.48 | 3.8% |
| 630,014 | DeepReportTail | 1270.09 | 1219.03 | 4.0% |
| 630,014 | NoSuchTerm_测试 | 1138.97 | 1085.61 | 4.7% |
| 630,014 | Synthetic 49999 | 1114.78 | 1055.77 | 5.3% |

This is approximately a 2–5% improvement in most measured cases, with one 126KB deep-hit case improving only 0.7%. The longest-report pass also had visible load drift; raw samples are retained. Pure parenthesization gave little benefit and was rejected. An initial version moving the prefix inside concat was not shipped: the conservative delivered version preserves the original NULL propagation, with smaller gains.

The separate sequential eleven-case general matrix and fifteen-case scale matrix also produced identical results, including Unicode, derived guidance, status filters, both sort directions, all pages and clamping. The general run showed transient timing drift, including larger apparent 16–22% gains; those are not attributed to this patch. Unfiltered and broad-prefix paths were effectively unchanged (about +0.8ms and +0.5ms). The paired interleaved matrix above is the speedup evidence.

## Functional and actual UI checks

- Focused summary-query regression passed. New tests observe the complete string passed from actual SQL to the JavaScript matcher, including exact order, every separator, full-width/combining/Greek/emoji text, embedded NULs, text after NULs, JSON-null omission and empty optional fields. The fixture runs in a savepoint, rolls back all data/triggers, and restores the original matcher. This is character-for-character equality at the real JS matching boundary, not a separate raw SQLite-byte oracle.
- A private read-only SQLite backup produced identical responses across all 23 real-profile title/ID/report-tail/view/sort/page cases. Current helper tables were prepared only in a disposable snapshot; original Work records were hash-checked unchanged. Temporary snapshots were removed. No private rows, strings, identifiers or response hashes are published.
- Both actual Electron component → IPC → synchronous-main SQLite passes succeeded with 50k rows and 250 reports of about 630KB each, using isolated HOME/userData and the production 250ms debounce. This is not full-product startup or packaged-app acceptance.
- Deep mixed search: main query **1432.1→1363.3ms**, input to visible results **1740.8→1651.4ms**. Rare title: **1451.4→1420.5ms** main, **1714.5→1700.5ms** end to end. These are single acceptance observations, not repeated statistical claims.
- Both UI passes checked bounded cards, filter totals, page 2, full-report matching, empty/clear, rapid query replacement while an older request was executing, and no renderer console errors. Final screenshots were inspected and are byte-identical. One candidate empty-result interval showed a 100ms renderer frame gap versus about 17ms in the baseline; no zero-jank guarantee is claimed.
- Independent static review passed. Web/node/scripts typecheck passed with zero errors.

The previous **476/476** full default gate applies to parent 9f93c026. The new commit's final integrated full gate is coordinated separately and is not claimed here before it runs. Windows, full-product cold startup, packaging, network and dataset suites were not run for this patch. No cloud CI pass is implied.

Queries remain synchronous. This reduces avoidable copying; it does not remove the roughly one-second main-thread stall for very large report corpora. Broader indexing, asynchronous execution or retention changes require separate correctness work rather than being silently added to this limited patch.

## Reproduce

~~~sh
TMPDIR=<short-external-temp-dir> node scripts/perf-work-list-search-concat.mjs 9f93c0263c28a443e5ed9964f4cecd7c0cb3586e
node scripts/perf-work-list-search.mjs 9f93c0263c28a443e5ed9964f4cecd7c0cb3586e
node scripts/perf-work-list-search-scale.mjs
TMPDIR=<short-external-temp-dir> WORK_SEARCH_REPORT_REPEATS=30000 env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-work-list-search-ui.cjs baseline
TMPDIR=<short-external-temp-dir> WORK_SEARCH_REPORT_REPEATS=30000 env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-work-list-search-ui.cjs candidate
TMPDIR=<short-external-temp-dir> pnpm -s test:bot-work-summary-query
pnpm -s typecheck
~~~

[Public synthetic measurements](work-search-concat-2026-11-11.json). All private validation content remains excluded.
