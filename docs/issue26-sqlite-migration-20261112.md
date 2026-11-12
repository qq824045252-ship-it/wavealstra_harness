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

### Completed reasoning exchanges

The native boundary now accepts whole completed signed/redacted-thinking exchanges rather than permanently refusing every reasoning-model prefix. It still rejects images/unknown content, unfinished or truncated assistants, missing or reordered tool results, duplicate IDs and mismatched tool names. Signatures/opaque data are preserved in original SQLite records and omitted from summary prompts; still-active native messages remain byte-identical.

`test:durable-context-active-view` passed the real native-head transition, three signed/redacted/parallel-tool positive flows, 11 rejection cases, cold reopen, exact payload checks, unchanged active signatures, the existing 1K/ten-generation growth cases, branch/restart, queued input and cancellation. The old parallel-tool fixture incorrectly marked a tool-call message `stop`; it now uses actual `toolUse` semantics. Final combined web/main/script typecheck passed. Giant first imports and image-protected prefixes still require a separate bounded-input integration and are not relabelled as tested here.

### Completed integrated gate

A fresh immutable source export of `aaa106fe` completed the default headless gate: **493 passed, 0 failed, 0 known failures, 0 new regressions, exit 0, 8.1 minutes**. The two earlier failures passed inside this full run. [Gate identity and log hash](evidence/issue26/sqlite-20261112/headless-gate.json) identify the frozen source and separate later deltas. C5 and signed-thinking changes were validated with their affected suites and final combined typecheck, not falsely counted as part of the earlier frozen full run. No baseline was loosened and no full suite was rerun for each small change.

## Native / BC 七类真实模型对照（2026-11-12 06:17 UTC）

在 `bd99a359` 产品代码、同一 Flash Provider 下，分别以全新隔离 profile 跑真实 Electron `pnpm dev`：native 与 billion-context 均 **7/7，命令退出 0**。覆盖日志判读、库存计算、翻译、结构抽取、指令纠正、冷重启后工具逐字回查原文、Bot 前台上下文工具。

| 引擎 | 请求（含摘要） | 摘要 | 输入 tokens | 缓存读取 tokens | 输出 tokens | 七项用例耗时之和 |
|---|---:|---:|---:|---:|---:|---:|
| native | 13 | 3 | 280225 | 191360 | 3575 | 77759 ms |
| billion-context | 13 | 3 | 292223 | 215296 | 3402 | 76691 ms |

缓存未清空或强控；单批数据不能证明 BC 更快或更省。耗时之和不含启动/重启，价格未测。native 原报告摘要数只在重启前统计，原始请求证据实际有 3 次；本次修复夹具在全部场景后重算，原始报告保留不改写。两批完整 usage 都已经计入所有摘要费用口径。

第一次 BC 批（05:55）中断在 5/7，无最终 report/退出码，不计通过；已保留证据。恢复批（06:14）使用新隔离 profile，7/7 且退出 0。

结构化证据及 SHA256：`docs/evidence/issue26/sqlite-20261112/native-bc-seven-types-comparison.json`。仍未证明巨型首次历史/受保护图片前缀有界，以及全部 Work/team/Gateway/Remote 入口矩阵；不能据此关闭整个 #26。

## 后续入口与媒体完整性专项（2026-11-12）

- 修复 BC fallback 图片完整性：无论小输入走 Pi 原生文本摘要，还是大输入走宿主分块摘要，都不能用图片占位文本替代真实附件并提交成功 head。现在保留原附件并报告无法安全整理；原请求仍可容纳则继续，真实 provider overflow 仍走既有有界失败，不重复发送。仅此窄保护，不宣称已实现历史媒体分页回取。
- `test:durable-context-active-view` 新增小/大手动整理、provider overflow 三条真实 CompactionTask 链，验证没有摘要调用/伪造 head、原字节不变、可容纳请求继续；`test:durable-context-safety` 9组通过。
- `test:durable-context-window-matrix` 用真实 Durable/SQLite 与最终 provider fixture 请求覆盖128K/272K/1M、absolute/null、同 runtime 大→小热切换、设置变化、冷恢复及父子不同模型。不是旧策略纯函数，不冒充外部模型验收。
- `test:durable-context-entrypoints` 经真实 GatewayService inbound → DurableBotService，验证自动压缩投影、原文工具、冷重开；直接调用生产 openDurableAuxiliary，验证默认策略、独立状态、回查与恢复。Work/team/Remote链尚未用此专项覆盖。

再次按原 Issue 核对：D1 初次有界补读仍有真实缺口。legacy 生产导入会把 buildSessionContext 全量存入一个 context-import，SDK 在请求 hook 前先读完整视图；仅改变 Manager beforeRequest 不够。需要保持旧摘要/路径语义、可分页完整交换及受版本控制的 SDK 初始维护边界，不能删除原文或将大历史冒充单条用户超限豁免。Remote 目前只透传事件，仍需验证消费和重连的状态单调性。这些未完成项仍属于原范围，未拆出去伪造关单。
