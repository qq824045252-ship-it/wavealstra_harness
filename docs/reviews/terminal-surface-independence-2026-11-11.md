# 工作空间详情终端与侧栏终端未分离

日期：2026-11-11。现象：在项目文件夹（工作空间详情页「终端」tab）新建/打开的终端，会出现在扩展栏（侧栏）终端里；反之亦然——两处共用同一套标签。

## 根因

终端的标签归属键由 `currentTerminalOwnerKey(state, surface)` 生成，设计上区分 `surface="panel"`（扩展栏）与 `surface="workspace"`（工作空间详情）。但 `WorkspaceDetail.tsx` 渲染 `<TerminalTabsBar />` / `<TerminalView />` 时没有传 `surface`，两者都落到默认 `"panel"`，owner 键相同 → 同一组标签/激活态。会话层（`TerminalHost` 按 `owner+terminalId` 键）本身是分开的，问题只在渲染侧归属键丢失。

## 修复

- `WorkspaceDetail` 显式传 `surface="workspace"`（TabsBar 与 View 都传）；扩展栏 `ExtensionTopBar` / `ArtifactPanel` 继续用默认 `"panel"`。
- 工作空间页面的终端键变为 `workspace:ws:<workspaceId>`，扩展栏为 `ws:<workspaceId>`（聊天页分别为 `workspace:task:<taskId>` / `task:<taskId>`），互不共享标签与激活项；PTY 仍按各自 tab 的 `terminalId` 独立。
- 新增回归测试 `test:terminal-surface`：纯 `currentTerminalOwnerKey` 断言 + 渲染侧必须显式声明 surface 的源检查。

## 验证

- `pnpm -s test:terminal-surface` PASS
- `pnpm -s typecheck` 通过
- 未验证：真实 dev 界面上“左侧建终端、右侧不再出现”的点击验收（需重启/热更新后手测）。
