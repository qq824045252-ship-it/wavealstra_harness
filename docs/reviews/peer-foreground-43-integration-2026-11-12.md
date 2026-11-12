# Issue 43: recipient foreground integration

## Baseline and scope

Integrated the user's local recipient-foreground implementation onto `main@d70b74aa` in an isolated checkout. The original user checkout was not reset, staged, committed, or overwritten. Only Issue 43 admission, provenance, recipient scheduling, response delivery, UI labels, and their tests were selected. Parallel dispatch, dependency patch, unrelated fixture, generated presentation, and configuration changes were excluded.

Three-way resolution deliberately preserves current main's organization discovery pagination and compare-and-swap metadata, create-to-existing retry identity, explicit user method correction, source-lineage memory revocation, and text-only Gateway result content. The organizational tests retain the new-main pagination, configuration metadata, and lost-creation-acknowledgement regression cases, adapted to foreground acceptance rather than immediate Work creation. Direct Work fixture cases are replaced by the recipient ingress behavior suite; legacy Work control and delivery remain covered.

## Behavior

A persists a request to B's normal foreground. Acceptance does not create a Work. B uses its own configuration and decides whether to answer directly or create its own single linked Work. Human original input, peer paraphrase, and return provenance remain distinct. Peer messages do not inherit primary-Bot administration or become automatic human memory evidence. A receives the result through its normal foreground. Gateway continuations retain original destinations and delivery identities, including cancellation fencing and outbox-only recovery. Work result notifications await A's actual summary and retain the existing frozen-file ledger.

## Verification on the integrated checkout

Passed: `typecheck`; `test:bot-peer-ingress` (16 behavior groups); `test:bot-organization`; `test:bot-collaboration`; `test:bot-memory`; `test:memory-correctness`; `test:google-workspace-request-scope`; `test:bot-cross-channel-contract`; `test:gateway-delivery-journal` (22 checks); `test:bot-history-context`; `test:bot-collaboration-repository`; `test:bot-work-phase5-gateway` (22 checks); `test:bot-work-phase5-delivery-dedup`; test classification audit; whitespace check.

Actual isolated Electron `test:bot-collaboration-ui` passed, including visible/accessibility peer authorship, ordinary human authorship, paging, drafts, keyboard, scroll, narrow layout, original Work navigation and timestamps. IPC data are controlled fixtures, not real model results.

The host denied native esbuild output writes. Equivalent esbuild options with `write:false` plus Node writing output files were used; original test bodies and `test-guard` were retained. Initial helper mistakes (CJS format and the distinct Gateway electron alias) were corrected and corresponding suites rerun. Integration found and restored explicit-query method feedback and the database `source_kind` migration before final passing runs.

## Evidence boundaries

The independently checked user six-type real Electron/provider run was on dirty `b7040544` with digest `28a11addd11b7004eee2a5bf3dfd786f3c8bd8ae6a72c465eec388bfa478e00d`, not this integrated revision. Its six successful cases, four Work artifacts and SHA-256 values were verified; that evidence is not relabeled as a new-main run. Its full gate was 496 passed / 13 failed. This integration does not claim a green full gate, a new six-type provider run, real external-account transport acceptance, or packaged release acceptance. Final combined regression/provider acceptance remains separate.
