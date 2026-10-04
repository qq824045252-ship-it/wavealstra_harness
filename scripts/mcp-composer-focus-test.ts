/**
 * MCP composer 焦点回归守卫。
 *
 * 历史故障：MCP 安装/选择后菜单 portal 已不可见，但 addOpen 对应的全屏透明
 * backdrop 仍可能覆盖 textarea，只能刷新恢复。这里锁住三个无视觉改动的修复约束：
 * 1) 成功安装后不等待二次列表刷新才关闭菜单；
 * 2) 先关闭菜单，再选择 MCP；
 * 3) addOpen 不再创建全屏阻断层，且焦点在下一帧恢复。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const chatInput = readFileSync(
  join(repo, "src/renderer/src/components/chat/ChatInput.tsx"),
  "utf8",
);
const addMenu = readFileSync(
  join(repo, "src/renderer/src/components/chat/InputAddMenu.tsx"),
  "utf8",
);

let passed = 0;
function ok(condition: unknown, label: string): void {
  assert.ok(condition, label);
  passed += 1;
}

const pickMcpBlock = /const pickMcp = \(server: McpServerDto\): void => \{([\s\S]*?)\n  \};/.exec(addMenu)?.[1] ?? "";
ok(Boolean(pickMcpBlock), "1.1 找到已安装 MCP 选择路径");
ok(
  pickMcpBlock.indexOf("onClose();") >= 0 &&
    pickMcpBlock.indexOf("onClose();") < pickMcpBlock.indexOf("onSelectMcp?.("),
  "1.2 已安装 MCP 先关闭菜单，再挂到输入框",
);

const importMcpBlock = /const importMcp = async \(server: McpServerDto\): Promise<void> => \{([\s\S]*?)\n  \};/.exec(addMenu)?.[1] ?? "";
ok(Boolean(importMcpBlock), "2.1 找到 MCP 导入路径");
ok(!/await refreshMcp\(\)/.test(importMcpBlock), "2.2 安装成功后不等待二次刷新才关闭菜单");
ok(
  importMcpBlock.indexOf("onClose();") >= 0 &&
    importMcpBlock.indexOf("onClose();") < importMcpBlock.indexOf("onSelectMcp?.("),
  "2.3 导入成功后先关闭菜单，再挂到输入框",
);

ok(
  /requestAnimationFrame\(\(\) => \{[\s\S]*?textareaRef\.current\?\.focus\(\{ preventScroll: true \}\)/.test(chatInput),
  "3.1 输入焦点在弹层卸载后的下一帧恢复",
);
ok(
  /onSelectMcp=\{\(server\) => \{[\s\S]*?setAddOpen\(false\);[\s\S]*?attachMcp\(server\);[\s\S]*?focusComposerAfterPopupClose\(\);/.test(chatInput),
  "3.2 MCP 选择回调显式关闭菜单并恢复焦点",
);

const backdropCondition = /\{\(([^)]*)\) && \(\s*<div className="input-popup-backdrop"/.exec(chatInput)?.[1] ?? "";
ok(Boolean(backdropCondition), "4.1 找到输入弹层透明遮罩条件");
ok(!backdropCondition.includes("addOpen"), "4.2 MCP 添加菜单不再创建全屏点击阻断层");

console.log(`[mcp-composer-focus-test] passed=${passed} failed=0`);
