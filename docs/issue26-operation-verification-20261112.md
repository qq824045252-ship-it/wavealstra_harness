# Issue #26: durable maintenance identity and recovery follow-up

This report supersedes the operation/status gaps in the earlier [closure matrix](issue26-closure-matrix-20261112.md). It does not close the remaining bounded-history and cross-surface acceptance requirements.

## Frozen source

Product repair: `f8b22b0518c77d5c5962bd3b7e0fc11b94a49c43`, rebased without conflicts onto main `25bee0252535130b48d0ee12c7bbd545c2586687`. The user's intervening memory-recall and visible-artifact fixes are preserved. All stores, prompts and credentials in these tests are synthetic/isolated; no user journal was migrated, edited or removed.

## Changes

- A persisted session UUID, conversation identity, monotonic revision, operation ID, source head/tail/epoch/view digest and configuration digest identify maintenance across reopen.
- BC coverage and its terminal outcome are saved in one transaction. Older managers and stale callbacks cannot overwrite a later revision. Synchronous admission also prevents two callbacks in the same manager from publishing one another's staged coverage. Initialization, non-fold preparation and flush cannot bypass an outstanding save.
- Native fallback is not called completed merely because a summary was generated or any head changed. The stored native entry must match the task/submission identity, first-kept boundary, compaction entry kind and exact summary digest. Passive recovery can verify this durable proof if the process died before the manager saved its terminal projection.
- Status in a closed runtime reads the durable store without constructing a Harness/model, acquiring an owner lease, repairing a journal or writing files. `acp_status` reads the loaded/committed snapshot without initialization writes. A live owner is not mislabeled interrupted.
- Retrieval cursors bind to the persisted store identity, conversation and resolved target/entry set. Equal numeric IDs in a different store, old cursor format and changed targets are rejected with a recoverable first-page instruction.
- Model-facing `acp_compress` accepts expected revision/configuration values. The actual computation snapshot, not a later re-read, is checked before admission and final commit. Omitting the optional values retains compatibility while still validating that computation's source.
- Native fallback sizing now takes the maximum of observed usage and independent message estimates, so imported history cannot hide an oversized summary input behind an old assistant usage sample.

## Focused verification

Final integrated `test:durable-context-operations` exited zero in seven seconds, with 13 behavior groups:

1. Durable identity, reopen pagination, cross-store/legacy cursor rejection, stale revision/config rejection and passive status.
2. Persisted cancelled, failed and skipped outcomes.
3. Head/edit changes between computation and operation admission.
4. Initialization-save interleaving with reads, maintenance and flush.
5. Same-manager admission and staged-state isolation, including non-fold preparation.
6. Different-manager stale callback CAS and active-owner status.
7. Actual storage start-write, terminal-write and lost-ack failures; uncertain success is not published.
8. Configuration change during a summary, followed by recovery at a higher revision.
9. Unrelated native heads cannot impersonate this operation's result.
10. Actual child-process SIGKILL before the summary call.
11. Actual SIGKILL after summary generation, before the coverage/outcome commit.
12. Actual SIGKILL after durable commit returns, before the manager receives it or publishes success.
13. Actual SIGKILL after native head commit, before the manager's terminal update.

The crash tests reopen the real JSONL stores, check exact originals, truthful persisted outcome, idempotent recovery and zero replayed summary/business-model calls. Passive reads are checked against file bytes, modification times and directory contents. Providers in these focused tests are fixtures; they are not real-model evidence.

Safety, management, branch-cancel and performance focused suites passed before the final initialization-order-only change. After that change and integration onto main, operations, the SQLite candidate test and full web/main/scripts typecheck all passed. Script errors: zero. `git diff --check` passed. No full headless rerun, build, package, ARTIFACT or all-platform GUI claim is made for this commit; the earlier 486-case gate remains tied to its recorded earlier source.

## Official SQLite candidate, not a production switch

The new `DurableSqliteDatabase` is a small better-sqlite3 facade for the official Pi Durable SQLite Storage. Its focused test passes 2K real original records, a separate cold process with indexed point lookup, commit sequences, rewindable documents, fork ancestry, task/submission persistence, ID-conflict atomic refusal, transaction queue/rollback and expired handles.

The candidate deliberately supports DELETE-journal artifacts only. It rejects an existing WAL artifact before opening it and does not convert it. Passive facade reads preserve bytes and directory inventory. The unmodified official `SqliteStorage.open` still attempts migrations, so its use with a read-only facade is explicitly tested as a rejection, not advertised as passive Storage support.

There is no backend selector, active-store switch or JSONL migration in this commit. Safe official recovery export, original-sequence import, verified read-only initialization, atomic migration selection and bounded active model context are the next implementation stage. The previously measured unbounded JSONL archive hydration and BC-only raw preparation remain open.

## Real Flash / Electron follow-up

The real run started at 2026-11-12 04:24:47 UTC on the frozen source above, using production `pnpm dev`, an isolated profile and `opendesign/deepseek-v4.1-flash` through the existing local transport. The command exited zero: **seven of seven functional types passed**, with 11 real provider requests, one real summary and six requests carrying committed compression, including after cold restart. Exact originals reached the provider through the real retrieval tool result. The isolated profile and checkout had no remaining Electron/driver processes after completion.

Strict formatting is separate: the PORT answer used the correct 6284 declaration, but added an explanation about deprecated 6173 despite the request for only a constant. This is recorded as a formatting deviation, not silently relabeled a strict pass or a context-correctness failure. Earlier failed commands remain in the earlier report.

Evidence: [real assessment and request hashes](evidence/issue26/real-seven-types-20261112/operation-recovery-assessment.json), [focused scope and log hashes](evidence/issue26/operation-recovery-verification.json). Physical desktop input, other providers, Remote/Gateway and a controlled native-versus-BC cost comparison are not implied.
