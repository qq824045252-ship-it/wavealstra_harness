# Coding Tags、poteto 路由与独立 Thermos 开关

日期：2026-11-25。基于 `8b463bb426d8f1a3bc3849d21a8d0c629bdf4548` 的 pstack 0.15.48 原生接入继续调整。未修改版本号，未构建或发布安装包。

## 本次决定与实现

- Thermos 原本已有独立开关。将唯一的 `skills["thermo-nuclear-code-quality-review"].enabled` 控件移到设置顶部，与 pstack 总开关并列；总开关改名为“启用 pstack 工作流”。关闭 Thermos 保留 poteto、正常验证、其他方法和已保存阈值，总开关往返不会把 Thermos 自动打开。
- Thermos 开关与参数保存后用于新任务。已有会话及工作流保留启动时的配置，界面明确说明这一点。
- 出厂 coding Tags 只保留 `minimal` 和 `web-html`。HTML 提供页面文件与浏览器验证指引，不附加权限、专家白名单或固定 feature 路由。
- 修 Bug、重构、代码审查、方案设计、只读解释的旧 ID 退役。仅在 coding 模式下将退役 ID 解析为当前 minimal 配置，包含用户对 minimal 的定制；自定义标签、同名自定义 HTML 和任务历史保留。未知自定义 ID 仍回落基础策略。
- 将所有运行时、预览、建议配置、关联任务和加载项解析统一到带模式的 preset 解析入口，并修复历史空任务的欢迎页文案与 Tag 选中态。
- poteto 自动入口返回实际启用的方法、剧本及路由指引，明确 `started: false`，不会写工作流状态或工作区基线。模型选择具体流程后才启动。普通聊天和按需理解代码仍可直接回复。
- 单独关闭 poteto 后，不再读取它的默认剧本和 GitHub 强制绑定参数；其他明确选择的启用方法仍可使用。
- 独立 Thermos 可以交付有实际读取回执支持的负面审查报告，不强迫修复源码，也不要求主代理重复读取来补证据。
- 旧的在途只读工作流及独立 Thermos 保留严格只读边界：原生写入、命令执行和写入型子代理都会被拦截；只读角色仍可实际读取。启动新的已授权实现流程后，父代理及子代理恢复正常写入能力。
- 修复隔离审查者读取证据的路径映射：宿主分配的 worktree 中的真实读取映射回项目相对路径，继续检查原生身份和文件摘要。真实 worktree Thermos 负面审查已经完整跑通。

使用步骤和开关位置见 [pstack 使用说明](../pstack-mybuddy.md)。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| Web、Node、scripts 类型检查 | 通过；scripts 0 错误、0 新增错误。最后的 Hook 和回归夹具另经 Node、scripts 检查。 |
| `TLA2TOOLS=... node scripts/test-all.mjs --filter=pstack --jobs=2` | 11 passed、0 failed、0 新增回归，约 1 分钟；包含真实 TLC、媒体、隔离执行与新的开关测试。 |
| `test:local-workflow` | 最终实现下通过，90 秒。包括退役 Tag 的真实写入及写入型子代理、minimal/HTML 自动导航、独立 Thermos 负面报告、Thermos 关闭时的隔离 Interrogate，以及 poteto 单独关闭。 |
| `test:mode` | 91 passed、0 failed。 |
| `test:mode-preset` | 216 passed、0 failed。包含配置读写重开、定制 minimal、同名 HTML、自定义 Tag、跨模式及历史保留。 |
| `test:project-template` | 通过。 |
| `test:minimal-coding-mode` | 8/8 通过。 |
| `test:preset-editor` | 64 passed、0 failed。 |
| `test:hero-suggest` | 91 个断言通过。 |
| `git diff --check` | 通过。 |

开关测试使用真实 React checkbox 事件，覆盖关闭、总开关往返、序列化、重挂载、阈值保留和保存期间禁用。Electron 设置窗口的 IPC 夹具也已更新，但当前环境没有显示服务，本次没有运行原生窗口验收，不将其记为通过。

## 保留并明确报告的既有失败

本次没有修改测试失败基线来隐藏结果，也没有运行全仓库完整测试集。

- `test:architecture`：277 passed、2 failed。两项仍是此前确认的旧问题：办公模式预设数量硬编码为至少 6，以及 AgentService 入口的源码字符串断言。与本轮 coding 目录有关的检查通过。
- `test:project-task-defaults`：正式脚本仍在“设计创意推荐 working”断言失败。实际结果同时包含 `recommendedPresetId: "general-office"`，旧预期只包含模式。使用 `git archive 8b463bb` 的原始源码和原始测试在隔离目录复现了相同失败。只在临时诊断副本校正这一预期后，其余断言全部通过；仓库正式断言保持不变，该脚本不记为通过。
