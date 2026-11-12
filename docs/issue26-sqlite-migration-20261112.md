# Issue #26: official per-session SQLite integration

This is an implementation-stage report, not issue closure or a packaged-app acceptance claim.

## Storage and publication

`openDurableStorage` is now the single production writer opener. Each Durable session has an official `SqliteStorage` artifact (`durable.sqlite`), not application-database tables or a second business-state implementation. The existing pinned Pi 1.5.0 package receives additive read-only and explicit-sequence import APIs. A better-sqlite3 facade supplies the portable SQLite interface; the Electron-incompatible `node:sqlite` adapter is not used.

The writer holds a separate persistent SQLite mutex with an exclusive transaction. The OS releases it on process death. Unique per-handle tokens and the mutex reject both same-process duplicate handles and concurrent processes. The diagnostic JSON owner file is not the authority, and the mutex artifact is never unlinked. This assumes a filesystem with working SQLite locks; distributed filesystems and simultaneous startup with an old non-mutex application are not proven safe.

Legacy migration fingerprints and copies only the official JSONL source files, then lets official recovery normalize the private copy. Each recovered commit is imported with its original sequence, including gaps and empty commits. Verification compares official reads for entry payloads and commit sequences, conversation ancestry, tasks/checkpoints, submissions/receipts, current and historical document points (including retired, session and task documents), heads and next global ID. No Harness, task implementation or model is instantiated by migration.

Original JSONL bytes and timestamps are unchanged. Conflicting/corrupt sources fail closed. The older duplicate-sequence repair helper cannot prove that discarded writes/receipts are identical, so production migration does **not** automatically select its truncated result. Diagnostic helper tests remain, but automatic resumption of ambiguous history is forbidden.

After verification, the target is closed and flushed, then its artifact is renamed into place. An authoritative selector is published last. Selected writable artifacts use non-migrating exact-schema/metadata validation; a valid unrelated SQLite file is rejected byte-identically rather than initialized as blank Durable state. Missing/malformed selectors after selection and missing targets are errors; retained JSONL is never a post-selection fallback. A durable ownership/phase record supports restart of interrupted migration. Only positively identified verified artifacts can be published after a crash. Failed/old staging and all original backups are retained, never automatically deleted.

## Passive reads

Passive SQLite opens perform no migrations, leases, directory creation, repair or writes. They pin one read snapshot through close, so branch/document/head/submission reads agree. A process-local asynchronous reader/writer gate prevents synchronous better-sqlite3 COMMIT waits from deadlocking a local snapshot reader. Cross-process locking remains SQLite's responsibility and can return a truthful busy error. A hot rollback journal requiring recovery is refused by passive reads without changing bytes; writable opening can recover it.

Bound service history uses passive inspection, not runtime recovery or tool/model assembly. Legacy Pi session-file import remains a separate explicit execution path. SQLite point reads remain indexed; one-time JSONL recovery memory is not used for recurring opens.

## Focused verification

Synthetic fixtures only, with `TMPDIR=/home/vivion/i26-tmp`:

- `test:durable-storage-replay-api`: original sequences, gaps/empty commits, reclaimed sidecars, current/historical/retired/session/task/fork documents, read-only validation and import atomicity.
- `test:durable-storage-lease`: same-process exclusion, eight-process contention with one winner, idempotent release, passive metadata invariance and SIGKILL takeover.
- `test:durable-storage-migration`: production opener, differential state, unchanged source bytes/mtime, passive bytes/mtime/inventory, async local writer wait and coherent snapshot, fail-closed selectors/targets, four real SIGKILL publication boundaries and idempotent recovery. 300-conversation/task/submission fixtures inject mismatches on the second verification page and must refuse publication. POSIX EIO/EPERM directory-sync faults before and after selector rename must reject, never acknowledge uncertain publication. An additional real SIGKILL with spilled SQLite pages verifies passive hot-journal refusal and writable rollback recovery.
- `test:durable-sqlite-storage`: 2K originals, separate cold process, indexed retrieval, transaction rollback/history/fork checks.
- `test:durable-history-readonly`, `test:durable-bot`, `test:durable-subagent`, `test:durable-consult`, and `test:durable-log-repair`: passed against the production opener.
- `test:durable-context-operations`: all 13 behavior groups, including four actual SIGKILL recovery scenarios, passed with production SQLite and no replayed summary/business-model calls.

Final integrated typecheck passed (web/main/scripts; zero script errors), as did diff whitespace validation. A zero-model, no-GUI native probe under this checkout's pinned Electron 44.5.1 (Node 24.21.0, module ABI 149, N-API 10) created, wrote and queried a better-sqlite3 in-memory table successfully. Electron dist was restored from the existing official pinned cache after the script-skipping dependency install; no native rebuild or original dependency mutation was needed.

The three new storage tests are registered as headless; process-contention/crash tests run in the serial pool. Existing dependency versions are unchanged. Only this repair checkout's node_modules symlink was replaced with an independent cached installation; the user's original checkout and dependency target were not mutated.

The packaged probe source now uses the production opener and requires SQLite, and its bundler leaves better-sqlite3 external for the existing native-module packaging verification. No build, package, actual ARTIFACT, GUI, all-platform or real-provider verification was performed in this storage step. Windows directory fsync is unavailable through Node; file data is flushed but Windows power-loss rename durability is not claimed. Full 1K/10K/100K scaling and final aggregate regression remain separately coordinated. Bounded active model history and all-scenario issue acceptance are not implied by the storage switch.

## Integrated follow-up evidence

Frozen product code `7da4f002209e5ed5b8a0bef29ddf2b5d64a05cec` completed a real Flash / isolated Electron `pnpm dev` run at 05:15:51 UTC: seven different task types, 11 actual provider requests, one summary request, six requests containing the committed summary, exact-original tool retrieval after a cold restart, and Bot foreground `acp_status`. [Assessment](evidence/issue26/sqlite-20261112/seven-types-assessment.json) records source identity, real usage and original report SHA-256. This is CDP-driven actual Electron, not native pointer/keyboard or packaged-app verification. Model output allowance was the actual configured 328,000, not an invented 4,096 ceiling; pricing remained unknown.

The two earlier real-run failures were fixture expectations: accepting only one Chinese synonym for “tomorrow at ten”, and demanding a JavaScript declaration when the prompt only asked for the current numeric value. Both original failed runs remain on disk. The final run used the corrected prompt and meaningful assertions and exited zero; failure evidence was not re-labelled as a successful command.

[Full-scale metrics](evidence/issue26/sqlite-20261112/cold-store-metrics.json) include both imported-head and organically compacted text histories at 1K/10K/100K, five cold processes each. Source identity includes the actual uncommitted product/test hashes at the time, not just the older base SHA. All 30 cold processes avoided full JSONL replay. The SDK's fixed observation window may still read up to 51 records, so strict *zero archived reads* is false while the declared finite bounds pass. These are fixture measurements, not real-provider speed comparisons. Protected multimodal leading history and giant initial imports remain outside the proved bounded text path.

The initial integrated 493-test gate on `7da4f002` has no recorded final summary. Its retained partial log contains two fixture failures: generation-speed opened a second writer without closing the first; artifact-selection searched legacy JSONL bytes instead of authoritative SQLite evidence. `aaa106fe` fixes these assumptions without removing assertions: a genuine close/reopen proves persisted generation speed, and paginated read-only storage APIs prove the first invalid reply and repair request ID survived. Both affected suites and web/main/scripts typecheck subsequently passed. The incomplete gate is not reported as 493 passes.

### Independent task branch follow-up

`75eeb5c6` adds the missing C5 cold-identity transfer. Capture reads each entry owner's actual commit sequence, pages the as-of context/ref/block documents, and remaps originals to the independent task's entry IDs in the same destination transaction. Coverage is rebuilt in the new session; source operation authority, session UUIDs and cursors are not copied. Cold ref/block keys and their allocation high-water marks are retained.

The production branch/restart/tool fixture now verifies unequal source/target IDs, old active and archived refs, an archived block, exact-original `acp_retrieve` after reopen, future-reference exclusion, monotonic new allocation, source immutability and historical rebranch exclusion. `test:durable-context-branch-cancel`, `test:durable-projection`, typecheck and diff validation passed. This test uses controlled provider responses, not a real-model branch acceptance claim. Full-history branch export cost is still proportional to copied history/documents and was not benchmarked as a constant-time operation.
