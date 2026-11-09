# 首页模式选择回归修复

基线：`4147b2d7c33b71a72bd4dfdee0e347186022fe7d`。本次不修改权限、预算、执行器或用户数据库。

## 根因与修复

真实 Electron dev 窗口复现：点击「通用模式」后 `.hero.dataset.mode` 已是 `general`，标题也是「通用任务，按需执行并随时接续」，但 `aria-pressed=true` 与选中样式落在「代码开发」。首页保留了旧 `bot` 键的反向映射，找不到 `general` 时回退到第一项，造成自动跳回代码模式的视觉反馈。

首页改为直接遍历共享 `WELCOME_MODES`，用 `WELCOME_MODE_LABELS` 显示文案，用真实模式判断选中状态，不再维护两套字符串映射。另外给模式预设异步加载加失效清理，快速切换时旧回包不能覆盖新模式的预设。

## 实机验证

在 Omarchy 新建临时 HOME / userData，通过 electron-vite dev 启动完整应用，使用 CDP 真实鼠标点击；未读取或修改真实用户 profile，未发模型请求。

- 修复前：点击通用模式，实际模式 `general`，选中按钮却为「代码开发」。
- 修复后：三种模式来回点击两轮，实际模式、样式和 aria-pressed 始终一致。
- 窗口焦点刷新、窄屏再放大后选中项保持正确。
- 侧栏「Bot 模式」进入真正 Bot 页面，焦点刷新不跳走；回普通模式保留正确通用模式选择。
- renderer 重载后再次选择通用模式成功。
- 新增 `pnpm -s test:mode-navigation:desktop`，默认自动启动隔离 dev 实例并清理，已实跑通过；归类 GUI，不伪装成 headless。

类型检查通过；`test:hero-suggest` 34 条与 `test:mode-preset` 197 条通过。完整 headless 门禁：400 通过 / 1 失败（3.4 分钟）。唯一失败 `test:expert` 的 section 11 导入失败回滚、原目录重导入与能力导出共 5 条断言（73 通过 / 5 失败）；单独复跑相同，专家实现及测试与基线没有任何差异。未改失败基线，不能称全量门禁通过。
