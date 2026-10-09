# 多模型会诊三处缺陷 · 修复与实测证据

日期：2026-10-09。基础提交：`a6ed8f4`。本文只写**实际跑出来的数字**，并明确区分「实测」「推断」「未验证」。

作者与来源说明：本文件由 Lead 本人整理。原计划的独立验证者（子代理 `consult-verifier`）连接崩溃 3 次，未能产出报告；因此本文件中的证据全部来自 Lead 亲自执行的命令与探针，不是第三方复现。相关基准（修复前代码）是直接从 git 取出的 `a6ed8f4:src/main/capabilities/MultiModelConsult.ts` 字节副本，与工作区改动对比运行。

## 结论摘要

| 症状 | 实测结论 | 关键证据 |
|---|---|---|
| 1. 点击参与模型出来的是贴左上角、占满高度的巨型模态框 | 已修复：真实渲染实测为 720×471 的居中浮窗，可拖动、可双击复位，窄视口回落横向标签条 | `test:consult-card-ui` 20/20；`RECT desktop {"left":312,"top":37.4,"width":720,"height":471.3,"viewportWidth":1344,"viewportHeight":935}` |
| 2. 某个模型死循环无法直接终结，导致空等 | 已修复：新增单参与者「终止」入口；600 秒超时配置下，运行中的死循环模型 **129 毫秒**被终止，兄弟模型照常完成 | 离线探针 `stop-probe`；`test:multi-model-consult` 新增 6 条 |
| 3. 「基于此发现继续调查」失效 | 已修复：失败/超时参与者不再禁用；`（undefined）` 状态文案消除；追加内容带报告 id 与真实工具记录 | `test:consult-card-ui` 中 complete / failed / interrupted 三种状态各一条 |

## 症状 1：浮窗几何

### 根因（实测）

- 旧 CSS 只声明 `width`/`max-height`，未重设 `margin`/`inset`/`height`；`src/renderer/src/styles/global.css:294-296` 的 `* { margin: 0 }` 清掉了 `<dialog>` UA 样式表的 `margin: auto`。
- 固定定位下 `inset: 0` + `height: auto` 会把元素拉伸到视口高度并贴住左上角，与用户截图（面板贴左、几乎占满高度、右侧一条遮罩）完全一致。

### 修复

`inset: auto` + `top: min(4vh,48px)` + `left: 50%` + `transform: translateX(-50%)` + `height: fit-content`，尺寸上限 `min(100dvh - 96px, 760px)`；标题栏可拖动（窗口级 `pointermove`/`pointerup`，保留至少 120px 在视口内、标题可达），双击标题复位；≤720px 时左列参与者列表变成横向标签条。

### 实测（真实 Electron 渲染进程，加载真实 `global.css` + 组件 CSS + 真实组件）

```
RECT desktop {"left":312,"top":37.39,"right":1032,"bottom":508.73,"width":720,"height":471.34,"viewportWidth":1344,"viewportHeight":935}
RECT narrow  {"left":20,"top":16.39,"right":400,"bottom":618.73,"width":380,"height":602.34,"viewportWidth":420,"viewportHeight":820}
```

- 桌面：水平中心 `(312+1032)/2 = 672 = 1344/2`，完全居中；高度 471 < 上限 760，说明按内容伸缩而不是拉满。
- 窄屏：宽 380 ≤ 420−40，右/下边界都在视口内。
- 拖动 160×90 后面板位移与预期一致（<3px 误差）且未越界；双击后回到原位置（<2px）。
- 截图：`out/tests/consult-card-ui/detail-desktop.png`、`detail-narrow.png`、`detail-dragged-and-recentred.png`。

## 症状 2：单模型死循环的直接终结

### 根因（实测纠正）

- **用户可见缺口**：单个参与者只能等 `timeoutSeconds`（默认 300 秒，上限 86 400 秒）或取消整场。没有「只终结这一个」的入口，这正是「无法直接终结，导致空等」。
- **初版假设被证伪**：我原本判断「旧代码 `await session.dispose()` 无上限导致永久挂住」。用 `a6ed8f4` 的字节副本实测：`prompt()` 忽略 abort 且 `dispose()` 返回永不 resolve 的 Promise 时，旧代码 **204 毫秒**就返回了——因为旧代码根本没有 await `dispose()`。所以「dispose 卡死」不是空等的根因，真正的坏处是清理未收敛被**静默当成成功**。

### 修复

1. `closeConsultSession` 的 `abort` 与 `dispose` 各自有界（各 2 秒），整体清理再有 3 秒宽限看门狗；超限写进 worker 终态错误，被放弃的后台清理不得再改写已终态结果。
2. `onControls` 交出 `stopWorker(index)` → `AgentService` 用 `${taskId}:${consultId}` 登记 → `agent:stopConsultWorker` IPC → preload → 渲染层。卡片每行与详情面板都有「终止」；未启动的参与者被终止后永不启动；已终态参与者终止返回 `false` 且不改动报告。

### 实测（对抗性探针，修复前 vs 修复后同一组假会话）

| 场景 | 修复前 `a6ed8f4` | 修复后工作区 |
|---|---|---|
| prompt 挂起 + abort 正常 + dispose 永不收敛 | 204 ms 返回，清理失败被静默吞掉 | 2 222 ms 返回，worker 记 `会话释放超时（超过 2000 毫秒未收敛）` |
| prompt 挂起 + abort 与 dispose 都永不收敛 | 2 215 ms 返回 | 3 212 ms 返回，记 `会话中止超时`，整体有界 |
| 健康会话（对照） | 0 ms，`complete` | 1 ms，`complete` |
| 取消后晚到的 session | 948 ms 返回，`created=1 disposed=1` | 948 ms 返回，`created=1 disposed=1` |

代价说明（实测，不是估计）：健康路径零额外延迟；只有 `dispose()` 永不收敛的病态传输会多等约 2 秒，换来「清理未收敛」可见且整体有界。

单参与者终止实测（探针 `stop-probe`，配置 `timeoutSeconds: 600`）：

- 运行中的死循环参与者：`accepted=true`，**129 ms** 结束，状态 `cancelled`，原因 `用户终止该模型（未完成）`；兄弟参与者 `complete`，报告 `degraded`，`created=2 disposed=2`。
- 排队中的参与者：`maxParallel: 1` 下停止第 2 个 → `startedModels=["provider/loopingA"]`，第 2 个**从未启动**，状态 `cancelled`。
- 已终态参与者：`stopWorker(0)` 返回 `false`，worker JSON 前后完全一致；越界下标返回 `false`。
- 父取消优先：报告 `cancelled`，全部参与者终态，`created === disposed`。

## 症状 3：继续调查

### 根因

- `disabled={!worker?.answer || activeTaskId !== report.taskId}`：失败/超时参与者（`answer` 为空但有 `error`）直接变灰，没有任何解释。
- 追加文案用 `STATUS[worker.status]`，而展示用 `status()`；`interrupted`（工具已终态、报告仍 `running`）时前者对 `running`/`queued` 得到 `undefined` → 用户看到「（undefined）」。

### 修复

状态映射改为全覆盖（未知状态显示「状态未知」）；只有「既无回答也无失败原因」或「属于其它任务」才禁用，并给出说明文字；追加内容包含报告 id、参与者模型/思考等级/状态、原始答案或失败原因、真实工具记录摘要（工具名+参数+输出预览）；追加后卡片显示确认提示，不自动发送。

### 实测（真实渲染，逐字检查追加文本）

- 已完成参与者：可点；追加文本含 `tool-consult-1`、`google-vertex/gemini-3.8-flash`、`已完成`、`vat-accounting.ts`；不含 `undefined`。
- 失败参与者（429）：可点（修复前为 disabled）；追加文本含 `glm/glm-5.3-flash` 与 `429`；不含 `undefined`。
- interrupted 报告：参与者标签显示「已中断」；追加文本含「已中断」；不含 `undefined`。
- 其它任务的会诊：按钮禁用并提示切回原任务（防止把别的任务的结论灌进当前输入框）。
- 追加后卡片出现「已把 … 追加到输入框」提示。

## 回归与门禁

| 命令 | 结果 |
|---|---|
| `pnpm -s typecheck` | 通过（web + node 两个 tsconfig） |
| `pnpm -s build` | 通过（`✓ built in 29.46s`） |
| `pnpm -s test:multi-model-consult` | 通过（新增 6 条：终止控制先于启动存在 / 运行中终止不等超时 / 终止不影响兄弟 / 排队中终止后永不启动 / 已终态 no-op / 清理不收敛有界） |
| `pnpm -s test:consult-card-ui`（新增） | 20/20 通过 |
| `env -u ELECTRON_RUN_AS_NODE pnpm -s test:consult-entry:desktop` | 8/8 通过（真实桌面、隔离配置、不发真实模型消息） |
| `pnpm -s test:all` | 见下节 |

## 未验证 / 边界（不得当作已完成）

- **未**运行 `test:multi-model-consult:live`（需要真实供应商认证、产生真实用量）。所以「真实模型陷入死循环时点终止立刻结束」没有在真实供应商上端到端验证；已验证的是运行时逻辑（对抗性探针）与渲染层到 IPC 的载荷（真实渲染测试）。
- 拖动手感只在真实 Chromium 中用合成指针事件验证，没有真人评估。
- 新增的 `test:consult-card-ui` 依赖本机桌面会话（隐藏窗口）；它已进入 default 门禁，Gate 会删除 `ELECTRON_RUN_AS_NODE`，因此可无头运行；但无桌面会话的 CI 上仍会失败，属于本仓库既有的 GUI 用例类别。
- 打包版本里「会诊卡片详情」无法在无真实模型的情况下被驱动（卡片只有真实 `multi_model_consult` 调用后才出现），因此打包验收覆盖的是：asar 内含本次改动的构建产物 + 打包应用的会诊入口/设置/输入框全链路。真实模型下的浮窗外观仍需用户实机确认。

## 发布记录（0.1.21）

- 提交与推送：`9f246fb fix(consult): floating detail panel, per-participant terminate, working follow-up` → `origin/main`（`cb2887a..9f246fb`）。同分支另外两个提交 `d86d455`（清理 0.99.x 遗留产物与该一次性升级工具链）与 `3042de8`（另一位贡献者把所有工作树内容一次性提交，其中包含本次改动的中间版本）不是本次任务产生的，已一并随分支推送。
- 打包：`pnpm -s dist` 的 **NSIS 目标失败**（`release\MyBuddy Setup 0.1.21.exe` exit 2），因此沿用 0.1.20 已接受的约定改用 unpacked 产物：
  `npx electron-builder --win --dir --config.directories.output=release-mybuddy-0.1.21` → 成功。
- 接受的产物：`release-mybuddy-0.1.21\win-unpacked\MyBuddy.exe`，`FileVersion 0.1.21` / `ProductVersion 0.1.21.0`，SHA256 `6229E27E534D8B7552BBA80BE756E2EA6AE008645E82567816F825AF4D4D5C9F`；`resources\app.asar` SHA256 `F1CA54312E5C3757875E4F416122FBE58DBC1B0C8D48AB38E58C5CDB8DFC8A69`（175 486 126 字节）。记录写入 `artifacts/mybuddy-0.1.21-release/accepted-build.json`。
- asar 内容核验（`utf8` 读取）：`stopConsultWorker`、`requestWorkerStop`、`CONSULT_CLEANUP_GRACE_MS`、`用户终止该模型`、`consult-followup`、`基于这一发现…`（实际为 `基于此发现继续调查`）、`height: fit-content` 全部 FOUND。
- 打包应用实机验证：`CONSULT_ENTRY_TEST_EXE=release-mybuddy-0.1.21\win-unpacked\MyBuddy.exe pnpm -s test:consult-entry:desktop` → 8/8 通过（隔离 profile，真实窗口 + 渲染进程 + IPC）。清理旧版本目录后再次运行仍 8/8，exe 哈希不变。
- 快捷方式：开始菜单 `MyBuddy.lnk` 就地更新；桌面新增 `MyBuddy 0.1.21.lnk` 并删除会悬空的 `MyBuddy 0.1.20.lnk`。备份在 `artifacts/mybuddy-0.1.21-release/shortcut-backups-20261009-161649/`。回读确认 Target/WorkingDirectory/Icon 均指向 0.1.21 且目标存在。
- 只保留一个已接受发布：确认无进程占用、无快捷方式引用后，删除 `release-mybuddy-0.1.20` 与失败的 `release`（含 353 MB 中间产物）。

