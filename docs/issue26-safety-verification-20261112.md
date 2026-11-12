# Issue #26: context-management safety repair and verification

This is a follow-up to the existing billion-context adapter, not a claim that every acceptance item in issue #26 is complete.

Later closure audit: the corrected driver completed a new seven-type real Flash/Electron run with exit code zero and strict formatting passing. See [the current 14-item closure matrix](issue26-closure-matrix-20261112.md) for the newer evidence, output-reserve fix and remaining architectural requirements. The two original nonzero command results below are retained as historical evidence.

## Repaired behavior

- Admit the four registered context tools through the Bot foreground tool policy, which previously filtered them all out. Arbitrary `acp_*` names are not allowed.

- Parse Durable assistant message IDs including `.t` text and `.cN` call slots, so original assistant text is retrievable by ref.
- Propagate durable-state write failures and restore the last committed state. A failed write cannot publish a successful summary or leave its coverage active in memory.
- Bound each summary request even when the entire range is represented as one giant user message. Split by the estimator, preserve Unicode, and bound iterative summary merging.
- Preserve ref and block allocation across native context-head changes. Reject already ambiguous legacy refs rather than select an arbitrary epoch. Previously committed block originals remain retrievable after a rebase.
- Return continuation information for original search. The first 400 scanned records are a page, not a claim that the older archive contains no matches.
- Retrieve originals lazily with a character limit and at most 16 entry loads per call. Cursors bind to the requested target. This bounds entry count, not the memory needed to deserialize one inherently huge Durable entry.
- Reject oversized protected input instead of sending it unchanged after a maintenance failure.
- Reject partial coverage of a provider message or tool call/result exchange, detect zero-gain summaries, and keep the cancellation signal until the maintenance operation actually settles.

## Reproducible checks

- `pnpm -s test:durable-context-safety`: eight production-manager/tool behavior groups with fault-injected transaction storage. No network.
- `pnpm -s test:durable-context-management`: actual Durable runtime, temporary JSONL storage, recording provider fixture.
- `pnpm -s test:durable-context-branch-cancel`: as-of branches, cancellation, runtime entrypoints and settings.
- `pnpm -s test:durable-context-performance`: existing synthetic active/archive-size comparison. This is not a real 100K-entry cold-store benchmark.
- `pnpm -s typecheck`.
- `pnpm -s test:durable-context-dev:live`: opt-in actual `pnpm dev` Electron session with an isolated temporary profile, synthetic inputs and transparent recording transport to an available real model. It exercises six task types: log diagnosis, arithmetic, translation, JSON extraction, instruction correction and verbatim original retrieval after a cold restart. An additional Bot foreground status-tool case verifies its real allow-list. It must observe actual summarizer calls and a subsequent provider request containing the compressed view. No production profile or credential files are copied. It belongs to NETWORK, not default headless.

## Verification results

Initial base: `b5c1429d77d2d2f192149c48a92990cca8f4926c`, isolated main clone on Omarchy.

Passed so far:

- Safety suite: all eight groups, including additional parallel-call-slot and atomic-exchange assertions.
- Durable context management: actual fixture-provider input reduced from approximately 89,931 to 30,131 tokens; original tool retrieval, persistent projection, settings and restart assertions passed.
- Branch/cancel suite: as-of branch, cancellation, bounded overflow summary requests (five calls, largest estimated input 20,786 tokens), native child, Code Mode, consultation, settings and engine-switch assertions passed.
- Existing synthetic performance fixture passed. It ran alongside unrelated UI work, so its timings are not an isolated performance baseline.
- Web and main-process typechecks passed. Script ratchet initially caught one branded-entry-ID type in the new fixture; it was corrected and the script ratchet passed. The additional parallel-tool fixture also passed the final script ratchet recheck.
- Test classification audit passed; live driver/scenario syntax checks passed without launching a model.

The first storage integration attempt failed because host `/tmp` rejected its lease-file write with errno -122. The unchanged test passed with a private `TMPDIR` under the selected computer's home directory; no product error handling or assertion was relaxed.

## Actual Electron and V4.1Flash runs

Two isolated `pnpm dev` desktop-session runs completed all seven task types on 2026-11-12, using `opendesign/deepseek-v4.1-flash` from the existing local gateway. The input history is entirely synthetic. The harness uses actual Electron UI/CDP and production IPC, not physical desktop input. No user profile or credential was copied.

- First run started 02:20:06 UTC on `22931cb439efae3830fbb646204b7f3a9943a432`: seven content/tool assertions passed, 11 real provider requests. The live command nevertheless exited nonzero because its final summary detector only accepted a `system` role; this provider correctly serialized the instruction as `developer`. Raw request 2 is the actual summary call, and six subsequent requests contain the committed compressed view.
- Second run started 02:24:01 UTC on `5964ad88c6bfa8acd17981e3cbcb56665d7b8bc1`: seven real answers, 11 requests, one actual summary request and six requests using the committed summary. Original retrieval after a cold restart and Bot foreground `acp_status` both passed. The command exited nonzero on the correction case: the model correctly wrote `const PORT = 6284`, then added “6173 已废弃”. This is an extra-formatting deviation, not use of the obsolete port. The old assertion prohibited the old digits anywhere.
- Both original failed command results are preserved. A separate recorded-data assessment verifies seven functional behaviors, exact original text in an actual provider tool message, actual summary traffic, and compressed projection after restart. It separately reports strict formatting: first run passed; second run deviated. This is offline revalidation, not a third live run and not a claim that either original live command exited zero.
- The current driver recognizes provider-normalized `developer` summaries and checks actual constant assignments while recording whether the response contains only the requested constant. Its checker rejects old, conflicting, and missing declarations. The corrected driver has been syntax checked and its assessment behavior tested, but has not received another complete live execution.

Compact reproducible evidence: [first assessment](evidence/issue26/real-seven-types-20261112/first-assessment.json), [second assessment](evidence/issue26/real-seven-types-20261112/second-assessment.json). Each preserves source SHA, cases, raw usage, original command error, and hashes of unchanged raw records. To revalidate locally:

```sh
node scripts/durable-context-live-assessment.cjs --self-test
node scripts/durable-context-live-assessment.cjs <recorded-run-directory> <assessment.json>
```

Both runs used a declared 1,048,000-token model window and a 12,000-token absolute trigger. The observed first summary call used 11,537 prompt tokens in the first run. These are functional observations, not a controlled native-versus-BC cost/performance comparison. Pricing was not measured. No full headless aggregate, packaging or ARTIFACT tests were run. No physical-keyboard/mouse input or 100K-entry cold-store benchmark is implied.

After the runs, the patch was rebased onto `94defbf80523a5a3ced6684d6cf38ccb742409a8`, preserving the UI work and the latest #27 report correction. The three production files in this patch are byte-identical to the real-tested versions. No #32 product commit was present on that remote main; this patch does not change Bot collaboration ownership or scheduling. Its Bot service change only admits the four fixed context-tool names.

## Still outside the evidence of this patch

- A native-versus-BC performance/cost comparison on the same workload and cache conditions.
- Genuine 1K/10K/100K archived Durable-entry cold-store measurements and an incremental active-view implementation. The adapter still serializes active history for mapping; kernel ref/block metadata still requires further long-history work.
- Complete provider/platform/multimodal, Gateway/Remote, and crash-boundary matrices.
- A prepare-stage SDK budget hook and complete provider-specific output-budget validation. The added guard is a conservative input estimate with reserve, not an exact tokenizer guarantee.
- Full persisted maintenance operation/revision and all auxiliary usage attribution acceptance.

Keep issue #26 open until its complete acceptance checklist has evidence. No build, packaging, release installation, database schema bump, failure-baseline relaxation, or changes to the user's other working copy are part of this patch.
