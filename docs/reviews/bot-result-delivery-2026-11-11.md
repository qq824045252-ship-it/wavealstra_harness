# Bot result delivery: user goal, usable artifacts, honest gaps

## Delivery contract

The foreground must review what the user ultimately asked for, then deliver a concise answer and the latest usable registered outputs. It must not move a worker's detailed report into the foreground or equate a finished execution with a completed user goal.

- A persisted foreground completion review takes precedence over structured worker conclusions. Outcome and next action distinguish completion, partial delivery, unknown verification, follow-up work, and required user input.
- The review sees only files proven to belong to this Work's current results, its frozen team inputs, or a validated continuation source. It can select primary artifact references only from that supplied list.
- File actions use host-registered immutable snapshots. The latest referenced snapshot for each canonical output path wins within this proven lineage. Earlier snapshots remain intact in history. No directory scan, guessed path, unrelated history, or unproven reference becomes a file action.
- The frontdoor presents the reviewed conclusion, necessary gaps, and primary file actions. Execution facts, source limitations, paths/version details, and the original report remain available in collapsed details.
- If review fails, the foreground explicitly says that goal completion is unverified. Registered files and the raw report remain accessible; diagnostics are secondary. The original business task is not rerun by that fallback.

The normal-mode artifact-opening mechanism was inspected. This delivery continues to use the existing Electron file-open IPC, but passes exact registered snapshot paths rather than resolving an arbitrary displayed filename.

## Focused automated checks

Passed on the final fallback changes:

- `pnpm -s typecheck`
- `pnpm -s test:bot-result-delivery`
- `pnpm -s test:bot-workspace`
- `pnpm -s test:bot-work-automatic-completion`
- `pnpm -s test:work-conversation-feedback`
- `node scripts/test-all.mjs --audit`
- `git diff --check`

Real Electron component checks also passed: `test:bot-work-delivery-desktop` and `test:bot-report-dedup-desktop`, including narrow layouts, repeated disclosures, preserved source text, and registered file actions. The final fallback-only change does not alter renderer code.

Boundary regressions cover exact Work/team/continuation ownership, cross-Work and stale-continuation rejection, latest referenced snapshots, unregistered-reference handling, reviewed-summary precedence, source-notice retention, and honest review-failure fallback.

## Six distinct real-model tasks

The live run used an isolated temporary MyBuddy profile, real `pnpm dev`/Electron and 62 genuine provider requests to `opendesign/deepseek-v4.1-flash`. The actual gateway supplied its model capabilities; requests used `max_completion_tokens=328000` and did not specify `reasoning_effort`. No fabricated model responses or live fault injection were used.

1. HTML water-cycle talk: a real `talk.html` was generated, registered and delivered. Its final summary distinguished an estimated two-minute duration from human timing. The selected snapshot matched its registered digest and actual review input.
2. CSV analysis: correct total revenue 118 and top product Coffee, 50; registered `sales-summary.csv` opened.
3. Text explanation: condensation was explained directly without inventing a file.
4. Team delivery: a member genuinely wrote `packing.md` with WATER-1L and then edited it to WATER-2L, plus a separate `schedule.csv`; the owner only summarized. The foreground selected the newer packing snapshot and both actual file actions worked.
5. Missing personal facts: no invented passport expiry or travel facts; missing inputs were requested and no artifact was claimed.
6. Read-only code review: inspected `average.js`, identified the empty-array `0/0` → `NaN` behavior, and proposed a fix without modifying the source.

### Timing caveat and reconciliation

The final live suite exited **1**, solely because HTML exceeded the inherited 240-second display wait. The same Work later completed normally; it was not cancelled or resubmitted. All five original execution bindings were completed before shutdown. The other five cases passed in the live UI.

A separate fresh-profile Electron check replayed the HTML task's actual persisted final-result DTO, verified its registered snapshot digest and that its primary ref came from the real review's `availableFiles`, and exercised the visible open button. It passed with **zero additional model calls**. This is six-task behavioral verification, not a claim that the original automated suite was green or that a second six-task model suite was run.

The final fallback-only patch followed that live run and passed the focused checks above. Its error branch is unit-tested, not claimed as live failure-injection coverage. Live tasks had empty `sourceNotices`; retention of nonempty notices is also unit coverage.

## Evidence and limits

Local, uncommitted diagnostic evidence is under `out/diagnostics/bot-result-delivery/`:

- `VERIFICATION.md`: detailed acceptance report.
- `live/report.json`: original live-suite result, including the HTML timeout.
- `live/multiple-deliverables.png`: actual team final delivery.
- `recheck/report.json` and `recheck/html-talk-after-timeout.png`: same-task HTML reconciliation.

The narrow screenshot is layout evidence after viewport reflow, not specifically the team result. Actual Electron file-open calls succeeded; independent native viewer rendering was not exhaustively tested. No OS pointer/keyboard automation, full `test:all`, packaging or production build is claimed.

Work was done in an independent clone. The user's production database and the protected `diagrams/`, `docs/talk/`, `generated/`, and `演示/` directories were not modified. Concurrent main changes were retained through rebase.
