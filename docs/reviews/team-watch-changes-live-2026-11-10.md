# Team watch changes-only: real model acceptance

## Baseline and defect

Tested main `2a2512f` plus the fix in this change, in the independent Omarchy `team-watch-lab` clone and a new temporary HOME. No production database, X account, system/network setting or crash injection was used. The online model was `opendesign/deepseek-v4.1-flash-eco`, reached through the existing local model service. Electron `pnpm dev` rendered the actual Bot UI; CDP submitted the user prompts and inspected the resulting UI/history. This is a headless renderer test, **not** native pointer/keyboard or packaged application acceptance.

The real model exposed contradictory owner output contracts: `TEAM_REPORT_FORMAT` requested `bot-team-report-v1`, while a changes-only tick also required `watch-observation-v1`. In the failing run the owner mixed `requestMessageId`/`evidenceRefs` into observation JSON, and another cycle used the ordinary team report entirely. Strict observation parsing then correctly refused to infer equality, but the baseline was visibly reported instead of being silent.

The fix selects **one observation contract** for the changes-only watch owner. Ordinary once/every-check team reports remain unchanged. Raw native source receipt comparisons, unavailable-source handling and strict JSON parsing are not relaxed. Existing historical execution inputs are not rewritten. An already-prepared pre-upgrade owner input may retain its old contract until a new cycle/recovery prepares input.

## Real task result (successful run)

- One member reads a temporary file; one team owner combines the current member result. A real frontend model supervises each cycle.
- Natural-language admission persisted `changes_only`, `notifyInitial=false`, `* * * * *`, `UTC`.
- Cycle 1: baseline established, **0** frontend reports.
- Cycle 2: identical source, **0** reports.
- Cycle 3: the fixture changes the file to a new random marker, **1** owner report containing the new marker.
- Cycle 4: source unchanged, cumulative report count remains **1**.
- Natural-language pause, then **65 seconds of actual time** with no new execution binding.
- Natural-language resume; cycle 5 unchanged, cumulative count remains **1**.
- The fixture renames the source out of the tracked path. Cycle 6 owner obtains a real `ENOENT`, rejects the earlier member content as unavailable for the current comparison, and sends **one visible error** instead of treating it as unchanged. Total reports: **2** (one change + one error).
- Final pause succeeds. A seventh member already admitted during the slow cycle is honestly `stopped`; it is not counted as a successful observation.
- The Work remains `paused`, not falsely closed/succeeded.

Successful isolated Work: `work-30944339-ba26-4af6-9648-0871e6476fb7`.

## Evidence and verification

Run: `BOT_WORK_DEV_HEADLESS=1 BOT_FRONTDOOR_MODEL=opendesign/deepseek-v4.1-flash-eco pnpm -s test:bot-frontdoor:live --team-watch-changes`.

Artifacts: `out/diagnostics/bot-team-watch-changes/live/report.json`, provider request transcript, dev log, and 1280/390 px screenshots. Screenshots inspected: pause and missing-file explanation are readable, controls remain visible, no document horizontal overflow. Desktop native input is not covered.

The fixture waits for durable `work_watch_reviews` terminal state, not an assumed model latency. An initial fixture checked 7 seconds after execution and falsely failed while supervision was still pending; that was corrected before the successful run. Observation cycles may overlap frontend review; changed-source delivery is awaited by content and actual settled reviews, not an assumed cycle number.

Passed:
- `pnpm -s typecheck` (scripts: 0 new errors).
- `test:bot-work-team-watch`, including actual dispatched input assertions for exclusive observation format and unchanged every-check report format.
- `test:work-team-watch-evidence` (raw member receipts, missing/partial/cross-round/source mismatch rejection).
- `test:work-watch-goal` (31 checks).
- `test:work-watch-supervision` (persistent review/delivery, ordering, visible failure fallback).
- Real six-cycle scenario above.

Not claimed: 365-day soak, crash recovery, upstream API availability guarantee, production upgrade, multi-member matrix, all languages/timezones, or native desktop clicks. No full aggregate crash/fault suite was run. A previous model run chose Asia/Shanghai despite UTC wording; every-minute slots coincide, but only the final successful UTC run is accepted as exact schedule evidence here.
