---
name: hello-ardot
description: |
  打招呼并报告当前 Ardot 文件的基本信息。
  当用户说"你好 Ardot"、"hello ardot"、"打个招呼"时使用。
  Triggers: "你好 Ardot", "hello ardot", "打个招呼".
metadata:
  version: "0.1.0"
  author: your-name
---

# Hello Ardot

## When to use

当用户希望 AI 用一句话向他打招呼，并且报告一下当前打开的 Ardot
文件名和页面名时使用。

## Workflow

1. 调用 **fetch_editor_state**（建议把 `includeSchema` 和
   `includeGeneralEditInstructions` 都设为 `false`），获取当前
   文件和页面
2. 用一句中文向用户打招呼，并报告：
   - 当前文件名
   - 当前页面名

## Out of scope

- 不修改任何节点
- 不调用其他 MCP 工具

## Notes

这个 Skill 仅用于确认开发环境是否打通，是一个入门 demo。