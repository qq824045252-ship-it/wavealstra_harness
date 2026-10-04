# R3 Review Baseline — Dirty Prototype 冻结（Stage 0）

> 冻结时间：2026-08-21
> 基线 commit：`bd6400177b4f9d21c73fd1e600e7ce79cd641ed6`
> 状态：dirty prototype，未收敛。独立 Review：P0=4 / P1=5 / P2=5 / P3=1
> 本文件仅记录证据，不作为完成版验收依据。

## 1. Git 基线

- HEAD：`bd64001 fix(retrieval): align migration tests for v16 semantic index`
- 前序：`3154e32` backfill missing chunks、`d076854` eval gate、`7d63a4d` workspace scope binding
- `git diff --stat`（7 files, 272 insertions）：
  - `.gitignore` +6 (`*.onnx`, `*.onnx.data`, `C:\tmp\bge-poc/`)
  - `package.json` + eval:r3-semantic, optionalDependencies onnxruntime-node@1.22.0
  - `src/main/db/AppDatabase.ts` v15→16 ensureSemanticIndexTables + deleteChunkEmbeddings
  - `src/main/library/LibraryService.ts` +134 backfillEmbeddings + delete cleanup
  - `src/main/workspace/WorkspaceResourceLocator.ts` +52 searchAsync + router/fusion
  - `src/main/workspace/workspace-resource-locator-extension.ts` mode auto/lexical/semantic
  - `src/shared/workspace-resource-locator.ts` matchedBy + semantic

- untracked（待 Stage 1 决定保留/重做）：
  - `src/main/retrieval/SemanticRouter.ts`
  - `src/main/retrieval/WorkspaceSemanticProvider.ts`（含 hash fallback、硬编码 C:\tmp\bge-poc）
  - `src/main/retrieval/onnx.d.ts`
  - `src/main/workspace/WorkspaceResourceLocator.semantic.ts` (fuseHits)
  - `scripts/retrieval-eval/r3-semantic-eval.ts`
  - `scripts/r3-final-review-probe.ts`
  - `docs/r3-cpu-cost.md`

## 2. R2 Baseline（生产 lexical）

- FTS5 trigram chunk 索引，scope = Current+ancestors，bound ∩ permitted
- retrieval-eval-cases.jsonl 27 cases，按 r3-semantic-eval.ts 口径（复用 Fixtures）：
  - `eval:r3-semantic` 中 lexical-only 整体 Top1 33.3% (8/24), Top3 62.5% (15/24)
  - 分桶（见 out/r3-semantic-report.json dirty 运行）：
    - exact Top3 83.3% (5/6), keyword_zh Top3 100% (6/6)
    - cross-language Top3 33.3% (1/3) — P0-4 预期 semantic 提升点
    - abbreviation_alias Top3 100% (3/3)
    - semantic-description Top3 0% (0/3) — semantic 目标
    - long-query Top3 0% (0/3) — semantic 目标
  - leakage 0（当前 hash 路径下通过），但非真模型验收

## 3. R3 Hash Baseline（dirty prototype 测得）

- 同库对比 R2 vs R3 auto 均为 `overall Top3 62.5%`，delta 0 — hash fallback 未带来真实提升
- 说明：当前 `WorkspaceSemanticProvider.hashEmbedding()` + SYNONYM_GROUPS 仅保证离线可用，未验证 BGE-M3 INT8 真实效果
- Gate：leakage PASS、lexical no-regression PASS，但 semantic improvement 未达标（cross/semantic/long 均未提升）

## 4. BGE-M3 Python PoC（冻结选型依据）

- 模型：BAAI/bge-m3 INT8 `C:\tmp\bge-poc\bge-m3-int8.onnx` + `.data`（568 MB data + 1 MB stub，disk 541 MB effective）
- 量化：FP32→INT8 Top-3 delta 0pp（`C:\tmp\bge-poc\quant-eval.json`）
- 性能（bench-int8.mjs, CPU EP, onnxruntime-node）：
  - Load 711 ms, rss delta 327 MB; L=32 17.7ms / L=128 44.5ms / L=512 580.7ms
  - FP32 对比：load 2515ms rss 1161MB, L=512 1307ms
  - Outputs：sentence_embedding [1,1024] L2-normalized, truncate 512 tokens
- 已冻结：不再选型 Qwen3/E5，R3 v1 锁定 BGE-M3 INT8

## 5. Independent Review Findings（P0/P1/P2/P3）

- P0-1 hash/mock：生产路径仍 `catch → hashEmbedding`，`C:\tmp\bge-poc` 绝对路径，`*.onnx` ignore 却依赖本地模型
- P0-2 模型不可分发：无 SemanticModelManager / userData/models / manifest / SHA-256 / atomic rename
- P0-3 内存/加载：每 chunk `new WorkspaceSemanticProvider()`，无 lazy singleton session 复用
- P0-4 negative threshold：semantic 无阈值强行 Top-K，无 positive/negative score 分布标定
- P1 orphan：delete 顺序未冻结，DB/Service 双路径，chunk 更新未处理 removed/changed/unchanged
- P1 old DB empty index：无启动 async backfill + checkpoint/resume（语义索引空时需 pending）
- P1 provider reload：backfill 循环内重复构造 Provider
- P1 no E2E performance：缺真实 P50/P95、RAM/disk、packaged app smoke
- P1 dimension/version：读侧未严格过滤 model_id/version/dimension/chunk_hash
- P2 telemetry/fusion/tool warning/dead code/index stats 等 5 项
- P3 业务硬编码启发词（“取样后”等）

## 6. 冻结规则

> 没有真实模型 = semantic unavailable，而不是 fake semantic。
> 本 dirty prototype 不得直接提交为完成版，Stage 1 起删除生产 hash fallback。
