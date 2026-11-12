# Issue #26 closure audit, 2026-11-12

Latest follow-up: [durable operation, crash recovery and seven-type real verification](issue26-operation-verification-20261112.md) on f8b22b05. The operation/status gaps below are superseded by that report; bounded cold/active history and the broader acceptance matrix remain open.

Issue #26 remains open. The implementation is useful and actual automatic compression works, but the issue's complete closing contract is larger than the repaired core flow. This matrix does not silently move mandatory requirements into another issue or turn untested cases into passes.

Audit baseline: `a31dedc22f901e82e2bcc46f914d3dfa8e1e65fb`, after preserving the UI, #21 and Bot recall work. The original issue has 14 acceptance lines. Latest main was fetched before this audit; the user's Vivion working copy was not modified.

## New complete real run

On baseline a31dedc2, the corrected live driver completed all seven types and exited zero. The strict formatting check also passed, without relying on the earlier recorded-data reinterpretation. The actual model was `opendesign/deepseek-v4.1-flash`, declared window 1,048,000, synthetic historical input 73,450 characters, 11 provider requests including one real summary call. Six outgoing requests contained the committed summary, including after cold restart. The model used actual `acp_search`, `acp_retrieve` and Bot foreground `acp_status` results.

Evidence: [latest-main assessment](evidence/issue26/real-seven-types-20261112/latest-main-assessment.json). This is actual `pnpm dev` Electron/CDP and production IPC, not physical desktop input. Earlier nonzero commands and the formatting deviation remain in [the prior report](issue26-safety-verification-20261112.md).

## Acceptance matrix

| Original requirement | Current result | Evidence or remaining work |
| --- | --- | --- |
| Default automatic maintenance | Pass for tested fixture and Flash flows | Production Runtime fixture and the seven-type real run observe an actual summary and subsequent smaller projected requests without clicking manual compression. |
| Settings across windows, changes and reopen | Partial | Durable 128K ratio/hot-settings and 1,048K real model covered. Full Durable 272K and shrink-to-smaller-model matrix remains; legacy policy arithmetic is not that evidence. |
| Single strategy and bounded fallback | Partial | Threshold decline, overflow chunking, cancellation, write failure and native-head rebase pass focused tests. Complete corrupted-state/continuous rejection/recovery and actual provider-overflow matrix is missing. |
| Tool and multimodal integrity | Partial | Real Code Mode fixture, parallel-call slots and indivisible call/result exchange checks pass. Provider-specific thinking/signature, image/attachment chains are not fully exercised. |
| Verbatim original retrieval | Pass for tested paths | Assistant refs, pagination beyond 400 entries, exact synthetic quote in a real provider tool result, including after restart. This is not a summary-only answer. |
| Revision/range consistency | Partial | Duplicate/partial coverage and cross-epoch ref safeguards exist. The follow-up adds expected view/config revision, persisted session-bound cursors, source-snapshot checks and synchronous admission. Focused stale-view/cross-store/race cases pass; broader Remote cases remain open. |
| Three crash boundaries | Follow-up tested boundaries pass | Three actual BC SIGKILL boundaries and the native-commit-before-ledger window now pass, including originals, cold status and no replay. Three real storage fault boundaries are also covered. |
| As-of and new-task branches | Focused fixtures pass | `test:durable-context-branch-cancel` covers as-of source/child and new-task reconstruction. No claim of new real-model branch runs here. |
| All execution entrypoints | Partial | Ordinary task, Bot foreground, native child, consult, auxiliary defaults and Code Mode have evidence. Team/Work compression and Remote/Gateway end-to-end context matrices are incomplete. |
| Cancel/input/reconnect | Partial | Manual cancellation and durable restart covered. Maintenance-time queued input plus Remote reconnect/stale-operation callbacks need dedicated tests. |
| Truthful recoverable status | Follow-up local paths pass | Durable operation/revision, passive closed-runtime status, live-owner handling and native commit proof now pass focused/crash checks; see the follow-up report. Remote status remains unverified. |
| Bounded long history | Not closed | Existing performance suite uses invented refs, not cold records. New real JSONL benchmark measures both native-boundary and BC-only behavior; results are reported separately below. SDK cold reopen hydrates archived JSONL into MemoryStorage, and BC-only preparation rebuilds the full active raw mapping. |
| Real model/desktop story | Pass for specified Flash/Linux path | Complete seven-type run, actual automatic summary, exact original retrieval, cold restart and continuation. Other providers/platforms are unverified. |
| Regression/documentation | Pass for recorded scope | Typecheck, affected focused tests, and one complete 486-case default headless gate passed. Separate real and dataset runs are recorded below; no packaging/ARTIFACT approval or claim. |

## Confirmed implementation gaps, not merely missing screenshots

1. **Output reserve.** Actual main replies ask the provider for `max_completion_tokens: 328000`, but the former manager guard reserved at most 16,384 tokens. The follow-up patch passes the current bound model's output ceiling into the manager, considers it when deciding maintenance pressure, and rejects an oversized protected input using output reserve plus margin. A 128K/64K-output regression fails where the former guard would have admitted the request; switching back to a 4K output ceiling is tested. This does not claim exact tokenizer/provider-payload guarantees for every API, or complete dynamic child-model coverage.
2. **Persistent maintenance operation: repaired for the tested local paths.** The follow-up adds durable session/operation identity, monotonic revision, source/config checks, same-manager admission and stale-callback protection, passive status and native-commit proof. Thirteen focused groups include four actual SIGKILL boundaries and three storage fault boundaries. A new seven-type Flash/Electron run passed functionally. See the [follow-up report](issue26-operation-verification-20261112.md) for exact scope and the separately recorded formatting deviation; Remote/Gateway coverage is still not implied.
3. **Real cold/hot split.** The SDK JSONL store replays raw records into MemoryStorage at process open. The adapter also rebuilds CoreMessage mappings by JSON-serializing the whole `conversation.context()` view on every request; normal BC projection alone does not advance a native head. Retaining fewer UI summary mirrors does not bound the kernel's entire ref/block graph. An indexed cold-original store plus incremental model-view cursor/checkpoint (or a version-pinned minimal SDK change with equivalent semantics) is required. Do not delete raw history or create a second execution scheduler to obtain better timings.
4. **Controlled benefit and scope matrix.** Run native-versus-BC with the same workload/model and documented cache conditions, recording preparation/TTFT, memory, archive/restart, all summary/retrieval usage and available prices. A successful seven-type run is not this comparison. Complete the missing model/provider/entrypoint/Remote cases and preserve unknown pricing as unknown.

The output-budget, archive-measurement and durable operation/recovery stages are now recorded. The next executable sequence is to make the active-view/cold-original path incremental, run the cross-entrypoint and controlled native/BC comparison, and then re-evaluate all 14 rows. Closing #26 before those mandatory rows are satisfied would contradict its stated completion definition.

## Actual 1K / 10K / 100K cold-store results

Executed on `dc31dd893b8f452fdffb318874e8949e83d1e6eb`, after the output-reserve repair, in 43 seconds with no competing test batch. All three real archive sizes and all five process-cold samples per size completed. The test command exited zero for correctness and bounded native-head request/retrieval checks; the explicit report flag `longHistoryColdStoreBounded` is **false**. Exit zero is not a pass for requirement D.

| Real original entries | Reopen p50 / p95 ms | First-provider preparation p50 / p95 ms | Warm manager p50 / p95 ms | Retained heap delta p50 | Measured probe peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 47.67 / 49.05 | 64.18 / 71.38 | 8.13 / 10.44 | 1.65 MiB | 199.22 MiB |
| 10,000 | 124.34 / 129.98 | 69.13 / 71.97 | 6.97 / 9.84 | 9.30 MiB | 205.51 MiB |
| 100,000 | 886.84 / 957.68 | 78.21 / 88.14 | 7.71 / 9.60 | 81.29 MiB | 433.48 MiB |

SDK cold recovery actually replayed 1,004 / 10,004 / 100,004 entries. Main JSONL sizes were 557,825 / 4,825,855 / 48,045,885 bytes; current state was 26,205 / 27,069 / 27,933 bytes. The bounded-head corpus uses production history import: 200 active messages share one context-import entry. Requests return no archived-original entries after that head. Forty-five exact original retrieval checks passed, each using 19 pages of at most 512 characters, one point read per page, no archive scans.

The BC-only control does not pre-establish that native head. At 1K, nine fixture summaries reduced provider-visible messages from 1,000 to 935, 842 and 749, while each warm preparation still read all 1,000 originals. At 10K, every warm round still read all 10,000 originals, state grew to 1,134,124 bytes, and the imported backlog was rejected safely at 517,943 estimated tokens versus a 114,176 safe input ceiling. This is a cold-import diagnostic, not a claim that every gradually accumulated conversation fails. It does disprove bounded preparation for this supported history shape.

Evidence: [full published report](evidence/issue26/real-seven-types-20261112/cold-store-full.json). The original report hash is included; only its temporary-root path was omitted. OS page cache was not evicted. Reopen timings exclude Node/module startup. Peak RSS is the measured probe-process high-water mark, not an aggregate seed-process peak. Five samples give descriptive nearest-rank p95, not a precise statistical tail estimate. Provider replies in this storage benchmark are fixtures, not the real Flash run above.

Reproduce explicitly, not on every edit:

```sh
TMPDIR=<private-short-temporary-directory> COLD_CONTEXT_KEEP=1 GUARD_TIMEOUT_S=180 pnpm -s test:durable-context-cold-store
```

The full generated corpus is classified DATASET rather than the normal headless gate. `COLD_CONTEXT_SCALES`, `COLD_CONTEXT_SAMPLES` and `COLD_CONTEXT_BC_SCALES` may shorten a smoke run, but a shortened run must not be presented as the full evidence above.

## Post-repair real run and final regression

The actual-model output-reserve fix is `f65736d7a3bf38f19ccd88c848ffe359628bba3e`. With the cold-store test registered, the frozen source `dc31dd893b8f452fdffb318874e8949e83d1e6eb` completed another full seven-type real Flash/Electron run starting 03:32:06 UTC. The command exited zero; strict correction formatting passed as well. All seven answers and exact-original/Bot-tool checks passed, with 11 real provider requests, one summary call and six requests carrying the committed compressed view. [Post-repair assessment](evidence/issue26/real-seven-types-20261112/output-reserve-assessment.json) includes source SHA and raw-record hashes. The only tracked working-tree changes during this run were documentation.

The original prior failures remain documented; neither of these later genuine zero-exit runs rewrites them. No build or packaging was performed: Electron was launched through `pnpm dev`.

Final web/main/script typecheck passed, with zero script ratchet errors. One complete default headless gate on frozen source dc31dd89 completed at 03:46:40 UTC: **486 passed, zero failed, zero known failures, zero new regressions**, in 7.1 minutes (`TEST_ALL_JOBS=2`, private TMPDIR). [Gate summary and original log hash](evidence/issue26/real-seven-types-20261112/final-headless.json). The explicit large-archive dataset and actual seven-type real run above are separate evidence; no full GUI/NETWORK or ARTIFACT suite is implied. No failure baseline was relaxed.

This completes this repair/measurement batch, not the unresolved implementation rows above. Continue with the persisted maintenance identity/outcome and incremental history path before closing #26.
