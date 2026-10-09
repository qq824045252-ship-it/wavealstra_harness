# 多模型会诊三处缺陷 · 证据与修复计划

日期：2026-10-09。结论基于源码阅读与实证（离线契约测试、Electron 隔离配置回归），不基于推测。

## 症状 1：点击参与模型 = 巨型居中模态框（UI 丑、非自由浮窗）

证据：

- `src/renderer/src/components/chat/MultiModelConsultCard.tsx:21` 使用 `dialog.current?.showModal()`。
- `src/renderer/src/components/chat/MultiModelConsultCard.css:13-15`：`.consult-dialog { width: min(900px, calc(100vw - 32px)); max-height: min(860px, calc(100dvh - 40px)); }` + `.consult-dialog[open] { display: flex }`。
- `<dialog>.showModal()` 由 UA 样式表居中并置于 top-layer，任何作者级 `margin` 都压不过 UA 的 `margin: auto` 定位；页面里也没有任何 `.consult-dialog` 的 margin 覆盖。
- 结果：整屏遮罩 + 多个模型用横向 tab 挤在一排，窄窗口下进一步压缩答案区。

修复方向（对齐产品自身已有的 dialog 视觉语言 `global.css` 的 `--surface-elevated / --radius-lg / --shadow-lg / --overlay`）：

- 保持 `<dialog>` + `showModal()`（原生焦点陷阱、Esc、top-layer 语义不变），在对话框内自绘标题栏，并显式设置 `margin: auto`，让尺寸只占视口一部分。
- 尺寸收紧为约 720px；模型列表改为左侧竖向列（每个参与模型一行，显示模型名、思考等级、状态、耗时、tokens），右侧为答案与工具记录；窄视口（≤720px）回落为横向 tab，保持可用。
- 视觉细节：标题栏 sticky、`X` 关闭按钮统一为 `.btn` 语言、答案区等宽 `pre` 保留原文字节、工具记录用现有 `details` 样式。

## 症状 2：模型死循环无法直接终结，导致空等

证据（主进程）：

- **真实的用户可见缺口**：单个 worker 只能靠 `config.timeoutSeconds`（默认 300 秒，设置上限 86 400 秒）或整场取消结束。一个模型陷入循环时，用户只能眼睁睁等它超时，或者按主输入框的「停止生成」把**所有**参与者（包括已经跑完的）一起取消。没有「只终结这一个模型」的入口 —— 这就是用户说的「无法直接终结，导致空等」。相关代码：`src/main/capabilities/MultiModelConsult.ts` 的 `runWorker` 只有 `stop()`（超时/父取消触发），没有任何外部可达的单 worker 终止路径。
- **清理路径本身（初版分析有误，已用实测纠正）**：`closeConsultSession`（原 157-168 行）里 `session.abort()` 有 2 秒上限，而 `session.dispose()` **没有被 await**（只是同步调用、返回值被丢弃）。用修复前代码（`a6ed8f4`）跑对抗性探针实测：`prompt()` 忽略 abort 且 `dispose()` 返回永不 resolve 的 Promise 时，整场会诊 **204 毫秒**就返回了 —— 也就是说，单靠「dispose 永不 resolve」并不能让旧代码永久挂住。真正的坏处是**静默**：清理没有收敛却被当成成功，异常不会出现在报告里。
- 因此本次把 dispose 纳入有界等待属于**加固**（可见性 + 有界性），不是「空等」的根因；根因是缺少单 worker 终止入口。

修复方向：

1. `closeConsultSession` 的 `dispose()` 也纳入有界等待（复用 `abortable` + 短超时）；把「清理超时」写成 worker 的终态错误，而不是被静默吞掉。实测代价：健康的会话仍是 0–1 毫秒；只有 `dispose()` 永不收敛的病态传输会多等约 2 秒（有界，且会明确报告）。
2. 给每个 worker 增加独立看门狗：一旦 worker 进入终态（完成/失败/超时/取消），超过宽限期仍在清理，就判定 settled，清理继续在后台收敛，不再阻塞 `Promise.all` 与报告结束；被放弃的后台清理不得再改写已终态的报告。
3. 让 `session` 尽早可见（即使晚到的创建也会被立即清理），避免取消语义在「创建中」阶段失效。
4. **新增单参与者直接终止**：`runMultiModelConsult` 通过 `onControls` 交出 `stopWorker(index)`；`AgentService` 用 `${taskId}:${consultId}` 登记，经 `agent:stopConsultWorker` IPC 暴露给渲染层；卡片每一行与详情面板都提供「终止」。终止只结束该模型（状态 `cancelled` + 原因「用户终止该模型（未完成）」），兄弟模型与已收到结果保留。
5. 终态保证：新增离线用例覆盖「运行中直接终止」「排队中终止后永不启动」「已终态终止是 no-op」「清理永不收敛仍有界返回」。

## 症状 3：「基于此发现继续调查」失效

证据：

- 按钮依赖 `src/renderer/src/components/chat/MultiModelConsultCard.tsx:71` 的 `disabled={!worker?.answer || activeTaskId !== report.taskId}`。
- 点击后调用 `useAppStore.getState().appendComposer(...)`（同文件 73 行），写入 `composerInsertion`，由 `ChatInput.tsx:279-288` 消费并 focus。
- 失效的可复现路径：`worker?.answer` 为空（例如该 worker 失败/超时，或用户在流式过程中打开详情并选中首个失败模型）→ 按钮 `disabled`，用户看到「点了没用」，且没有任何解释。
- 次生 bug：原 `MultiModelConsultCard.tsx:73` 的 `STATUS[worker.status]` 与同文件 `status()` 不一致。当 `interrupted`（工具调用已终态但报告仍是 `running`）时，`status()` 显示「已中断」，但追加文本里写的是 `STATUS[worker.status]`，对 `running`/`queued` 渲染成 `undefined`，用户看到的是「（undefined）」。
- 追加内容只引用「模型 + 思考等级 + 状态」，没有报告 id，也没有该参与者真实工具记录，事后无法定位是哪一次会诊、依据是什么。

修复方向：

- 禁用条件收敛为「该参与者既没有回答也没有失败原因」，或「该会诊属于其它任务」；后两种情况给出明确说明文字，而不是让按钮无声变灰。
- 修掉 `undefined` 状态文案，改用同一个 `status()`。
- 追加内容包含：会诊报告 id、参与者模型与思考等级、状态、原始答案或失败原因、以及该参与者真实工具记录摘要（工具名 + 参数 + 输出预览，均取自报告、不改写）。
- 追加后给出可见反馈（卡片上的提示条），不自动发送。

## 症状 1 的补充：为什么旧面板会贴到左上角

- `<dialog>.showModal()` 的居中来自 UA 样式表的 `margin: auto`；而 `src/renderer/src/styles/global.css:294-296` 的 `* { margin: 0 }` 把它清掉了。
- 旧 CSS 只声明了 `width: min(900px, calc(100vw - 32px))` 与 `max-height`，没有重设 `margin`/`inset`/`height` → 元素保持 `inset: 0` + `height: auto`，在固定定位下被拉伸到视口高度，并贴住左上角。用户截图（1344×821）里正是这个形态：面板贴左边、几乎占满高度、右侧留一条遮罩。
- 修复：作者级重设 `inset: auto` + `top/left` + `transform: translateX(-50%)` + `height: fit-content`，并支持拖动标题移动、双击标题回到居中。


## 验收标准

- 离线契约（`scripts/multi-model-consult-test.ts`）：新增 6 条 —— 实时终止控制在首个参与者启动前就存在、运行中直接终止不必等超时、终止一个参与者不影响兄弟与报告、排队中终止后永不启动、已终态终止是 no-op、清理永不收敛仍有界返回。
- 真实渲染回归（`scripts/consult-card-ui-test.cjs`，`test:consult-card-ui`，共 20 条）：浮窗几何（视口内、按内容高度、居中、窄视口回落、可拖动/双击复位）、三种参与者状态下的「继续调查」、以及单参与者终止的 IPC 载荷。
- 类型与构建：`pnpm -s typecheck`、`pnpm -s build`。
- 真实桌面回归：`env -u ELECTRON_RUN_AS_NODE pnpm -s test:consult-entry:desktop`（隔离配置、不发真实模型消息）。
- 门禁：`pnpm -s test:all` 不得出现新增失败（基线仅 `test:project-agent`）。

## 明确未覆盖 / 仍需真实模型的部分（不得谎称已验证）

- 没有跑 `test:multi-model-consult:live`（需要真实供应商认证与计费）。因此「真实模型死循环时点终止立刻结束」只在离线对抗性探针与真实渲染 IPC 层验证过，未在真实供应商上端到端验证。
- 拖动面板只在真实 Chromium（Electron 渲染进程）中用合成指针事件验证；未做真人手感评估。

