# MyBuddy「内置工具与 Pi 扩展」Code Review

- **日期**：2026-08-27
- **分支**：`ui/welcome-home-v1`
- **范围**：内置工具身份识别、pi 扩展装配链、工具副作用 / 审批门禁

---

## 一、背景与链路

整个「内置工具 & pi 扩展」体系的核心运行链路如下：

1. `src/main/agent/PromptAssembly.ts` — 工具集合的**唯一真相**之一
   - `NATIVE_CAPABILITY_TOOL_NAMES`（原生自研能力工具）
   - `MUTATING_BUILTIN_TOOLS` / `READONLY_EXTRA_ACTIVE`（pi 内置读/写工具）
   - `resolveSessionToolSelection` / `activateResolvedSessionTools`：基于权限模式生成 `excludeTools` / `extraActiveTools`，**不传封闭 allowlist**（避免丢掉扩展工具）。
2. `src/main/agent/AgentService.ts`（~5080-5432）— 会话装配链，依次注入各种 `ExtensionFactory`：任务目录边界守卫 → bash 隔离 → 原生能力 → MCP inline → **MCP 副作用门禁** → **权限审批** → 备份 → 记忆/项目/资料库工具。
3. `src/main/security/McpSideEffectPolicy.ts` — MCP 工具身份解析 + 副作用策略。
4. `src/main/agent/{mcp-side-effect,permission,workspace-guard,bash-isolation}-extension.ts` — 各类 tool_call 钩子。
5. `src/shared/pi-event-mapper.ts` — 事件 → UI 补丁映射、`isSideEffectTool` / `isDangerousTool`。

---

## 二、核心问题（严重）

### 🔴 原生工具被误判为「未知 MCP」→ 多余 / 重复审批

**根因：**

- `McpSideEffectPolicy.ts` 中 `BUILTIN_TOOL_NAMES` 只放进了 **7 个 pi 内置工具**：`read / write / edit / bash / grep / find / ls`。
- `parseMcpToolIdentity` 的 native 豁免 = **仅** `BUILTIN_TOOL_NAMES` + `cad_` 前缀。
- 而 MyBuddy 自研的原生能力工具（`NATIVE_CAPABILITY_TOOL_NAMES` + `builtin-capability-extension.ts` 注册的工具）**不在**豁免清单，例如：
  - `execute_code`、`terminal`、`image_generate`、`video_generate`、`speech_to_text`、`text_to_speech`
  - `describe_image`、`browser_exec`、`ui_exec`、`computer_exec`、`runtime_probe`
  - `web_search`、`web_extract`、`fetch_content`、`source_check`、`get_search_content`

这些工具会被 `parseMcpToolIdentity` 的 `{provider}_{tool}` 拆分规则**误判为未知 MCP provider**，
从而被 `McpSideEffectExtension`（`mcp-side-effect-extension.ts:60-62`）拉入 MCP 副作用门禁。

**实证**（临时脚本 bundle 后真跑，结论后已删除脚本，仓库干净）：

```
MISS execute_code   -> 被误判为 MCP provider=execute tool=code      requiresApproval=true
MISS terminal       -> provider=terminal tool=terminal              requiresApproval=true
MISS image_generate -> provider=image    tool=generate              requiresApproval=true
MISS web_search     -> provider=web      tool=search                requiresApproval=true
        …… 共 16 个原生工具全部误判
对照组 pi 内置 read/write/edit/bash/grep/find/ls 全部正常视为 native(null)
```

**结论：** `passed=7 / failed=16`。

**实际影响：**

1. **default 权限模式 → 双重审批弹窗。**
   以 `execute_code` 为例，`McpSideEffect`（装配序 7）与 `permission-extension`（装配序 8，其中 `isSideEffectTool` 含 `execute_code/terminal/image_generate/…/text_to_speech`）**都会**调用 `requestApproval`。
   `requestApprovalOnce`（`AgentService.ts`）目前仅对 `grantedExternalWriteToolCalls` 去重，**兜不住**此场景 ⇒ 同一 tool_call 可能弹两次。
2. **default 模式 → 意外审批。**
   `web_search` 等本应在 permission 层放行的工具，被 MCP 门禁判定 `requiresApproval=true`，导致联网搜索也要弹审批，影响正常体验。
3. 安全上**不是提权漏洞**：readonly 下仍有 `permission` 的 `isSideEffectTool` 兜底拦截、auto 模式放行，因此本次定性为 **UX / 一致性 bug**，非安全漏洞。

**修复方案（三选一，建议 A）：**

- **方案 A（推荐）**：把 `NATIVE_CAPABILITY_TOOL_NAMES` 从 `PromptAssembly.ts` 下沉到 `src/shared`（与 `BUILTIN_TOOL_NAMES` 并列），并让 `parseMcpToolIdentity` 的 native 豁免包含它（`security` → `shared` 依赖方向允许）。
- **方案 B**：在 `mcp-side-effect-extension.ts` 内，用 `session.getAllTools()` 判断该工具已是本会话注册的 native 工具（且非 `mcp__` 前缀）则直接 `return`。
- **方案 C**：同时收敛 `BUILTIN_TOOL_NAMES` / `NATIVE_CAPABILITY_TOOL_NAMES` / `pi-event-mapper.isSideEffectTool` 到**同一权威清单**，消除后续漂移。

---

## 三、次要发现（可维护性 / 健壮性，中低）

1. **工具名清单散落多处、语义重叠但不同步**
   - `BUILTIN_TOOL_NAMES`（McpSideEffectPolicy：pi 内置 7 件）
   - `MUTATING_BUILTIN_TOOLS` / `READONLY_EXTRA_ACTIVE` / `NATIVE_CAPABILITY_TOOL_NAMES`（PromptAssembly）
   - `isSideEffectTool` / `isDangerousTool`（pi-event-mapper）

   pi 若新增 / 改名内置工具，需同步多处，易漂移。建议抽到 `src/shared` 单一权威源，并加一层一致性断言测试。

2. **`parseMcpToolIdentity` 的 `_` 拆分较脆弱**
   `{server}_{tool}` 以**首个** `_` 作为边界；若某 MCP server 名本身含 `_` 会被拆错。目前对 `mcp__` 前缀、serena 等无影响，但该隐含约定值得在注释中点明（server 名不应含 `_`）。

3. **`pi-bundled-runtime.ts` 静默副作用**
   该模块在 bundle 期 `import()` 触发 `registerBunOAuthFlows()` 与 `setBedrockProviderModule()`，存在进程级副作用。建议补充注释说明依赖关系，避免重构时误删。

---

## 四、附录：涉及的代码位置

| 文件 | 关键符号 |
| --- | --- |
| `src/main/security/McpSideEffectPolicy.ts` | `BUILTIN_TOOL_NAMES`、`parseMcpToolIdentity`、`getDefaultMcpSideEffectRegistry` |
| `src/main/agent/PromptAssembly.ts` | `NATIVE_CAPABILITY_TOOL_NAMES`、`resolveSessionToolSelection`、`activateResolvedSessionTools` |
| `src/main/agent/mcp-side-effect-extension.ts` | `createMcpSideEffectExtension` |
| `src/main/agent/permission-extension.ts` | `createPermissionExtension` |
| `src/main/agent/AgentService.ts` | 装配链（~5080-5320）、`requestApprovalOnce` |
| `src/main/agent/{task-workspace-guard,bash-isolation}` | write/edit / bash 钩子 |
| `src/main/capabilities/builtin-capability-extension.ts` | 原生能力工具注册（execute_code 等） |
| `src/shared/pi-event-mapper.ts` | `isSideEffectTool` / `isDangerousTool` |
| `src/main/pi-bundled-runtime.ts` | bundle 期 OAuth/Bedrock 副作用 |

---

## 五、一句话总结

**原生自研工具未被纳入 native 豁免清单，会被误判为未知 MCP，导致 default 权限下出现重复 / 意外审批；建议把原生工具清单下沉到 `src/shared` 并在 `parseMcpToolIdentity` 中统一豁免，同时消除四处工具清单的漂移。**