---
name: shared-memory
display_name: MyBuddy 共享记忆 · Shared Memory
description: Use when an external AI CLI (Codex, Claude Code, Hermes, OpenCode, etc.) is working inside a MyBuddy Workspace and prior project decisions, constraints, procedures, progress, or user preferences may matter. Loads workspace-scoped MyBuddy memory before substantive work and writes back only durable knowledge.
version: 1.0.0
---

# MyBuddy Shared Memory

## Intent

让 MyBuddy 与外部 AI CLI 共享同一个长期记忆真源。不要建立第二份 MEMORY.md、AGENTS.md 摘要库或 CLI 私有长期记忆来替代 MyBuddy Memory Kernel。

数据链：

```text
External AI CLI
  -> this Skill
  -> mybuddy-memory / Memory MCP
  -> MyBuddy Memory Gateway
  -> MemoryService
  -> L1 MemoryRecord (single durable truth)
```

## Trigger

高置信度触发：

- 当前 CLI 是从 MyBuddy Workspace / Herdr 项目终端启动的，并准备进行实质性工作。
- 用户说“继续之前的”“按之前方案”“你应该记得”“查下项目记忆”“共享记忆”。
- 任务涉及既有架构决策、约束、接口约定、调试结论、项目进度、长期偏好或操作规程。
- 准备修改已有项目，历史决策若遗漏可能造成返工。
- 用户明确说“记住”“以后按这个执行”“把这个同步给 MyBuddy”。

不必触发：

- 与当前 Workspace 无关的纯知识问答。
- 一次性极短命令且历史项目上下文显然不会影响结果。
- 用户明确要求不要读取长期记忆。

## Boundary

- MyBuddy Memory Kernel 是唯一长期记忆真源。
- 不为“共享记忆”创建或维护第二套 `MEMORY.md` / `AGENTS.md` / 私有数据库。
- 不读取其它 Workspace 的 credential/profile。
- 不把 Token、密码、API Key、私钥、Cookie、验证码等秘密写入记忆。
- 不把整段对话、终端日志、临时调试噪声当长期记忆。
- Gateway/credential 不可用时，明确按“本轮无共享记忆”继续，不得假装已经读取。

---

## 1. 开始工作：先恢复相关记忆

进行实质性工作前，先执行一次：

```text
mybuddy-memory context "<用一句话概括当前任务>"
```

这是默认入口。它会按当前 CLI 所在目录自动选择 MyBuddy 为该 Workspace 准备的受限授权。

如果运行时原生暴露了 MyBuddy MCP 工具，也可以直接使用：

```text
memory_context
memory_search
memory_get
memory_history
```

优先读取与当前任务真正相关的内容，不要为了“保险”拉取大量无关记忆。

如果需要查特定主题：

```text
mybuddy-memory search "<关键词或问题>"
```

需要完整条目：

```text
mybuddy-memory get <memory-id>
```

## 2. 使用记忆的纪律

把读到的内容按以下优先级应用：

1. `constraint` — 不得违反的约束。
2. `decision` — 已经确定的方案，不要无理由重新设计。
3. `procedure` — 已验证的操作流程、调试/构建方法。
4. `fact` — 项目事实、接口、路径、环境等。
5. `risk` / `open_question` — 尚未收口的问题。
6. `progress` — 当前阶段和已完成工作。
7. `preference` — 用户长期偏好。

记忆与用户本轮明确指令冲突时，以用户本轮指令为准；必要时在完成后更新旧记忆。

## 3. 写回：只沉淀长期有价值的信息

只有出现下面这类信息时才写回：

- 用户明确确认的长期约束。
- 已经决定且后续会复用的架构/方案决策。
- 已验证、以后值得重复使用的 procedure。
- 重要且稳定的项目事实。
- 真正会影响后续工作的风险、待确认项或阶段进度。

写之前先搜索，避免重复：

```text
mybuddy-memory search "<要写入的主题>"
```

如果已有同一条记忆，优先更新：

```text
mybuddy-memory update <id> --content "<新内容>" --reason "<为什么更新>"
```

只有没有对应条目时才创建：

```text
mybuddy-memory create decision "<标题>" "<内容>"
mybuddy-memory create constraint "<标题>" "<内容>"
mybuddy-memory create procedure "<标题>" "<内容>"
mybuddy-memory create fact "<标题>" "<内容>"
```

可用 kind：

```text
identity
preference
fact
decision
constraint
risk
open_question
progress
procedure
```

## 4. 完成工作时

不要机械地“每次结束都写一条总结”。只在本轮确实形成新的长期知识时写回。

优先记录：

- 最终采用了什么。
- 为什么这样定。
- 哪些路径/接口/参数以后必须保持。
- 哪个坑已经验证过，后续不要再走。
- 还有什么未解决且会影响下一轮。

不要记录：

- “今天修改了 3 个文件”这类没有长期价值的流水账。
- 临时测试输出。
- 可直接从 Git / 文件中重新得到的普通代码细节，除非它代表关键约束或坑。

## 5. 失败与降级

如果出现：

```text
No MyBuddy shared-memory profile matches the current directory
```

说明当前 CLI 不是从已准备共享记忆的 MyBuddy Workspace 终端启动，或 Gateway 尚未启用。不要自行搜索 `~/.mybuddy/app.db`，不要绕过 Gateway 直接写数据库。

如果 Gateway 返回只读权限，则允许读取但不要尝试绕过写门禁。

如果用户明确要求忘记某条记忆，先查到准确 id，再使用：

```text
mybuddy-memory forget <id>
```

`forget` 是破坏性操作；只有用户明确要求删除/忘记，或确认该条记忆必须硬删除时才使用。

## Boundary / Output Contract

返回采用的相关记忆及当前证据差异；写回仅遵守用户授权和工作区协议。网关失败时保留降级说明并继续可独立完成的工作，不把旧记忆当当前事实。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
