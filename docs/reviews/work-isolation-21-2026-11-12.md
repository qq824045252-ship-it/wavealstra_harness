# Issue #21 专项修复与验收（2026-11-12）

## 来源与范围

- 对照 <https://github.com/qq824045252-ship-it/wavealstra_harness/issues/21>。
- 初始公开基线：`b5c1429d`。Omarchy 独立 main clone；未操作 Vivion 或真实用户 profile。
- 按后续用户方向保留权限/预算退役，不恢复共享隔离、scope 审批或审批续跑。

## 复现与修复

1. 浏览器 `press` 的异步焦点查询期间取消，旧实现仍发 DOWN/UP。新增回归在修复前明确以 `Missing expected rejection` 失败。现焦点返回后先检查取消；停止的调用没有输入事件，独立调用继续。DOWN 返回异常时仍尝试配对 UP，并保留原始错误。
2. 带历史父子外键、且 `foreign_keys=ON` 的显式退役调用，旧删除顺序先删父表，触发 `SQLITE_CONSTRAINT_FOREIGNKEY`。改成子表先删并报告范围。正常 AppDatabase 启动原本在 FK-off 迁移事务内，因此不把这个附加场景误报成所有旧 profile 均无法启动。
3. 补充旧 profile 验证：pending/queued/running outbox、host quarantine、恢复/效果子表、索引/触发器、三类退役 blocker；比较业务整行、检查 SQLite 完整性、重复启动与部分清理、事务回滚。
4. 补充 Linux 进程内队列测试：旧任务取消释放自己的按住状态后，新任务继续；旧清理不释放新任务的键。该测试是依赖注入，不能代替真实桌面证据。
5. 更新 `docs/work-action-approval-loop.md`，去掉已失效的 default/readonly 审批、scope 白名单和预算契约。

## 验证命令

- 已执行并通过：`pnpm -s test:work-isolation-retirement`（6组，含 rollback）、`pnpm -s test:browser-automation-recovery`、`pnpm -s test:linux-native-backend`（27项）、`pnpm -s test:work-permissions-retired`、`pnpm -s test:work-budget-retirement`（含 v35→v36 原地升级）、`pnpm -s test:work-effect-retirement`、`pnpm -s test:computer-use-run`、`pnpm -s test:input-guardian`（14项）。
- 已执行并通过：`pnpm -s typecheck`，web/node/script 均无新增错误；`git diff --check`。
- 已执行：`node scripts/work-isolation-live-test.cjs --check-harness`，仅语法，不会启动 app 或推理。
- 已执行：`node scripts/test-all.mjs --audit`；新 live 项单列为 NETWORK。
- 其他收尾检查与真实批次结果待追加，未运行的检查不得按通过报告。

## 真实验收入口

`TMPDIR=<仓库外临时目录> pnpm -s test:work-isolation-live`

脚本使用原有 `pnpm dev` / Electron / preload 运输层，透明转发到用户指定模型。默认 `http://127.0.0.1:3425/v1`、`opendesign/deepseek-v4.1-flash`，不复制凭据；模型上下文/输出配置读取网关公开模型目录，不另设任意输出限额。

每批覆盖普通磁盘验证、公开搜索、内置浏览器阅读、真实网络错误诊断、Bot 后台表格分析、Bot 后台来源文档六类任务，再做同一原生会话重启续读。每个场景保存真实请求、工具、业务结果和失败，单项失败不会静默减少后续类别。起始用隔离 profile 注入旧机制数据并真实重启；不会自动执行其中的历史载荷。

实时日志与原始报告默认保存在该 checkout 的 `out/diagnostics/work-isolation/`；提交证据需脱敏且注明实际 SHA。真实网络失败应单列，不改写成隔离门禁错误，也不能声称网络通过。

## 尚不能由本报告证明

- Windows 旧 profile / 输入链路。
- 用户真实数据库中历史清理的 248 条记录，本轮只使用合成旧 profile。
- 全部 GUI 或打包发行物。本轮不 build/pack。
- fixture 不等于真实在线模型、真实物理输入或跨平台完整验收。

## 首次真实批的 driver 中断

`4bb4fc6b` 的首次批已产生 6 次真实 Flash 请求，首个普通任务完成建目录、写两个 26 字节文件、回读、ls/wc/stat 和字节校验。driver 错等旧 `assistant_end` 事件，而当前原生链通过 `durable_delta.state.outcome=completed` 交付，因此在该场景中断并保留 `status=interrupted`。这不是完整六类批通过，也不作为产品失败；后续 driver 改为真实 Durable 状态/历史工具结果，禁止造出旧结束事件来通过断言。
