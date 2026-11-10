# Bot Work details in the conversation viewport

Baseline: main `ed0b356`. No database, permission, execution, model or lifecycle changes.

## Interaction

- Message Work links open the existing Work details in the main conversation region, like the subagent viewer. The breadcrumb returns to the original Bot/team conversation; Close and Escape do the same.
- The conversation stays mounted. Returning restores the reading position and originating button focus. Streaming updates while inspecting a Work do not drag the hidden conversation to the bottom.
- Menu/store selection is consumed after the target Bot/team scope resolves. The Work list keeps its existing inspector entry.
- Only one details tree is mounted. Reports, saved artifact versions and diagnostics reuse the existing components; no second result report is generated.
- A selected Work remains available after completion. Missing/deleted items show a return path rather than claiming success or exposing another scope's data.

## Bug found during live acceptance

The first real-model run produced a successful team Work, but reopening it after completion reported that it was unavailable. `refreshBotWork` can be superseded by a concurrent all-scope refresh, resolving before its replacement projection is installed. Navigation previously treated that early resolution as a definitive missing item.

Navigation now waits for the actual all-scope projection, then checks request identity, Bot/team scope and conversation ID. The Electron regression explicitly resolves refresh before delivering its projection. A late response after switching teams cannot open the old Work.

## Verification

- `pnpm -s typecheck`: pass, scripts zero new errors.
- `test:bot-work-conversation-desktop`: real Electron window, pointer clicks at 1100/760/390 window widths; breadcrumb return, scroll/focus preservation, saved artifact target, live completion status, removal fallback, store/menu selection, superseded refresh, cross-team stale response and missing ID.
- `test:bot-conversation-ui`, `test:bot-workspace`: pass.
- `test:bot-work-detail-desktop`, `test:bot-report-dedup-desktop`: pass.
- `node scripts/test-all.mjs --audit`: classification passes. Full/crash-injection suites intentionally not run.
- `bot-goal-outcome-live-test.cjs`: second run passes on Omarchy, independent HOME, actual `pnpm dev` and DeepSeek V4.1 Flash transport. Team A delegated a real code-review Work, answered concurrent arithmetic, closed succeeded, delivered the 123/456 result (-333 versus 579), opened its running/final details and returned to Team A. Personal and Team B histories remained separate; team settings still usable. First run's navigation failure is recorded above, not hidden.
- Desktop fixture uses synthetic state and an artifact-open spy; the live test uses actual model/DB/preload data and CDP-driven UI. It does not claim native OS file-viewer acceptance or Windows testing.

No production instance interrupted, no packaging/version change, no crash/fault injection. Screenshots and live reports stay in local test output, not committed.
