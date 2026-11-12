# Memory issues 40–42 integration review (2026-11-12)

## Scope and source

Integrated only memory changes for #40, #41 and #42 from a hash-verified local snapshot (source HEAD b7040544). The user's original working directory was not changed. The integration uses an independent main checkout and preserves upstream changes. Unrelated in-progress peer-memory changes for #43 were excluded.

## Changes

- #40: one instruction document distinguishes executable requests, negations, questions and reference material. Capture, explicit deletion and write-evidence checks share the same authority. Inline/multiline quotes and comma-separated questions cannot authorize deletion. A separate command after reference termination remains executable, including possessive apostrophes inside quoted examples.
- #41: targeted deletion stores content/source-aware suppression rather than advancing an entire scope watermark. Existing coarse legacy watermarks remain conservative; no automatic resurrection of historical data. Tests cover unrelated facts, same-source facts, generic titles, delayed extraction and reopen.
- #42: search operates over the full eligible scope before ranking/output bounds, using paged SQLite candidates and async yielding. Final hydration also yields. Bounded per-query text caches avoid duplicate normalization/scoring; state, hash, expiry and scope are revalidated and never cached as authorization.

## Verification

Typecheck passed before integration with newer main. The focused correctness entry passed all 13 groups, including actual capture and SQLite storage.

The initial ordinary memory gate did not execute assertions: Windows esbuild output writes returned Access denied. Verification therefore used the repository's command parser and exact build options with esbuild write:false, wrote the returned bundles with Node into the isolated output directory, and ran the original test-guard commands. No security settings or product test assertions were changed. The ordinary gate must not be described as passing.

Performance investigation retained failures rather than lowering budgets. The pre-optimization 10K-vector batch failed 7/10 cases (event loop maximum 94.44ms); an intermediate batch still had a 1504.3ms query failure. Two subsequent complete isolated batches passed 10/10 each, maximum query 1206.29ms / 961.74ms and event-loop delay 41.16ms / 20.20ms. Budgets remained query1500ms, event-loop50ms and RSS256MiB. The fixture stores 10,000 1024-dimensional vectors, 30,000 scope bindings and long filler text in SQLite. Embedding generation is controlled, not a live provider benchmark.

## Boundaries

No full repository regression, product build/package, real embedding provider, real-model batch or Electron desktop acceptance was performed in this change. Focused logical/performance checks do not substitute for those acceptance layers. Real-model verification belongs to the coordinated batch of at least six different task types. Do not close issues solely on the basis of a commit or mock-provider tests.

Integrated checkout verification: all 27 selected memory/history/schema entries passed through the equivalent build-and-original-guard runner. The integrated 10K-vector batch passed all 10 samples: maximum query 1352.61ms, event-loop delay 35.69ms, RSS growth 137932800 bytes. No budgets were relaxed.

After rebasing onto a4a42e1d (including #44/#45 and QQ upstream fixes), typecheck, memory-correctness, db-schema-discard, bot-memory-forget-watermark and test classification audit passed again. Diff whitespace check passed.
