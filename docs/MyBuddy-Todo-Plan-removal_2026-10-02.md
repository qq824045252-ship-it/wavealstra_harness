# 对话 Todo / Plan 功能删除

2026-10-02。聊天头部的 Todo、Plan 按钮和对应实现已删除。

删除范围包括两个头部入口、弹窗和计划卡片、前端状态与快照恢复、计划批准发送、Todo / Plan 服务和仓库、八个相关模型工具、计划副作用钩子、批准请求字段、桌面和远程事件字段，以及新数据库的 Todo / Plan 建表代码。提示词不再引导模型使用对话执行计划。专用旧测试和回归脚本入口也已删除。

共享的执行身份已移到 `ConversationExecutionContext.ts`。Goal、用户提问、工具恢复和聊天的排队/取消逻辑继续使用这一独立类型。Project 页面中的共享计划属于另一个功能，没有被这两个聊天按钮使用。

历史 Pi 会话和现有数据库没有销毁。旧库中的退休表不再由程序访问，新库不创建这些表；旧计划消息块只投影为普通文本，没有进度、批准或执行控件。

## 验证记录

- Desktop 和 Remote 类型检查通过；生产代码和最终构建中未找到 Todo / Plan 的旧工具、服务、批准字段或快照事件引用。
- 真实生产 Pi 工具注册和执行 16 项、架构 323 项通过。
- Goal / 用户输入、历史文本展示、聊天生命周期和排队发送、数据库及 Remote 快照回归通过。
- Desktop / Remote 构建和最终打包通过；真实模型桌面验收 3/3 通过：四工具原生执行、退出码 7、运行中取消。额外实测 Todo / Plan 控件和快照字段缺席、Goal 创建取消、输入框以及侧栏重开后的普通历史内容保持不变，Renderer 错误数为 0。
- 原有实例在部署前已关闭。部署未终止其他程序，完成了一致性数据备份及同名快捷方式切换，实际主实例已启动上述新包。辅助进程结束后的独立持续存活结果见 `deployment.json` 的 `postHelperPersistence`。
- 测试和部署记录位于 `artifacts/todo-plan-removal/`：`regression-results.json`、`desktop-live/results.json` 和 `deployment.json`。

新包路径：`C:/Users/servi/AppData/Local/Programs/MyBuddy/portable/release-todo-plan-removal-20261002/win-unpacked/MyBuddy.exe`。

已验收并部署的 `app.asar` SHA-256：`dbe1a31ede779b710a06d208af1b9ed2ab9ebf28f35e4c4e801730fdd91911d1`。
