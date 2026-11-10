# Bot watch real-clock follow-up acceptance — 2026-11-10

## Scope and environment

- Baseline: `main@b9d7288`; Omarchy Linux, `pnpm dev`, isolated clone and temporary HOME. Production profile and existing watches were not modified.
- Real provider: local Magpie gateway, `opendesign/deepseek-v4.1-flash`. Requests were recorded by the existing transparent live harness, not mocked.
- Entry: real Bot composer via Electron CDP. This verifies the running application and native backend, not physical mouse input.
- Command: `env -u ELECTRON_RUN_AS_NODE pnpm -s test:bot-frontdoor:live --watch-followup`.
- No fake clock, forced scheduler execution, crash injection, or database mutation.

## Observed result: PASS

The user instruction requested a watch every UTC minute, no immediate run, real read of a temporary source file, a report on **every** round including unchanged content, and continuation until paused/canceled.

| Actual slot (UTC) | Observation | Return and lifecycle |
| --- | --- | --- |
| 11:44 | `WAITING_706a23169e54` | One result in original conversation; active; next wake persisted |
| 11:45 | `READY_706a23169e54`, after harness changed the external source | One result in original conversation; active; next wake persisted |
| 11:46 | Same READY content | One result, as explicitly requested for unchanged content; still active |

Work: `work-bb6a7f32-6187-4112-af10-a55363bb66ae`. Three distinct execution bindings and inbox events were observed. Each completed execution had exactly one result message; status/progress records were not counted as result duplicates.

After the third result, a natural-language pause was sent through the same composer. The watch became paused. A real 70-second wait, crossing the next minute slot, produced no new execution. Source contents remained unchanged by the Bot.

1280px and 390px screenshots were inspected: title/result/pause reply readable, no horizontal overflow. This is a bounded viewport check, not an exhaustive UI audit.

## Evidence and checks

- `out/diagnostics/bot-watch-followup/live/report.json`: schedule, bindings, result messages, timestamps, paused final state.
- Same directory: `watch-followup-1280.png`, `watch-followup-390.png`, provider trace, dev log. Generated traces remain local rather than committing full prompts/profile data.
- Live command exited 0, report status `passed`.
- `pnpm -s typecheck`: passed, scripts 0 new errors.
- Syntax and diff whitespace checks passed.

## Limitations / follow-up

This run proves minute scheduling, continuation beyond the first round, real reads, changed and unchanged per-round reports, original-conversation delivery, per-execution result deduplication, and pause. It does **not** prove changes-only delivery, external-event subscriptions, team watches, long outages/catch-up, long-duration reliability, restart recovery, crash recovery, or repair of old production watches. No claim is made that existing production watches have automatically recovered.

The model attempted optional date/stat corroboration during one round and reported that those calls were denied; the requested real file read succeeded. Reported check time is the scheduled UTC slot, not a claimed exact filesystem read timestamp.

Only reusable acceptance coverage and this report were added; no product logic was changed.
