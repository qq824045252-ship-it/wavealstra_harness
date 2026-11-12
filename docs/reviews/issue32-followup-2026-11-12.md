# Issue 32 follow-up

Initial base: `56604474`; final integration base: `6b3f897e` (includes Issues 29–31 and 37–39). Changes and tests are in an independent Git archive; the live user checkout is not reset, stashed, or overwritten.

## Discovery

`discover` previously silently limited the directory to the oldest 100 Bots. It now pages by stable Bot ID, exposes `totalBots` and `nextBotId`, accepts `afterBotId`, and explicitly identifies incomplete reads. A production-service regression constructs 105 targets and verifies all are reachable exactly once without creating any Work.

## Historical live failures

The prior 2026-11-12T08:04:06.706Z six-scenario report is **failed**, not acceptance. C counted an honest unknown-result fallback and a subsequent completed correction as duplicate successful delivery. The fixture now requires exactly one completed final result, unique operation identities, and non-successful earlier messages to precede it. No historical record or expectation of one execution is removed.

D contained a hanging optional browser scroll during revision; F had a completed native result but the host binding still running. The serial binding pump could wait on D's stop and prevent F's observation. A new SQLite-backed regression failed before the adapter change and passed afterwards: an existing sibling and a later admitted Work both complete while the original stop remains pending, with one stop call and one result per sibling. The fix keeps revisions of a single Work ordered; it does not force-complete or replay the blocked operation. The UI tool cancellation itself is not claimed fixed. E's native execution succeeded but result review timed out twice, distinct from personal Bot ownership. The user checkout has separate Issue 37–39 work; this follow-up does not overwrite it.

## Verification

Organization behavior suite: 18 checkpoints passed, exit 0. Node typecheck passed; script typecheck reports 0 errors. Full live acceptance remains pending and this document is not a claim that Issue 32 can close.

## Deferred integrated acceptance

At the user's instruction, full regression and the six real task categories are deferred until the related Issues are all integrated. The first local startup attempt failed before model traffic because the driver imported renderer code before navigation committed. The driver now waits for a committed HTTP renderer and claims owned-process cleanup identity before this wait. The next attempt is retained as interrupted, not passed. Scenario A exposed a valid create/configure then separate delegate sequence: the fixture now resolves only exact persisted source Bot, source conversation, request and target identities and records separate acceptance evidence without changing the host organization phase.

The pending model run was stopped using only its verified unique bootstrap/owned process identities. No user application was stopped. The earlier E result-review timeout is being handled by the separately integrated Issues 37–39 and must be checked in the later combined real run.

Additional focused verification: native Work execution, phase3 pause/backlog, phase3 handoff, node/web TypeScript checks, script TypeScript checks and test-category audit passed. No full-suite or six-scene green claim is made.
