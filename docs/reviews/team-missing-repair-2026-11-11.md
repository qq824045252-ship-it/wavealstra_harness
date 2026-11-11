# Completed team-member omission repair

Base: `e4acf814` on Omarchy. Implementation and validation use an isolated clone. The active checkout, its uncommitted script, production profile and Vivion are untouched. No build, packaging or deployment.

## Root cause

`WorkTeamService.ensureRecovery` excludes native `completed` executions. The final semantic review previously returned text-only missing items, which `WorkCompletionDecision` sent through a generic owner continuation. A behavior run against untouched `e4acf814` reproduced the third binding under `bot-mybuddy-default`, with no write scope and no original-member supplement. Team owners have read-only scope, so that path could not return a missed write to the original writer.

## Repair

- The review receives host-derived member targets: original binding, member identity, responsibility, intent revision, input snapshot, original scope and exact deliverable evidence. It cannot invent a teammate or acquire private memory from another team.
- Every team missing item names that exact target and quotes the registered member result. All targets validate before any mutation; stale, foreign, forged and repeated plans fail closed. Original user-request excerpts remain required.
- One durable recovery is queued per affected original member task, with only the missing items and existing outputs. The owner's scope is unchanged. Successful peers do not rerun. Failed repair retries inherit the same missing items.
- A second read-only owner summary is queued behind the repairs. If a prerequisite repair stops, queued dependent repairs are explicitly settled as not started instead of stranding the owner. Final review can report partial completion honestly.
- Cancellation, authority loss, input/ownership changes, existing in-flight work, unknown effects, and bounded repeated missing reviews retain the existing safety barriers. No approval ceremony or new permission is introduced.

## Behavioral checks

The expanded team-recovery test checks real filesystem preservation and readback, unchanged member identity/scope, original writer invoked once, untouched peer, exact missing-file supplement, owner re-summary, forged evidence rejection, atomic invalid batch, duplicate plan rejection, restart, cancellation, failed post-write supplement and sequential/parallel dependency exhaustion.

Targeted suites passing: team recovery, automatic completion, team native, team service, team access, subagent policy, team conversation, result delivery, automatic recovery, team watch, team watch evidence, phase-2 recovery, foreground contract, delegation fidelity, bot workspace, peer calls, and phase-5 end-to-end story. Typecheck and diff whitespace checks pass.

`test:bot-work-phase5-native-story` fails at the existing `must-not-write` assertion (`1 !== 0`). It fails identically in an untouched `git archive e4acf814` baseline. This is disclosed, not reclassified as passing or added to the baseline.

## Live validation

Six normal real-model types ran: CSV conversion, JSON transform, Markdown report, code/test generation, translation and multi-file manifest. All produced exact expected file bytes. Five passed all strict assertions. The CSV fixture counted only native `write` calls and rejected the sibling's legitimate single `printf` write; its failed report is retained, not relabeled as a strict pass.

The first partial CSV run exposed a genuine review-protocol failure: the model returned input-only `teamContinuationTargets` at the output top level twice, and strict parsing rejected it. No repair was incorrectly dispatched and the existing partial result was preserved. The prompt now gives the complete nested `missing[].teamTarget` example and explicitly prohibits input-only top-level fields. A schema regression preserves strict rejection.

The corrected-prompt six-type partial run passed all core repair assertions: 30 execution bindings, six completed original-member repairs and six completed read-only owner re-summaries. Each original output and untouched sibling output was written once, all expected bytes were read back, and no new approval question was created.

All six final review deliveries and conversation receipts were independently audited. CSV, JSON and code closed as succeeded. Report, translation and manifest closed as partial/ended-unsuccessfully because the loaded fixture globally prohibited extra read-only shell/byte checks; manifest also exceeded the fixture's sentence limit. These are not relabeled as six successful goals. There were no missing outputs, duplicate writes or scope expansions. The manifest's pending final review was resumed in its same isolated profile; no business task was replayed.

The saved fixture now scopes method instructions to the writing members and waits for final closure. Those later test-only edits were not loaded in this batch; the final DB/feedback audit supplies the terminal checks. An unselected Bot workspace sentinel was absent from task contexts, not a claim of complete private-memory coverage.

Machine-readable counts and file hashes: `docs/reviews/team-missing-live-summary-2026-11-11.json`. Raw diagnostics remain under `out/diagnostics/team-missing/`: `normal-live`, `partial-malformed-live`, and `live` (including terminal-audit, provider requests and per-case reports). No credentials or production profile were used.

Reproduction entry: `BOT_WORK_DEV_HEADLESS=1 node scripts/bot-frontdoor-live-test.cjs --team-missing`; append `--team-missing-partial` for the six omitted-output cases. Use a short isolated TMPDIR for Chromium sockets and canonical HOME for artifact boundaries. Model: `opendesign/deepseek-v4.1-flash` through the existing local model gateway. This validates real model/file behavior in a dev renderer, not native keyboard/desktop acceptance.
