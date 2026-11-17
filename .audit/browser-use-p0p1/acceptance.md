# Browser use P0/P1 聚焦验收

Windows 上的当前源码已接入原清单的十二类能力，iframe 删除请求已取消，现有预览组件保持原状。可复跑入口与状态见 `requirements.json`，完整工具行为见 `docs/browser-tabs.md`。

| 能力 | 正式入口 | 关键证据 |
| --- | --- | --- |
| 嵌套同源、跨域 iframe | `frames`、`frameId` | 不同 renderer 进程中的可信点击、中文输入、上传、采集和 HTML5 拖放，失效文档拒绝 |
| 开放 Shadow DOM | 文档动作自动遍历 | 重名控件按范围隔离，slot 分配文本可定位 |
| 语义与 AX | `accessibility`、`find` | Chromium 名称与状态，带文档身份的精确引用 |
| 条件与业务断言 | `assert`、`expect`、`response` | 最后失败证据保留，点击回执与业务状态分别报告 |
| 文件 | `upload`、`download` | 服务端收到实际内容，下载字节与哈希，登记失败保留已发生动作 |
| 对话框 | `dialogRules`、`diagnostics`、`dialog` | 原生 prompt 字符串及 null；离开确认无系统阻塞，显式重试可立即继续 |
| 表格与列表 | `collect` | 分页、虚拟行、横向虚拟列、明确结束证据，超长结果有完整 JSON 产物 |
| 输入与拖放 | `click`、`fill`、`drag` | 双击、右键、修饰键、Unicode、日期、编辑器、真实源 DataTransfer、取消释放 |
| 标签与历史 | `open`、`select_tab`、`close`、`back`、`forward`、`reload` | 任务归属、同文档历史、真实销毁和拒绝关闭 |
| 诊断 | `diagnostics`、动作返回的 trace | 并发响应与下载归属，选择模式退出后订阅仍可用 |
| 浏览器坐标 | `screenshot`、`click_at`、`scroll_at` | 像素和完整文档树校验，canvas 改变、缩放和滚动拒绝旧截图 |
| 人工登录交接 | `handoff`、`resume` | 真实持久交互服务保持等待，猜测令牌拒绝，实际回答后签发，一次性只读核验 |

正式组合用例使用真实注册的 `browser_exec`、Durable Code Mode、Electron 和 ArtifactService。脚本模型提供确定的工具指令，用例验证工具执行链，不衡量模型自主规划质量。重开同一持久输入后，服务端提交和下载次数没有增加。`out/diagnostics/browser-p0p1/tool-bridge.json` 保存组合结果。

原有任务执行、标签 UI、刷新与截图回归也通过，截图用例为 64 项。`pnpm -s typecheck` 通过。新增测试已分类，`test-all --audit` 用于检查 Electron 用例没有混入 headless。

这些结果不是仓库全套或发行包验收。没有运行全量 headless、全量 GUI 或 ARTIFACT 门禁，也没有产品构建、打包、安装、提交和推送。没有在已登录的柠檬云账户或 Linux 桌面上执行验收。

已知边界是封闭 Shadow DOM、旋转或透视的 frame 几何和 pinch 偏移坐标。HTML5 拖放的源与目标属于同一所选文档。迟到的 beforeunload 接受不能恢复已取消的操作。Prompt 适配依赖经过形状校验的 Electron 内部处理器，升级 Electron 时必须重跑真实对话框测试。响应关联依据监听窗口与新请求身份，不证明事件因果。更多限制分别记在模块说明中。
