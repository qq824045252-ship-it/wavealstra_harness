# Issue #26: context-management safety repair and verification

This is a follow-up to the existing billion-context adapter, not a claim that every acceptance item in issue #26 is complete.

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
- Web and main-process typechecks passed. Script ratchet initially caught one branded-entry-ID type in the new fixture; it was corrected and the script ratchet passed. The later additional parallel-tool fixture will receive the final script recheck before push.
- Test classification audit passed; live driver/scenario syntax checks passed without launching a model.

The first storage integration attempt failed because host `/tmp` rejected its lease-file write with errno -122. The unchanged test passed with a private `TMPDIR` under the selected computer's home directory; no product error handling or assertion was relaxed.

Real Electron/model acceptance is pending its coordinated desktop window. The complete default headless aggregate has not been run for this focused patch. No packaging or ARTIFACT tests were run.

## Still outside the evidence of this patch

- A native-versus-BC performance/cost comparison on the same workload and cache conditions.
- Genuine 1K/10K/100K archived Durable-entry cold-store measurements and an incremental active-view implementation. The adapter still serializes active history for mapping; kernel ref/block metadata still requires further long-history work.
- Complete provider/platform/multimodal, Gateway/Remote, and crash-boundary matrices.
- A prepare-stage SDK budget hook and complete provider-specific output-budget validation. The added guard is a conservative input estimate with reserve, not an exact tokenizer guarantee.
- Full persisted maintenance operation/revision and all auxiliary usage attribution acceptance.

Keep issue #26 open until its complete acceptance checklist has evidence. No build, packaging, release installation, database schema bump, failure-baseline relaxation, or changes to the user's other working copy are part of this patch.
