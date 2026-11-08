# Superseded not-started action review (2026-11-08)

## Baseline and report

Based on GitHub main `bba7fd99e52bf1be1513fad9ca6eb8e6cc8c4d97`. The user's real fifth-round task met all four criteria and had an accepted result, but historical guard-denied attempts remained required `not_started` gaps and open blockers. Later safe commands did not share those rejected action identities, so continuation-only resolution could not cover them.

## Coherent lifecycle

1. A denied attempt remains a denied attempt. Its approval, original subitem, and any prior evidence are never rewritten as successful execution.
2. Once the source execution is settled, the host can prove whether a gap is exactly a terminal workspace approval that never obtained execution admission. Native planned subitems, unknown outcomes, active/claimed continuations, resource conflicts and external effects are not eligible.
3. The user explicitly selects one or more eligible attempts, a current accepted deliverable, currently satisfied criteria with later evidence, and an explanation of why this evidence covers the obsolete attempt. This is not permission to run the rejected command or a waiver of the goal.
4. A full-version-guarded user control validates the whole batch first. In one business transaction it saves independent coverage receipts, clears only the matching approval blockers, updates the projection and stores the normal idempotent control receipt. Duplicate or uncertain replies replay the original operation rather than creating new decisions.
5. Active coverage removes only that fact from unresolved gaps. The original `not_started` fact remains visible in history alongside the coverage receipt. Successful closure still checks every criterion, all other gaps, all open blockers, in-flight execution and effects.
6. Coverage is checked against the original fact, approval version, owner/input/intent, accepted result, selected evidence and artifact snapshot. If these no longer support it, the necessary gap reappears. The historical cleared blocker is not rewritten to open; the gap itself again prevents successful closure. New evidence requires a new explicit review receipt.

Existing structurally identifiable records use the same path without deleting or resetting data. There is no bulk cancellation or blanket clearing of the user's four Work records. The review control does not perform new business execution.

## UI

- The closure area displays compact expandable gaps and an explicit batch coverage control, plus the retained review history.
- The detailed execution view also collapses long rejected commands and directs eligible attempts to evidence review rather than forcing a retry.
- Mixed required environments are shown immediately with their associated criteria. The user can select an environment group and fill its exact label in one click. No model-written environment labels are silently treated as equivalent.
- External version changes still require review; the new decision is disabled for stale or uncertain snapshots.

## Verification boundary

At the user's explicit request, **no tests, typecheck, build, or GUI were run for this patch**. Only source/diff inspection and an independent static review were performed.

Regression source was added to the existing review-control and React suites for successful closure after explicit coverage, exact idempotent replay, stale/worker/invalid mixed batches, original-fact preservation, consumed/claimed/pending attempts, evidence/artifact invalidation, environment grouping, disabled unknown gaps, and UI version/uncertain-result handling. These are unexecuted cases for the user to run, not passing results.

Expected local checks, if the user chooses to run them: `pnpm -s typecheck`, `pnpm -s test:bot-work-phase5-review`, `pnpm -s test:bot-work-phase5-review-ui`, relevant approval/partial-settlement regressions and the default gate. Real-model/UI acceptance should verify that a current accepted result and later recorded evidence can explicitly cover historical rejected attempts, then close successfully without replaying those commands.
