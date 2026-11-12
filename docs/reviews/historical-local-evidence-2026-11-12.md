# 历史未跟踪验收资料归档

这些资料整理自 Vivion 本地已有文件。整理时 main 为 `4599c9efade7517f29c00d6412798624c96a7bdc`；本次只读核对与脱敏，不运行旧测试，不宣称当前版本全量通过。

## 版本与边界

- `latest-origin-baseline-*.json`：原始 origin 为 `0848b640ffc74bf501343b358a7d1974974a7401`，记录 12 项当时失败；`latest` 仅为历史文件名，不代表当前 main。results 中 repo/temp 绝对路径已换成占位符，原日志 SHA 保留。cloudflared 失败中的无盘符实际路径以 `<drive-less-temp>` 表示，与有盘符预期路径的 `<temp>` 区分，保留原始失败原因。
- `main-integration-conflicts.json`：`0848b640` 与 `af8c3508` 集成时的冲突解决清单，不表示当前仍有冲突。
- `recipient-persisted-*.png`：原有合成验收界面，已肉眼检查无凭据；显示模拟工单、算术、代码审核和课程文件任务。截图本身没有独立的构建 SHA 元数据，不据此证明当前 UI 或所有行为通过。特别是 `recipient-persisted-main.png` 下方卡片标题为 CSV 库存核算，但可见“原始请求”为 19×23 算术题，存在可见的标题/请求不一致；该截图不能作为任务来源关联正确的证据，也不能据此判定当前代码仍有同一问题。
- 两份 memory40–42 文档：`b7040544` 加未提交工作区的首轮及复审记录；全量失败分别为 13 与 18。后续修复不能回写这些历史运行结果。

7 项均与已跟踪 issue32 目录作过字节级重复检查，没有相同文件；归档补充来源而非增加新的验收结论。

## 原始文件到归档文件的校验

原始资料保留在用户工作区，未删除或覆盖。下列 SHA 可追溯脱敏前后；截图字节未改。

```json
[
  {
    "path": "docs/reviews/evidence/issue32/latest-origin-baseline-integrity.json",
    "sourceSha256": "b2412439eba2acfd1e5df6b9850a1998502e57dbfbbccec8c356e0ecf0d04ab2",
    "candidateSha256": "042282eacde7ecf46dd66b660740db32213b2f9844ef232c4b29bd439709ec97",
    "bytes": 1301,
    "kind": "historical-redacted-evidence"
  },
  {
    "path": "docs/reviews/evidence/issue32/latest-origin-baseline-results.json",
    "sourceSha256": "8f26b68ac3fe12b94627c78e6633673d9648cdff11b22f9b51cb3daf35a0745d",
    "candidateSha256": "c618a0e6423cea26671011f4fdb80c45041fd16218c21c7e64cd8b16fa55ddc4",
    "bytes": 8300,
    "kind": "historical-redacted-evidence"
  },
  {
    "path": "docs/reviews/evidence/issue32/main-integration-conflicts.json",
    "sourceSha256": "edd123872a0769e416b630c0afa0b2faa22ddae573e7a2bf4a9d24d0d99745a8",
    "candidateSha256": "edd123872a0769e416b630c0afa0b2faa22ddae573e7a2bf4a9d24d0d99745a8",
    "bytes": 712,
    "kind": "historical-redacted-evidence"
  },
  {
    "path": "docs/reviews/evidence/issue32/recipient-persisted-consultation.png",
    "sourceSha256": "9dda1caf1a184af4c17f3349b5891593d5ffc2da137899d30d21e66fb34eb207",
    "candidateSha256": "9dda1caf1a184af4c17f3349b5891593d5ffc2da137899d30d21e66fb34eb207",
    "bytes": 102724,
    "kind": "historical-synthetic-ui-screenshot"
  },
  {
    "path": "docs/reviews/evidence/issue32/recipient-persisted-main.png",
    "sourceSha256": "db38791ce3cd6f0de73daeb9496ef426d1e1acceb8f0b87d60f560d210ad58d9",
    "candidateSha256": "db38791ce3cd6f0de73daeb9496ef426d1e1acceb8f0b87d60f560d210ad58d9",
    "bytes": 127689,
    "kind": "historical-synthetic-ui-screenshot"
  },
  {
    "path": "docs/reviews/memory-40-42-2026-11-12.md",
    "sourceSha256": "e0b81d6fbfd7c0686d2d0d7a578a1246ca4c848b2b9e1bcf11d742fa2087c13b",
    "candidateSha256": "49af2d52a0f54e9623869e0421bc7dd5063a457f9cf8032502e0ced13548aece",
    "bytes": 8049,
    "kind": "historical-review-document"
  },
  {
    "path": "docs/reviews/memory-40-42-follow-up-2026-11-12.md",
    "sourceSha256": "3b0c3d368d53550223bfe2a393dba214570619627acf3703954102e507fa5ddd",
    "candidateSha256": "6b8fb96cffbad5a030a1eceb41b2b679514e36d22946d5ccc1f8e118884ca2fb",
    "bytes": 9505,
    "kind": "historical-review-document"
  }
]
```
