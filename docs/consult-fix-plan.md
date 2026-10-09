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

- `src/main/capabilities/MultiModelConsult.ts:284`：`await abortable(session.prompt(prompt), controller.signal)` —— 取消能让这个 await 立刻返回，但 `finally`（同文件 295-309）随后 `await closeConsultSession(session)`。
- `closeConsultSession`（同文件 157-168）：`session.abort()` 只给 2 秒上限，但紧接着 `session.dispose()` **没有任何上限**；卡死的传输层会让 `dispose()` 永不返回。
- 因为 `Promise.all` 在 311-314 行等待所有 worker，一个卡死的 `dispose` 就会让整个 `runMultiModelConsult` 挂住 → 主模型工具调用永不结束 → 界面「空等」，且点「停止生成」也不会结束它。
- 相关补充：`runWorker` 里 `session` 只在 `await abortable(creating, ...)`（248 行）之后才赋值。若 `createSession` 卡住，取消时 `abortSession()`（232 行）拿不到 session（要等 `creating` 自己 settle）；返回路径上的 `closeConsultSession(created)`（241 行）同样可能卡在 `dispose()`。离线用例 `hung session creation does not block timeout`（`scripts/multi-model-consult-test.ts:134-136`）只覆盖「timeout 到点后立即返回」，没有覆盖「创建晚到后的清理卡死」。

修复方向：

1. `closeConsultSession` 的 `dispose()` 也纳入有界等待（用 `abortable` + 短超时）；把「清理超时」写成 worker 的终态错误，而不是让整个 fan-in 永久挂起。
2. 给每个 worker 增加独立看门狗：一旦 worker 进入终态（完成/失败/超时/取消），超过宽限期仍在清理，就判定 settled，清理继续在后台收敛，不再阻塞 `Promise.all` 与报告结束。
3. 让 `session` 尽早可见（即使晚到的创建也会被立即清理），避免取消语义在「创建中」阶段失效。
4. 终态保证：参考同文件 128-141 行（`abortable`）与既有离线测试「a prompt ignoring abort cannot trap the fan-in」，新增「dispose 卡死也不能让会诊永不结束」的离线用例。
5. 界面配套：会诊卡片在报告未终态时提供「只结束等待」入口（主任务停止按钮必须依然有效），并把“已停止等待/后台清理中”明确写成状态，而不是继续显示「分析中」。

## 症状 3：「基于此发现继续调查」失效

证据：

- 按钮依赖 `src/renderer/src/components/chat/MultiModelConsultCard.tsx:71` 的 `disabled={!worker?.answer || activeTaskId !== report.taskId}`。
- 点击后调用 `useAppStore.getState().appendComposer(...)`（同文件 73 行），写入 `composerInsertion`，由 `ChatInput.tsx:279-288` 消费并 focus。
- 失效的两种可复现路径：
  1. `worker?.answer` 为空（例如该 worker 失败/超时，或用户在流式过程中打开详情并选中首个失败模型）→ 按钮 disabled，用户看到「点了没用」。
  2. 主任务仍在执行、或会诊报告本身还停留在 `running`（症状 2 的空等）时，追加的文本进入 follow-up 队列被压住，或被后续 `abortActiveTask()` 本地清流式判定为“已停止”而不发送 → 内容看似消失。
- 另外「继续调查」只做了纯文本追加，没有携带稳定的证据引用；用户无法从输入框看出它引用了哪一次会诊的哪一位参与者，也无从校验。
- 次生 bug：`MultiModelConsultCard.tsx:73` 的 `STATUS[worker.status]` 与 `MultiModelConsultCard.tsx:29` 的 `status()` 不一致。当 `interrupted`（工具调用已终态但报告仍是 `running`）时，`status()` 会显示「已中断」，但追加文本里写的是 `STATUS[worker.status]`，对 `running`/`queued` 渲染为 `undefined`，用户看到的文本是「（undefined）」。

修复方向：

- 禁用条件收敛为「没有该参与者的任何可引用内容」；失败/超时的参与者应把错误与已有部分答案作为可继续调查的材料，而不是整个按钮变灰。
- 点击后给出明确反馈（追加成功提示 + 聚焦），并在报告未终态或以任务仍在执行时，明确告知会进入下一轮/仍受当前执行约束，而不是静默追加。
- 追加内容包含：会诊报告 id、参与者模型与思考等级、状态、原始答案（或失败原因）、以及该参与者真实工具记录摘要，便于主模型核验而不是空口继续。

## 验收标准

- 离线契约：`pnpm -s test:multi-model-consult` 新增用例覆盖「dispose 卡死仍有界结束」「取消清理有界」「失败参与者仍可继续调查」。
- 类型与构建：`pnpm -s typecheck`、`pnpm -s build`。
- 真实桌面回归：`consult-entry-electron-test` 扩展为覆盖详情浮窗布局与继续调查点击；结果写入 `out/tests/consult-entry/results.json`，截图留档。
- 门禁：`pnpm -s test:all` 不得出现新增失败（基线仅 `test:project-agent`）。
