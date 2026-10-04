# MyBuddy Portable Memory / External Agent Memory Access

Portable Memory 把 MyBuddy 现有 Memory Kernel 暴露为稳定的 HTTP JSON + MCP Streamable HTTP 边界；External Agent Memory Access 在这条边界之上增加产品化启停、独立授权、Token 轮换和作用域治理。

## 架构不变量

```text
L1 MemoryRecord（唯一长期记忆真源）
        ↓
MemoryService
        ↓
MemoryGatewayService
        ↓
Request-scoped Access Policy
   ┌──────────────┴──────────────┐
HTTP JSON                  MCP Streamable HTTP
        ↑                         ↑
        └──── MemoryGatewayServer ┘
                    ↑
          Delegated Access Grant
```

- Gateway 不维护第二套 Memory 数据。
- HTTP 与 MCP 共用同一个 `MemoryGatewayService`，scope、可见性、写权限完全同义。
- L2 Scenario / L3 Core Profile 仍然只是 L1 派生投影，不提供外部直接写入口。
- 所有写入继续经过 `MemoryService`，保留 revision、projection invalidation、Procedure→Skill learning 等既有语义。
- 外部授权配置只是访问控制，不是 Memory truth。

## 产品默认值

External Agent Memory Access **默认关闭**：

```text
Gateway enabled = false
External write master gate = false
Host = 127.0.0.1
Port = 3351
```

设置页「记忆 → 外部 Agent Memory 访问」可以即时：

- 启停 Gateway；
- 开关外部写入总闸；
- 修改本机端口；
- 创建、停用、轮换、撤销外部 Agent 授权；
- 复制 MCP 地址和一次性 Token / MCP 配置。

端口修改采用安全切换：新端口监听成功后才替换旧 listener；失败会回滚设置并保留旧服务。

## 地址

默认：

```text
HTTP API  http://127.0.0.1:3351/v1/memory
MCP       http://127.0.0.1:3351/mcp
Health    http://127.0.0.1:3351/healthz
```

Gateway 永远只允许绑定 `127.0.0.1`，不会直接监听 `0.0.0.0`。

远端 ChatGPT / ERP / LabHub 若需访问，应通过受认证的隧道或反向代理暴露本机 loopback 地址，而不是扩大 Gateway bind address。

## `memoryEnabled` 是最高级门禁

MyBuddy 已有“生成对话记忆”开关仍是最高级产品门禁。

运行中设置：

```text
memoryEnabled = false
```

会立即导致：

- HTTP Memory 读写返回 `403 memory_disabled`；
- 新 MCP 会话不声明 `tools` capability；
- 已有 L1 Memory 保留，不删除；
- Gateway listener 可以继续存在，但不暴露 Memory 能力；
- 再次开启后立即恢复，无需重启。

这与现有产品文案“关闭后不再提取或加载，已有记录仍保留”一致。

## 外部 Agent 授权

外部 Agent **不共享 owner token**。设置页创建命名授权，例如：

```text
ChatGPT     read        project:project-a
ERP         read-write  project:erp-project
LabHub      read-write  workspace:labhub
```

每个 grant 拥有：

- 独立随机 Token；
- `read` / `read-write` 模式；
- `all` / `global` / `project` / `workspace` / `task` 作用域；
- enabled 状态；
- 独立撤销与 Token 轮换能力。

### Token 存储

外部授权文件：

```text
~/.mybuddy/memory-access.json
```

只保存 SHA-256 Token hash，不保存明文 Token。明文只在创建或轮换时返回一次。

授权文件使用同目录临时文件 + fsync + rename 原子写。

Gateway 自身仍有一个本地 bootstrap owner token 文件：

```text
~/.mybuddy/memory-gateway.token
```

它只用于 owner/bootstrap 诊断兼容，不通过设置页分发给外部 Agent。外部集成应使用 delegated grant。

## 双重写门禁

外部写入必须同时满足：

```text
Memory Gateway 外部写入总闸 = ON
        AND
当前 grant.mode = read-write
        AND
目标 L1 scope 在 grant 可写范围内
```

任一条件不满足，都不能修改 L1。

Delegated grant 同时限制读取和写入的 durable scope：

- Workspace grant 只读取/写入授权 Workspace 子树内的 L1；不会旁带 Project、Global 或授权父级外的 L1；
- Task grant 只读取/写入对应 Task L1；
- Project grant 只读取/写入对应 Project L1；
- Global grant 只读取/写入 Global L1；
- `all` read-write grant 才拥有完整 owner-like scope 写能力，但仍受外部写入总闸控制。

对于具有多个 scope 的同一 L1 MemoryRecord，只要其中任一 durable scope 超出 grant 写边界，delegated grant 就不能修改/删除该记录，避免“一处修改、跨 scope 同步变化”的越权。

## 读取 Scope

### 带 `taskId`

`taskId` 是权威上下文。Gateway 从数据库重新解析真实 `projectId` / `workspaceId`，客户端不能覆盖。

Owner / `all` grant 继续使用 Memory Kernel 的自然可见链：

```text
Task
+ 当前 Project
+ 当前 Workspace
+ 父 Workspace 链
+ Global
```

Sibling Workspace 与其他 Project 不可见。

非 `all` delegated grant 会在上下文校验之外进一步裁剪**实际返回的 durable L1**，不会因为 Task 自然继承链而泄漏授权 scope 之外的 Global / Project / Workspace 内容；其 `memory_context` 也只返回授权范围内的 L1，不携带可能跨 scope 聚合的 L2/L3。

### 不带 `taskId`

可以显式指定 Project 或 Workspace 上下文，但 delegated grant 不能拼接互不可信的混合上下文。例如 Workspace grant 不能同时提交任意 `projectId + workspaceId` 来组合两侧 Memory。

## 创建与 Promote

Owner / `all` grant 的 Task 写入继续遵守：

```text
Project > Workspace > Task
```

Delegated Project / Workspace / Task grant 的 Task 写入会优先落到**该授权对应的 durable scope**，不会因为 Task 同时绑定 Project 而越出 grant。

跨 scope 不允许隐式 create。需要扩大作用域时必须显式 `memory_promote`，且：

1. 原 L1 本身必须可写；
2. 目标 scope 也必须在 grant 可写边界内；
3. 仍需通过 `MemoryService.canPromoteFromTask()`。

Global 直接创建只允许稳定可复用 kind：

- `identity`
- `preference`
- `constraint`
- `procedure`

## MCP 工具

有 Memory 能力时，owner MCP 可见读取工具：

```text
memory_search
memory_get
memory_history
memory_context
memory_stats
```

Delegated grant 不暴露 owner-level `memory_stats`。

当外部写总闸和 grant.mode 都允许时，增加：

```text
memory_create
memory_update
memory_promote
memory_forget
```

`memoryEnabled=false` 时 MCP 不声明 tools capability。

## HTTP API

读取：

```text
POST /v1/memory/search
POST /v1/memory/get
POST /v1/memory/history
POST /v1/memory/context
GET  /v1/memory/stats   # owner only
```

写入：

```text
POST /v1/memory/create
POST /v1/memory/update
POST /v1/memory/promote
POST /v1/memory/forget
```

所有 HTTP/MCP 请求除 `/healthz` 外都必须携带：

```http
Authorization: Bearer <delegated-token>
```

## 外部写入归属

External Agent 不允许冒充 user/agent 来源。

写入统一记录：

```text
sourceType = tool
sourceId   = memory-gateway:<grant-id>
```

owner bootstrap 写入使用：

```text
sourceId = memory-gateway:owner
```

create metadata 同时记录不可由外部 update 冒充的 creator `externalAccessId` / `externalAccessName`，并自动添加 `external` evidence。update 记录 `externalLastAccessId` / `externalLastAccessName`，revision 的 `changeReason` 强制带 `memory-gateway:<grant-id>` 前缀，因此可以追到具体外部授权。

对非 `all` grant，返回的 L1 会脱敏原始 `sourceId/sourceTaskId/metadata/evidence/relations` 和其它 scope；`memory_history` 也只暴露该 grant 的 scope 获得可见性之后产生的 revision，避免 promote 后倒带读取旧上下文。内部 L1 审计信息不受影响。

## 环境变量覆盖

高级运行环境仍可显式覆盖产品设置：

```text
MYBUDDY_MEMORY_GATEWAY_ENABLED=0|1
MYBUDDY_MEMORY_GATEWAY_PORT=3351
MYBUDDY_MEMORY_GATEWAY_WRITE=0|1
```

只有变量实际存在时才覆盖设置页值。设置页会显示对应项被环境变量接管，避免“UI 看似生效、实际被 env 覆盖”的假状态。

## 网络与浏览器安全

- loopback only；
- 不发送 CORS allow-origin；
- 非 loopback `Origin` 即使 Token 正确也拒绝；
- 请求体大小有界；
- Token 使用 timing-safe / hash 比较；
- 缺少、错误、停用、轮换前 Token 均返回 401；
- guessed Memory ID 的“不存在”和“越 scope”统一 not-found，避免 existence probing；
- delegated grant 不能读取 owner-level stats；
- grant 管理只通过 Electron IPC 暴露给本机 UI，不存在 HTTP/MCP 自助提权接口。

## 面向后续统一中枢

到这一层之后，ChatGPT / ERP / LabHub 接入统一遵循同一种模式：

```text
External Agent
   ↓ 独立 delegated token
受认证隧道（如需要远端）
   ↓
127.0.0.1 Memory Gateway
   ↓
MemoryGatewayService
   ↓
MemoryService
   ↓
L1 MemoryRecord
```

不同系统可以各自授权、各自撤销，不需要复制 Memory DB，也不需要再发明一套记忆格式。

## Skill-first：MyBuddy Workspace → 外部 AI CLI 共享记忆

MyBuddy 对 Codex / Claude Code / Hermes 等外部 CLI 的首选接入现在采用 **Skill-first**，底层仍然复用本页定义的 Memory Gateway，不新建第二套 Memory 数据。

```text
~/.mybuddy/skills/shared-memory
        ↓ one-way projection
~/.agents/skills / ~/.claude/skills / ~/.hermes/skills
        ↓
mybuddy-memory
        ↓ workspace-scoped runtime credential
Memory Gateway
        ↓
MemoryService / L1 MemoryRecord
```

### 终端准备

从 MyBuddy 的 Workspace/Task 终端打开或重启时：

1. 刷新全局 Skill 到外部 CLI 的只读投影；
2. 若 External Agent Memory Gateway 已启用，则确保 Gateway 正在运行；
3. 为当前 Workspace 创建或复用一个 `workspace` scope 的 delegated grant；
4. grant 权限跟随 Gateway 外部写总闸：总闸关闭时为 `read`，开启时为 `read-write`；
5. 把 CLI 运行时所需的 delegated token 写入 `~/.mybuddy/runtime/memory-share/*.json`。

这些 runtime profile 使用与 Memory Gateway secret 文件相同的当前用户/SYSTEM ACL。它们只服务于 MyBuddy 自己启动的本机 CLI 共享链路；手工在设置页创建的普通 delegated grant 仍保持“明文 Token 仅创建/轮换时返回一次”的产品语义。

每个 runtime credential 都只授权一个 Workspace。外部 CLI 不获得 owner token，也不会获得跨 Workspace 的 `all` scope。

### Built-in asset bootstrap

External CLI Memory no longer depends on files created manually on one developer machine. The application bundles and materializes the bridge assets itself:

- `~/.mybuddy/skills/shared-memory/SKILL.md` is created only when neither `SKILL.md` nor `skill.md` already exists. A user-edited Skill is never overwritten.
- `~/.mybuddy/bin/mybuddy-memory.mjs` plus Windows/POSIX launch wrappers are MyBuddy-managed files and are refreshed when the bundled CLI implementation changes.
- MyBuddy Terminal prepends `~/.mybuddy/bin` to its child-process `PATH` without changing the global OS PATH.
- Herdr command/server processes receive the same PATH prefix, so agents launched inside a MyBuddy-owned Herdr session can call `mybuddy-memory` directly.
- Terminal preparation retries materialization before Skill projection, so deleting a managed CLI file during a run self-heals on the next open/restart.

This means a fresh checkout/install or a rebuilt `~/.mybuddy` directory can bootstrap the shared-memory bridge without manual copying.

### `shared-memory` Skill

Skill 的默认入口：

```text
mybuddy-memory context "<当前任务>"
```

它根据当前 cwd 自动选择最长匹配的 Workspace runtime profile，因此在 Workspace 子目录中运行 Codex/Claude 仍会命中同一受限授权。

需要精确检索时：

```text
mybuddy-memory search "<主题>"
mybuddy-memory get <memory-id>
```

只有形成新的长期知识时才写回；先 search 去重，再 update，最后才 create。禁止把对话流水、临时日志和秘密写入长期记忆。

这条链路的目标是让 Skill 负责“何时读、何时写、写什么”，Gateway 负责授权与数据一致性，MemoryService/L1 继续作为唯一长期记忆真源。
