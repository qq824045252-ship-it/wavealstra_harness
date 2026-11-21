# MyBuddy 原生会话 Hook

在 **设置 → 执行钩子** 中选择「新建 Hook」。表单自带一个可运行的示例。它在调用 `write` 前检查文件内容，发现空白就把补救说明交给代理。可先将作用范围设为一个任务，再点「验证并发布」。

## 编写检查

脚本读取 `event`，返回 `true` 表示通过，返回非空字符串表示触发当前时机的处理。每个脚本在独立的 QuickJS worker 中执行，限时 3 秒，可用内存 16 MiB。脚本能读取本次事件提供的数据。读取文件、修改产物等操作由原会话通过已有工具完成。

| 触发时机 | 可读取的内容 | 返回文字的效果 |
| --- | --- | --- |
| 模型请求前 | `userText`，请求上下文里最近的用户消息 | 文字随本次请求提供给模型 |
| 工具执行前 | `tool`、`args` | 阻止执行，将原因作为工具错误返回给代理 |
| 工具返回后 | `tool`、`args`、`result.isError`、`result.text`、`result.diagnostics` | 反馈附在工具诊断里。Code Mode 内部调用的反馈随外层调用返回给模型 |
| 提交答复前 | `answer`、`userText`、`recentTools`、`historyTruncated` | 反馈交给当前会话继续处理。两次补救后仍未通过，该次提交以未完成结束 |

每种事件都有 `event.event`、`actor`（`main` 或 `subagent`）、`role`（子代理角色名称）、`taskId`、`conversationId` 和 `nativeTaskId`。工具事件还有 `callId`。工具名精确匹配，留空表示所有工具。MCP 工具使用 MyBuddy 注册的 `mcp__服务__工具` 名称。

**提交答复前**的 `userText` 取本轮最近已纳入执行的用户提交。 `recentTools` 按先后顺序列出本轮最近 48 条原始记录中可见的顶层工具结果。每项带 `tool`、`callId`、`isError`、`text` 和 `textTruncated`，能关联到原始调用时另有 `path`。结果文本最多 4,000 字符。更早的记录已超出窗口时，`historyTruncated` 为 `true`。Code Mode 在此处呈现为一次外层调用，要检查内部工具请使用工具执行前或工具返回后。

## 例子：交付前读回报告

选择「提交答复前」，将范围设为交付报告的任务。下面的检查要求代理读回本次提到的 `report.md`，并在文件中找到「验收结论」标题。

```javascript
if (!event.userText.includes("report.md")) return true;

const latest = event.recentTools
  .filter(t => t.path === "report.md" && ["read", "write", "edit"].includes(t.tool))
  .at(-1);
if (latest?.tool === "read" && !latest.isError && latest.text.includes("## 验收结论")) {
  return true;
}
return "请用 read 读回 report.md，核对「验收结论」章节后交付。";
```

将以下 JSON 放入「发布前验证用例」，然后点「验证并发布」。

```json
[
  {
    "input": { "userText": "请交付 report.md", "recentTools": [] },
    "expected": "请用 read 读回 report.md，核对「验收结论」章节后交付。"
  },
  {
    "input": { "userText": "请核对 report.md", "recentTools": [
      { "tool": "read", "path": "report.md", "isError": false, "text": "## 验收结论\n已通过" }
    ] },
    "expected": true
  },
  {
    "input": { "userText": "解释这段代码", "recentTools": [] },
    "expected": true
  }
]
```

## 发布、回退与查看结果

发布时，MyBuddy 用实际执行脚本的引擎逐项核对预期返回值，全部通过后原子切换版本。编辑期间若其他窗口已经更新规则，重载已发布版本再合并改动。可随时停用规则或切回任一已验证版本。

已有会话在下一次匹配操作使用当前版本。已匹配的工具调用固定执行前、返回后两组检查的版本，恢复时继续使用同一组。设置页显示最近 100 条执行记录，可展开查看任务、会话、调用身份、版本与处理说明。规则、版本和执行记录保存在 MyBuddy 数据目录中的 `native-hooks.sqlite`。
