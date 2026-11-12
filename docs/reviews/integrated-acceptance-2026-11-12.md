# Integrated acceptance follow-up (2026-11-12)

## Fixed baseline and first full run

The clean independent baseline was `5de5ddf060f32965a59d56129e654ba4dd7eec58`, including Issues 29–32 and 37–39. The user checkout was not reset, stashed, or modified. Default headless gate ran 510 selected tests in 7.4 minutes: 493 passed, 17 failed, zero baseline allowances. Two Linux-only entries were excluded on Windows. GUI, remote-account, dataset and product-artifact categories are not implied by this result. All selected serial performance cases passed.

## Corrections before the final acceptance run

- Production UI automation: renderer DOM lookup previously awaited executeJavaScript without cancellation or a deadline. A stalled lookup prevented scroll cancellation from settling. The shared deadline/AbortSignal boundary now rejects the caller, ignores late lookup settlement, and checks the surface before further input dispatch. It does not kill user windows or claim to reverse already-dispatched native input. Six controlled behavior groups and existing recovery checks pass; the previous implementation fails the cancellation bound.
- Production module structure: move Work file identity/manifest helpers below both components, removing the BotWorkResult/WorkFilePreview runtime cycle without changing rendering behavior.
- Production startup: restore credential platform initialization as the first main import, preserving the existing startup invariant.
- Headless fixtures: five component scripts use the existing explicit Monaco worker stub rather than feeding Vite worker syntax to plain esbuild. The workflow startup AST test selects the actual app.whenReady callback instead of later UI helper functions.
- Current-schema contract: incompatible database tests now verify the documented discard-without-backup behavior, not the retired backup migration path.
- Windows fixture corrections: native PATH/executable naming; JSON-escaped path evidence; explicit database close before fixture removal; actual Windows owned-child exit code rather than a POSIX signal; HOME and USERPROFILE isolation; bounded corrupt-session OOM recognition with matching stderr.
- Environment: test-bundle-pool and durable-storage-lease first failed because esbuild was denied writes to the system temporary directory. Final runs use a writable isolated TEMP/TMP. No production security setting or baseline is changed.

Web, node and scripts TypeScript checks pass with zero script errors. Full-suite and real-model acceptance statuses must be read from their final run reports, not inferred from these targeted fixes. The six distinct real Electron/model tasks use v4.1flash and remain separately reported. No product build/package or cloud Codex execution is involved.

All 17 original failing entries and the new cancellation entry passed targeted reruns. The lease test retains real eight-process contention and SIGKILL recovery; invalid database bytes remain preserved and rejected, not mistaken for a known old schema. Final script typecheck again reports zero errors.

Second full run (65ed3fcf): 503 passed / 8 failed, exit 1. Relocating TEMP inside a repository invalidated Git-free and parallel-subagent fixture assumptions by inheriting ancestor AGENTS; this is not a passing run. Final acceptance restores the system TEMP and gives the execution checkout its own Git identity. The two esbuild fixture tests write returned buffers through Node, without modifying product build behavior. Performance fixture database handles now close in finally so cleanup does not mask errors.
An additional strict MYBUDDY_PERF_GATE=1 probe on Windows measured cold database schema p95 209.49 ms against 100 ms; all other metric budgets and RSS passed. Default test:all does not enable this strict switch. This measured budget failure is retained, not hidden or fixed by widening a threshold.
