# Bot history image hydration: reduce redundant host reads

Date: 2026-11-11. Baseline: `3a892555a1105024d026d1c80f204fdd6b6e6591`.

## Outcome and scope

This is a small reduction in synchronous main-process work, **not a claim that long-history initial rendering is fixed**. The renderer, scrolling, history page size, message ordering, Work state, and all image authorization/file checks are unchanged. No scheduler/recovery (#27), Vivion, live profile, model, or provider was touched.

The image hydration pass formerly called the full message mapper for every already-loaded history row. A plain 100-row history therefore performed another 700 SQL executions to discover that none had host feedback. A specialized repository read now selects only current assistant rows joined to host feedback before using the original mapper. Ordinary rows still get a fresh database check; this is not a cache or a decision based on stale renderer DTOs. Qualifying feedback still uses the complete original mapper and image service path.

## Paired real-Electron measurement

The committed scripts use a synthetic disk-backed 10,000-message database per scenario, actual `BotConversationService.history`, `BotReportImageService.hydrateHistory`, IPC, store refresh and `BotWorkspacePage`. Both variants share the same database, Work, execution binding, artifacts and renderer. Baseline host source is loaded from the commit above. Production React is used. The runner refuses to compare unrelated production changes against that baseline.

Eight alternating AB/BA measured pairs per scenario follow two host warm-up pairs and one UI warm-up pair. Each request returns the actual bounded 100-row page. Mixed history includes 75 ordinary rows, 15 valid no-image feedback rows and 10 feedback rows with real, tiny PNG files. SQL counters and timing instrumentation add overhead; results compare equivalent instrumented paths.

Median milliseconds:

| Measurement | Ordinary baseline → candidate | Mixed baseline → candidate |
| --- | ---: | ---: |
| Isolated history + hydration host wall time | 24.59 → 13.79 (−43.9%) | 31.34 → 24.90 (−20.5%) |
| Image hydration wall time | 14.00 → 3.63 | 20.93 → 14.57 |
| Main-process CPU, user + system | 26.18 → 14.24 | 35.20 → 25.36 |
| Hydration SQL executions | 700 → 100 | 825 → 400 |
| Actual UI refresh through two animation frames | 186.50 → 182.95 (−1.9%) | 205.10 → 191.40 (−6.7%) |

Ordinary UI timing was slower in 3 of 8 candidate pairs, mixed in 1 of 8. **The ordinary first-page improvement is small and not reliably demonstrated by this sample.** Host savings are reproducible, but renderer/layout/frame work still dominates end-to-end latency. The UI and isolated host runs are separate workloads; their timings must not be mixed. CPU measurements are whole main-process `process.cpuUsage`, not thread-specific CPU profiling.

History mapping itself remains 604 SQL executions per page. The candidate-only first image capture measured 37.30 ms host / 25.51 ms hydration in the mixed scenario; there is no paired cold-capture speedup claim. These tiny PNGs do not characterize large-photo filesystem/encoding cost. The benchmark does not measure product startup, model latency or 1,000-row initial-mount performance.

## Functional and security equivalence

- 20 complete host DTO pairs and 18 renderer/store DTO pairs matched, including absence versus empty versus populated `reportImages`.
- Actual paging clicks made ten bounded requests and accumulated 1,000 messages. Complete baseline/candidate store values matched. Scrolling was exercised.
- Ten thumbnails decoded through the actual artifact protocol. Original-image preview opened, decoded and closed. Renderer errors and warnings were both zero.
- New regression assertions cover a stale ordinary DTO after feedback is added, fresh database body versus stale supplied body, valid empty image scope, current Work ownership revocation even after capture, retry of a previously missing file, and removed feedback despite a stale advertised DTO.
- The specialized reader equals the original full mapper for every eligible fixture row and returns no row for ineligible or missing IDs.
- Existing exact binding, bot/conversation/user ownership, immutable artifact recovery, canonical-path, unsafe path, symlink, FIFO and concurrent-capture checks remain in place. There is no negative cache or weakened authorization shortcut.
- Independent static review found no blocking issue. The existing synchronous same-database execution model is retained; no new transaction or asynchronous I/O design is introduced.

## Validation at this candidate

Passed `pnpm -s typecheck` (web, node and scripts), `git diff --check`, runner syntax check and classification audit.

Focused tests passed: `bot-report-images`, `bot-report-images-ui`, `bot-history-context`, `bot-history-paging`, `bot-history-paging-sqlite`, `bot-history-query`, `bot-conversation-ui`, `bot-work-phase5-review`, and `bot-work-phase5-review-ui`.

Real Electron `bot-history-paging-desktop` passed personal/team pagination, concurrent append, scroll anchor, focus, late growth, resize and latest/EOF checks. Real Electron `bot-work-conversation-desktop` passed navigation, identity, isolation, responsive widths, scroll/focus restoration, artifact target and live Work status checks.

Full default headless regression for the published candidate is delegated to independent verification after push; the previous commit's 476/476 result is not claimed for this patch. No full product build, package, Windows, provider/network, full GUI suite or cloud CI result is claimed.

## Reproduce and evidence

Run at this patch's commit (or unchanged production dependencies) in the isolated clone:

```sh
TMPDIR=/home/vivion env -u ELECTRON_RUN_AS_NODE pnpm exec electron scripts/perf-bot-history-load.cjs --baseline=3a892555a1105024d026d1c80f204fdd6b6e6591 --samples=8
```

The adjacent JSON preserves source hashes, the exact candidate diff, environment, all raw samples, parity checks and measurements. It was captured before commit, so `sources.head` is the baseline and `sources.candidate` identifies the tested working files. Generated screenshots and runtime logs stay under `out/diagnostics/history-load-ab-final`; no private data is included.

The next substantial initial-load improvement would require separate renderer and history-mapping evidence. This change intentionally stops at the measured, small, behavior-equivalent host optimization.
