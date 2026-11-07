# Bot / Work Phase 3 边界加固复核

日期：2026-11-07。代码起点为 `main@7f38683a7694f8704d4280a3c0590cfa5293e421`，保留 Phase 3 原实施范围。本轮只修复恢复、焦点和交接结果边界；不开始 Phase 4，不改变 Pi 1.5.0 pin、lockfile、应用版本或 schema 数据字段。

修复实现冻结提交：[`671574ab8e5bfddbdce6e97866c82c6775623ee7`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/671574ab8e5bfddbdce6e97866c82c6775623ee7)（`fix(bot-work): fence recovery attempts and preserve handoff receipts`）。本报告单独提交，仅补充复核记录，不再修改已验证的源码。

## 源码事实校正

- 原 `WorkResourceRecovery` 每个探针的超时为 **4,000 ms**，不是 3,000 ms。原 Promise race 不会取消仍在运行的底层探针。
- 原耗尽 SQL 在自增之前判断 `attempts >= 4`，实际会允许第五次失败；`wakeWork()` 还会隐式清零重试次数。两者都需要收口，不能只添加页面按钮。
- 原 `handoffOwner()` 已在同一个 SQLite 控制事务中更新 owner/epoch 和写入有效委派 adoption，正常路径不存在提交后等待新负责人另外插入 adoption 的窗口。本次新增第二 SQLite 连接观察及事务故障回滚用例，明确保护这一事实。
- 原 Windows 失败证据来自 `ShellExperienceHost` 通知浮层。`Windows.UI.Core.CoreWindow` 同时可能属于普通应用，不能仅凭 className 注入 Escape。
- 交叉复核还发现，原 Windows 工厂用 `waitForIdle()` 代替输入释放证明。原生 `key_down` / `mouse_down_client` 会保留按压，队列清空和宿主退出不能证明已经发送 UP；本轮禁止这种虚假的 `inputReleased` 回执。

## 本轮修改

### 恢复超时、取消与代次

恢复开始前持久认领单调 attempt，向 `inspectExecution`、`drainInput`、`verifyEffect` 传入相同的 `{ token, attempt, signal, assertCurrent }`。探针超时后取消本轮，并拒绝过期代次提交结果。尚未退出的原始探针继续保留在途屏障；在它退出之前，同一资源不能开始下一轮核对，也不能经人工重试绕过屏障。

每组自动核对限制为四次。正常调度唤醒不再重置耗尽状态；人工重试只开放下一组预算，attempt 不倒退。恢复仍需原执行及 owned children 静默、后端队列清空与本驱动输入释放回执、原外部效果确认，才能在同一业务事务中释放隔离资源。不重复原业务动作。

### 人工重新核对

Work 详情显示持久化的隔离核对状态与原因；耗尽时提供环境安全确认复选框和“重新核对隔离资源”按钮。请求通过严格 `phase3Control` schema、已认证 user 身份、宿主 authority、Work 版本守卫，以及精确的 token/attempts/exhaustedAt 校验。完整原请求与 operationId 支持幂等回执。

确认只重开核对，不直接释放锁、不恢复暂停的 Work、不创建 Task、不增加业务预算。过期的业务授权不阻止用户核对原操作的安全清理。第四次探针开始时会先记满预算；页面会区分仍在途的核对，待其真正退出后才提供重试。恢复状态独立变化会进入现有 projection journal，因此重连客户端可以看到耗尽/重试状态。新增触发器使用条件插入 stream，避免 SQLite 外层 UPSERT 的冲突策略覆盖触发器中的 `INSERT OR IGNORE`。

### Windows 焦点浮层处理

仅在原生层明确证明目标输入尚未开始、前台属于受支持的系统浮层、目标窗口身份仍匹配时尝试一次安全 Escape。判断组合使用窗口 class、进程身份、系统目录下的可执行文件路径和当前前台快照；普通 CoreWindow、伪装进程路径、无证据的 `FOCUS_FAILED` 不进入此路径。

单次执行（含 batch 和外层恢复）共用一次尝试预算，迟到或丢失回执不增加预算。恢复期间保留原观测的 HWND/PID/class 与几何证据，窗口变化、DPI 变化、取消和已发生的输入均不能通过刷新快照获得重放许可。不会强制最小化普通用户窗口。

Windows 原生宿主按任务记录 `SendInput` 实际接受的按压边沿，回执绑定原宿主实例和控件集合。清理与执行共用串行队列，只对原驱动确认持有的控件发送 UP，并检查完整释放回执。不能用新宿主的空账本证明旧宿主的输入已释放；未知输入、丢失回执和无法确认的宿主切换保持隔离。

### 交接迟到成果

同一要求/输入、未撤销且来自旧 owner epoch 的原始回执，如果缺少当前 adoption，则保留在原 `work_native_inbox`，标明 `pending_adoption`。原生终态和真实用量可结算一次，成果及子项发布、验收和补跑等待有效接纳。恢复接纳后在原 Work 的事务内消费保留回执，不重新启动 Worker，也不重复记账。

真实交接继续原子写入 adoption；显式失效、`invalidatedAt = 0`、单独 invalidated 状态、旧要求和旧输入均不会被接纳成当前成果。取消时清理待接纳阻碍，保留历史事实并完成原结算，避免卡在 closing。

## 验证口径

本轮执行环境为 Linux / Node 24 / Pi 1.5.0。测试使用与当前 lockfile 完全一致的既有依赖，未改失败基线。自动测试中的 SQLite、原生 Pi 和模拟驱动证据分别记录；模拟 Windows RPC 不等于真实 Windows 桌面验收。

真实 Windows `BW-A31`、Linux/Omarchy 原生输入、移动端和发行包仍需各自环境验证，不能因 headless 用例通过就标记平台验收通过。

### 本环境与原始提交的对照

初次完整 headless 门禁为 333 通过、6 失败。其中 `WorkService` 行数超过架构门禁是本次新增问题，已通过独立的 `WorkResourceRecoveryControl` 模块拆分，架构五项检查重新通过。其余五项在未修改的 `7f38683` 归档、相同 lockfile/依赖上均能复现：

- `image-resize-assets`、`oauth-bundle`、`pi104-features` 缺少 `out/main` 前置资产。在实际 `pnpm dev` 生成开发输出后，三项均重新通过；没有启动发布 build/pack/dist。
- `ipc-channel-inventory` 所需的 `artifacts/ipc-channel-baseline.json` 在原提交中没有被跟踪，且 `/artifacts/` 被忽略。只在原始 `7f38683` 归档中生成该清单，再与当前源码完整报告逐项对比一致后，用作当前 checkout 的本地前置资产。main 注册点 484、全仓 495、唯一通道 484，新增/删除通道均为空。清单 SHA-256 为 `04b0d8cfe2069cc54e7f8cfc13ed08ca38c0702f23109b1c8d5afaf2b1319370`；未从修改后的源码重写接受基线，未改任何测试失败白名单。
- `atspi-transport` 在创建第一个 private D-Bus 时失败，错误为 `Failed to open socket: Operation not permitted`。最小探针确认 `socket(AF_UNIX, SOCK_STREAM)` 本身即返回 `EPERM`，路径 socket 和 abstract socket 均相同。该阻碍发生在使用 worker 资产之前，不能通过更换临时目录解决。

实际尝试了隔离用户配置的 `pnpm dev`。首次触及 Node 默认堆上限；将本次进程堆额度提高至 6 GiB 后完成开发编译，但 Electron 在 `process_singleton_posix.cc` 的 `socket()` 上同样遭遇 `EPERM`，未能进入页面。新增恢复 UI 的 React 渲染用例与后端控制事务用例分别通过，不据此冒充 preload/IPC 实机联调通过。dev 测试脚本保留 Linux 显式 headless 模式和本次按钮验证，便于在具备所需能力的环境重跑；它也会精确清理本次测试的 Electron 主进程。

## 最终门禁

最终验证绑定相对 `7f38683a7694f8704d4280a3c0590cfa5293e421` 的 42 个源码、脚本及 `package.json` 改动文件。现有 `scripts/bot-work-phase3-source-evidence.mjs` 生成的源码 SHA-256 为：

`c7b206da7feea9fe7a4a8d22b8a4009bf086d5e46677bf4a87dcec29cd7238e2`

此指纹不包括本报告；测试后未继续修改源码。

| 验证 | 实际结果 | 证据边界 |
| --- | --- | --- |
| `pnpm -s typecheck` | **通过** | Web、main、scripts；scripts 错误 0，基线 0，新增 0 |
| `node scripts/test-all.mjs --audit` | **通过** | headless 339、GUI 54、NETWORK 29、DATASET 2、pending 0；没有 Electron 用例混入 headless |
| `pnpm -s test:all` | **338 通过、1 失败，退出码 1** | 唯一失败为 `test:atspi-transport` 的 socket `EPERM`；已知失败基线为 0，runner 因此仍打印“新增回归 1”，没有将它加入白名单。未修改的原始提交同样复现 |
| Phase 3 九项 headless 专项 | **全部通过** | resource-gate、focus-gate、partial-settlement、pause-backlog、collaboration、handoff、native-settlement、recovery-control、resource-settlement；包含在最终全量中 |
| `test:computer-automation`、`test:computer-use-run`、`test:computer-use-boundaries` | **全部通过** | 最终 Windows backend/helper 代码配合模拟 native RPC；不构成 Windows C#/PowerShell 或真实键鼠验证 |
| `test:linux-native-backend`、`test:linux-native-outcomes` | **全部通过** | 后端契约与取消/清理行为测试；不构成 Omarchy 原生桌面验收 |
| `test:bot-workspace` | **通过** | React 实际渲染耗尽卡片、确认前禁用按钮、仍在途时禁止重试；后端权限及事务另由 recovery-control 验证 |
| 本轮 `test:bot-work-phase3:dev` 尝试 | **受阻，未进入页面** | 开发编译完成后 Electron singleton socket `EPERM`；不能标记真实页面、preload/IPC 或桌面焦点验收通过 |
| `git diff --check` | **通过** | 无空白错误 |

因此，本轮没有获得“全量门禁 0 失败”或“真实 Windows BW-A31 已通过”的证据。修复专项通过，剩余平台阻碍按上文原样保留。

用户已明确授权修复并推送 GitHub。遵循仓库规则直接更新 `main`，不新增分支或 worktree，不执行发布 build/pack/dist，不升级应用版本。
