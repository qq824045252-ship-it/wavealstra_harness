# Work partial-result projection performance, 2026-11-11

## Scope

Baseline: `1df82d13527083e39b503e5527cb54df8d96c8df`. Work ran in a separate Omarchy clone on `main`, without changing the active checkout, accessing Vivion, or modifying issue #27's scheduling implementation. No user database or credentials were used. No product build, package, or installation was performed.

Only `WorkPartialResults.ts` changes production behavior internally. The returned data, historical records, completion rules, continuation ancestry, owner/input checks and ordering remain unchanged.

The original `list()` reads the same binding and execution metrics for every subitem. `gaps()` reads those bindings again, loads all continuation plans for each gap, then repeatedly re-reads and parses every subitem when following each continuation. Full Work detail invokes several of these readers. This is synchronous work on the host path.

The patch reuses binding reads within one `list()` call and reuses item, plan, adoption and reached-plan binding reads within one `gaps()` call. Nothing persists between calls. It does not introduce a database-snapshot guarantee: as before, a detail projection outside a transaction is not atomic against an independent connection's concurrent commits.

## Completed paired measurements

Synthetic disk-backed SQLite fixtures use the actual `WorkService.getProjection`, including milestone projection. All subitems represent unresolved failed checks. The continuation case has failed retry executions without matching completed facts. These are scale fixtures, not measurements of the user's existing data or a claim about how common these histories are.

The runner loads the exact baseline class from Git and switches only the shared partial-results instance's prototype. Baseline and candidate use the same database, identities and WorkService. After warm-up, six alternating AB/BA pairs are measured per scenario. Timing excludes DTO comparison and query counting. The complete returned DTO is checked, not only selected fields.

Host: AMD Ryzen 7 4800H, 16 logical CPUs; Linux 7.2.14-arch1-1; Node v26.13.0. Median backend wall times:

| Subitems | Source bindings | Dispatched retry plans | Baseline | Candidate | Prepare calls, baseline → candidate |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 20 | 1 | 0 | 10.49 ms | 2.90 ms | 333 → 63 |
| 100 | 1 | 0 | 41.56 ms | 4.07 ms | 1,453 → 63 |
| 1,000 | 1 | 0 | 359.71 ms | 18.66 ms | 14,053 → 63 |
| 1,000 | 20 | 0 | 354.70 ms | 23.68 ms | 14,091 → 253 |
| 100 | 5 | 5 | 1,251.88 ms | 20.81 ms | 42,471 → 143 |

All **75 complete DTO comparisons** passed. Raw wall, process-CPU, timer-delay, heap-delta samples, query counts, source hashes and the tested diff are in the adjacent JSON. Prepare counts measure actual `prepare()` calls during one separately instrumented projection; they are not statement counts inferred from source text.

The 100-subitem case saves about 37 ms; the 1,000-subitem/multiple-binding case saves about 331 ms. The small 20-subitem case saves only about 8 ms. These are host projection measurements, not end-to-end UI, startup, network or model response latency. The native Electron runtime and browser rendering were not benchmarked here.

An earlier, excluded stress attempt used 1,000 subitems and 20 retry plans. Its baseline exceeded the repository's unchanged 6 GiB guard (6,263 MiB RSS at 33 seconds) and was terminated. It produced no completed comparison for that case. The guard was not raised; the reported continuation fixture was reduced to 100 subitems and five plans. This is a benchmark guard result, not evidence that a production app crashed.

## Behavior and validation

The new `test:work-partial-read` verifies:

- Reads scale with distinct source bindings and reached plans, rather than subitem count.
- Exact item matching, existing task-name fallback, shared retries and multi-hop resolution.
- Reachable cycles terminate while independent completed results still resolve.
- Subsequent calls see status changes, new results, changed requests and transaction rollback.
- Historical intents and unadopted owners remain excluded.
- Missing bindings and malformed item/plan data still fail; plans remain lazy when no current gaps are eligible.

Independent read-only review found no release-blocking issue in the patch, tests or benchmark harness.

Passed focused suites: `work-partial-read`, `bot-work-phase3-partial-settlement`, `bot-work-milestones`, `bot-work-phase3-handoff`, `bot-work-phase3-collaboration`, `bot-work-phase3-pause-backlog`. Typecheck passed with zero web/node/scripts errors. Classification audit and `git diff --check` passed. **Full default headless gate: 478/478 PASS, zero failures and zero known failures, 4.6 minutes.** All 478 individual results are preserved in the adjacent JSON, including the unchanged recovery/crash and performance serial pool.

No GUI, NETWORK, DATASET, ARTIFACT, Windows or packaged-app acceptance is claimed. The existing failure baseline, test classification, timeouts and memory guard were not relaxed.

## Reproduce

Use a short WAL-capable temporary directory outside the checkout. This machine's `/tmp` returned SQLite I/O errors, so the final validation uses a separate directory under the user's home, not the live application profile.

```sh
TMPDIR=/path/to/isolated-temp node scripts/perf-work-partial.mjs
TMPDIR=/path/to/isolated-temp pnpm -s test:work-partial-read
pnpm -s typecheck
TMPDIR=/path/to/isolated-temp pnpm -s test:all
```

The runner writes raw results and source metadata to `out/diagnostics/work-partial/`. The committed evidence captures the tested pre-commit source.
