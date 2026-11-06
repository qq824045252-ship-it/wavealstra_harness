# Phase 1 草稿审查证据

修复入口：[Codex 执行清单](../../bot-work-phase1-review.md)。

这里归档的是用户上传草稿及本次审查证据。`draft.ts.txt` 保持原始字节，使用文本扩展名以避免被误认为产品 TypeScript 模块。不得将它作为应用入口或直接导入产品；实现应按清单接入当前仓库的实际模块。

## 复现

在仓库根目录使用 Node.js 24 运行：

```bash
node docs/reviews/bot-work-phase1-2026-11-06/run-review.mjs
```

默认在系统临时目录生成新的结果，并打印路径，不覆盖这里保存的原始证据。也可以传入一个明确的结果目录作为第一个参数。

使用 Node 标准库，无需安装 npm 依赖。脚本仅加载归档草稿，在内存 SQLite 中执行原方法与 SQL；不启动 MyBuddy、不调用远程业务、不读取用户凭据或应用数据库。

**退出码 0 只表示探针执行与结果采集成功。结果中的 `ok:true` 是被审服务接受请求的返回值，不表示产品验收通过。**这批脚本针对固定原稿复现缺陷；正式修复需将对应场景迁入当前产品服务的行为测试，并断言正确结果。

## 内容与来源

| 文件 | 用途 |
| --- | --- |
| [draft.ts.txt](draft.ts.txt) | 原 `bot_work_phase1.ts`，2431 行、85507 字节 |
| [manifest.json](manifest.json) | 原件摘要、固定仓库基线和验证范围 |
| [probes/logic-repro.mjs](probes/logic-repro.mjs) | 原服务方法的 13 条反例 |
| [probes/schema-repro.mjs](probes/schema-repro.mjs) | DDL、专家采纳、Goal 与 schema 检查 |
| [fixtures/AppDatabase.goal-schema.txt](fixtures/AppDatabase.goal-schema.txt) | 从固定 main 版本提取的 Goal DDL 与 schema 常量 |
| [results/logic-results.json](results/logic-results.json) | 已记录的 13 条服务输出，顺序对应清单 P01～P13 |
| [results/schema-results.json](results/schema-results.json) | 已记录的 5 项 schema 观察，其中 DDL 建表成功为正向观察 |
| [results/run-metadata.json](results/run-metadata.json) | 运行版本、时间与验收边界 |

原件 SHA-256：`494d96f41113433ffb37f55fe2dd78ed5b9d2a0eda7278fd926e57b1d6a5c4a0`。

相对最初本地复现包，发布时只调整了探针读取路径、schema 探针的 TS 加载方式和结果输出位置。被审原件、DDL 和服务逻辑未修改。Node `stripTypeScriptTypes` 使用 transform 模式处理类型/参数属性，数据库由 `node:sqlite.DatabaseSync` 提供同步 prepare/transaction 薄适配。

## 证据限制

- P08 用 SQL 建立在途执行前置状态，因为草稿没有公开 dispatch 方法；关闭仍调用原 WorkService。
- “下一次由当前 AppDatabase 打开会备份重建”来自实际版本检查分支分析；没有在这里运行整个 Electron 宿主。
- 旧状态问题只证明 `emitUiPatch` 发出旧快照，没有证明 renderer 实际回滚。
- 来源 SHA/产物版本缺失是契约分析，未计入 13 条已执行服务反例。
- 未验证目标仓库 better-sqlite3、类型检查、原生 Durable、跨端 UI、Omarchy、发行包或完整 BW/E2E；内存 SQLite 也不能替代持久存储崩溃恢复验收。
