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


## 完整七场景真实批（3d0681c7）

48 次真实 Flash 请求；开始/结束源码指纹一致。原始结果是 **5 PASS / 2 FAIL**，没有追改报告。脱敏摘要及原报告哈希见 `evidence/issue21/live-3d0681c7.json`。

- 普通磁盘：两文件均为 26 字节，内容与来源完全一致，实际 read、bash 写入、ls/wc/stat、回读成功。原断言错误要求必须出现 `write` 工具，而模型使用合法的 bash 写入，所以原始 FAIL 属于 driver 误判。
- 公开检索：web_search 返回 5 个真实来源 URL。模型随后追加的 RFC 原文 fetch_content 被 URL-policy 拒绝：DNS 返回保留 fake-IP 地址，隔离 HOME 内没有既有 FlClash 受信配置。搜索成功不等于原文核验成功；原始 FAIL 保留，未放宽 allowRanges、复制私人代理配置、关闭 SSRF 或通过其他路径重试被拒网址。
- 普通内置浏览器：真实 navigate/read `https://example.com`，成功得到 Example Domain 标题与正文。
- 网络诊断：公开 curl 成功，故意关闭的本机端口返回实际 curl 退出码 7；没有变成共享资源隔离错误。
- Bot 表格分析与来源文档：两项真实派发、执行完成、回会话交付，均业务 `closed/succeeded`。4 个文件实际存在，重启后独立 DOM 快照确认 4 个打开文件按钮。即时 DOM 抽样为空，不能把该抽样说成已可见。
- 同一原生会话重启继续：新增回合有真实 read 和新回复，旧审批载荷未回放，SQLite 完整性通过。
- 旧 profile 注入 pending/queued/running outbox 与 host quarantine 后真实重启，专用表清除、Bot/task/Work 计数不变，SQLite quick_check 与外键检查通过。

## driver 后续修正与网络边界

新增零模型观察回归：只采本次提交后新增的持久回合；按实际成功工具和精确文件字节验收 bash/write；等待 Bot 消息真正可见；Bot 网页证据检查实际工具状态而不是在任意 JSON 中搜词。搜索与额外原文核验分列，后者失败会保留错误并使总结果标为 `passed-with-limitations`，不能当作全面通过。

`pinned-public-proxy` 安全专项覆盖公开 IPv4/IPv6、DNS 身份与私网混合答案、407 无后备路线、TLS 证书错误、非法输入零网络。此专项是受控测试，不构成被拒 RFC 网址已可访问的证明。没有改动任何地址安全检查或系统网络设置。

恢复后新增检查：durable-tool-policy、IPC inventory、pinned-public-proxy、architecture（278 项）、typecheck（web/node/scripts）、test-all 分类自检均通过。首次 durable-tool-policy 在默认 /tmp 创建 SQLite 时遇 IOERR_WRITE；改用约定的仓库外磁盘 TMPDIR 后通过，保留两次日志，未删除或掩盖首次失败。


## 修正驱动后的真实补测（de4ae9f4）

- 命令：`TMPDIR=<仓库外临时目录> WORK_ISOLATION_SNAPSHOT=de4ae9f477881708375a9d32f76319bcd91b606d pnpm -s test:work-isolation-live`。
- **7/7 PASS，39 次真实 Flash 请求**，源码指纹前后一致。脱敏证据：`evidence/issue21/live-de4ae9f4.json`。
- 普通磁盘、公开搜索、内置浏览器阅读、真实网络错误、Bot 表格分析、Bot 来源文档与同会话重启继续全部通过。两项 Bot 工作真实业务关闭成功，四份交付在 renderer 可见；另比对不可变交付副本与工作文件字节一致。
- 本轮公开搜索没有追加原文抓取。因此只证明搜索通过，**不撤销前批 RFC 原文 URL-policy 失败**，也不宣称该网址已恢复访问。
- 普通任务经真实 preload 提交、Durable 状态/历史观测；没有把它写成逐项原生聊天页面视觉验收。Bot 成果交付则另有真实 renderer 可见证据。
- 模型批自有 Electron/驱动结束后，再运行下述零模型输入专项，避免争用。

## Linux 实际输入补验（同一 de4ae9f4）

命令：`TMPDIR=<仓库外临时目录> node scripts/run-linux-computer-use.cjs --report-dir out/diagnostics/issue21-physical-input-20261112`。使用该源码的 `pnpm dev` 生成的既有验收资产，不 build/pack。

**23/23 PASS**，真实 Hyprland/Wayland、Electron 44.5.1 / Node 24.21.0、独立 Electron 与 GTK 靶窗，实际 1.6 缩放。证据：`evidence/issue21/physical-input-de4ae9f4.json`。

- 排队任务取消后，键盘输入未落到桌面。
- 真实按住时取消和超时均及时释放，只收到一对 DOWN/UP，无重放；实测按住分别约 75ms 和 665ms。
- worker 意外退出时释放自己按住的 Shift，旧引用失效，新 worker 恢复。
- 键鼠显式 down/up、拖拽、滚动、中文输入、窗口身份/坐标失效、应用重启均过。
- 核实报告内所有进程 PID 在完成后均已退出，再交还测试窗口。未修改监视器、缩放或系统安全设置。

这补上 Linux 真机输入证据，不等于 Windows、发行包或全部 GUI 通过；本轮仍未重跑完整 headless，采用相关专项与类型检查，未改失败基线。

## 主线集成收尾

发布前 rebase 到 `414bf2bf`，保留已合入的 UI、#26 上下文和 #28 历史召回修复。与实测本地快照 `de4ae9f4` 比较，本专项 BrowserAutomationService、退役迁移、相关测试和 live driver 文件无字节变化；真实批仍按原始实测 SHA/指纹记录，不追改成发布后的 SHA。

2026-11-12 02:39:36–02:39:48 UTC，在集成后的 main 再跑迁移 6 组、browser recovery、Linux backend 27 项、live observation 回归、typecheck web/node/scripts、harness 编译与测试分类 audit，全部通过。未为收尾重复跑完整 headless，也未修改失败基线。
