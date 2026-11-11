/**
 * context.ts — Subagent Context Contract（D）。
 *
 * 明确的继承边界（写入子代理系统提示，让子代理自己也知道边界）：
 * - 继承：工作区 cwd（进程工作目录）、角色 systemPrompt、任务文本、可选的
 *   `<cwd>/.mybuddy/shared-context.md`（若存在，全文上限截断）。
 * - 不继承（不伪造未知）：Project Shared Context / Project Memory / Plan /
 *   Tag / Skill / Expert / Connector 策略 / 主 Agent 聊天历史 —— 均存于 MyBuddy
 *   DB/主进程，扩展进程外无法访问；主 Agent 需要在任务文本中压缩传递。
 * - 摘要策略：本模块只做「明确声明 + 可选文件注入」，不做隐式猜测。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function appendWorkspaceNotes(task: string, notes: string): string {
  return notes ? `${task}\n\n---\n# 本次派发的项目与空间便签（参考资料）\n${notes}\n\n以上便签仅供参考；以本次任务要求为准。` : task;
}

/** 可选共享上下文文件的最大注入字节数 */
export const SHARED_CONTEXT_MAX_BYTES = 8 * 1024;
/** 系统提示文件总字节上限（防角色文件失控） */
export const SYSTEM_PROMPT_MAX_BYTES = 64 * 1024;

export interface ContextBlockInput {
  cwd: string;
  roleName: string;
  roleDescription: string;
  tools: string[] | null;
  permissionMode: string;
  deniedTools: string[];
  sharedContext?: string | null;
  sharedContextStatus?: { injected: boolean; bytes: number; reason: string };
  depth: number;
}

/** 纯函数：生成 Context Contract 块（附加在角色 systemPrompt 之后）。 */
export function buildContextBlock(input: ContextBlockInput): string {
  const lines: string[] = [];
  lines.push("# Subagent Context Contract（自动生成，请遵守）");
  lines.push("");
  lines.push(`## 工作区`);
  lines.push(`- cwd: \`${input.cwd}\``);
  lines.push("");
  lines.push(`## 继承边界`);
  lines.push(
    "你只获得以下上下文：① 本角色说明（上方）；② 任务文本（用户消息）；③ 工作区路径。",
  );
  lines.push("以下内容【不继承】（未知保持未知，不要编造）：");
  lines.push(
    "- Project Shared Context / Project Memory / 当前 Plan：MyBuddy 存储于主进程数据库，子代理进程不可读。",
  );
  lines.push("- Tag / Skill / Expert / Connector 策略：宿主会话策略，不随子进程复制。",
  );
  lines.push("- 主 Agent 聊天历史：隔离。需要时主 Agent 会把摘要放进任务文本。",
  );
  if (input.sharedContext) {
    lines.push("");
    lines.push(`## 项目共享上下文（来自 .mybuddy/shared-context.md，${Buffer.byteLength(input.sharedContext, "utf8")} 字节）`);
    lines.push(input.sharedContext);
  } else {
    lines.push("- 项目共享上下文未注入：主 Agent 如需请在任务中内联。");
    if (input.sharedContextStatus) lines.push(`- bytes=${input.sharedContextStatus.bytes}；reason=${input.sharedContextStatus.reason}`);
  }
  lines.push("");
  lines.push(`## 工具与执行环境`);
  if (input.tools) {
    lines.push(`- 本会话可用工具（引擎白名单）: ${input.tools.join(", ")}`);
  } else {
    lines.push(`- 本会话可用工具: 继承宿主已加载工具`);
  }
  if (input.deniedTools.length > 0) {
    lines.push(`- 当前不可用工具: ${input.deniedTools.join(", ")}`);
  }
  lines.push(
    "- 子代理继承宿主已加载的读、写、命令与扩展工具；应用不再要求逐动作授权。",
  );
  lines.push(`- 当前深度: ${input.depth}（递归有硬上限，禁止再次委派）。`);
  lines.push("");
  lines.push("## 任务交接模板");
  lines.push("主代理应在任务文本中明确：任务目标；允许修改范围；约束；已知事实与来源路径；验收命令/条件；产物路径。缺失信息标未知，不从主聊天或数据库猜测。");
  lines.push("");
  lines.push("## 读取与审查范围");
  lines.push("- 从任务指定的改动、路径与符号开始检索，按相关区间读取；仅在调用关系、依赖或验证需要时扩大范围，避免无关的全仓库或整文件重复读取。");
  lines.push("- 同一文件同一区间已在本次上下文中且未变化时，优先复用已读内容；文件变更、内容截断或证据不足时必须重新读取。不要为提高缓存比例而跳过必要审查或测试。");
  lines.push(`## 输出要求`);
  lines.push(
    "- 完成任务后在最终回复给出固定栏目：结论 / 改动文件 / 执行结果（命令与证据、产物路径）/ 未验证项；不要输出内部推理过程。",
  );
  lines.push("- 例外：任务要求逐字或精确格式时，产物文件必须逐字匹配；上述固定栏目只约束最终回复，不得施加于产物文件。");
  lines.push("- 遇到权限/工具不可用导致的阻塞，明确说明阻塞原因，不要假装完成。");
  return lines.join("\n");
}

/** 可选：读取 `<cwd>/.mybuddy/shared-context.md`（存在且小于上限才注入）。 */
export interface SharedContextDiagnostic {
  injected: boolean;
  bytes: number;
  reason: string;
  text: string | null;
}

export function inspectSharedContext(cwd: string): SharedContextDiagnostic {
  const p = path.join(cwd, ".mybuddy", "shared-context.md");
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return { injected: false, bytes: stat.size, reason: "not_file", text: null };
    if (stat.size > SHARED_CONTEXT_MAX_BYTES) return { injected: false, bytes: stat.size, reason: "over_limit", text: null };
    const text = fs.readFileSync(p, "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > SHARED_CONTEXT_MAX_BYTES) return { injected: false, bytes, reason: "over_limit", text: null };
    return { injected: bytes > 0, bytes, reason: bytes ? "injected" : "empty", text: text || null };
  } catch (error) {
    return { injected: false, bytes: 0, reason: (error as NodeJS.ErrnoException).code ?? "read_failed", text: null };
  }
}

export function readOptionalSharedContext(cwd: string): string | null {
  const result = inspectSharedContext(cwd);
  return result.text ?? `(shared-context.md 未注入；bytes=${result.bytes}；reason=${result.reason}；limit=${SHARED_CONTEXT_MAX_BYTES})`;
}

/** 组装子代理系统提示文件内容（角色 body + context block），并钳制大小。 */
export function buildSystemPromptContent(roleBody: string, contextBlock: string): string {
  const body = roleBody.trim();
  const sep = body.length > 0 ? "\n\n---\n\n" : "";
  let content = `${body}${sep}${contextBlock}`;
  if (Buffer.byteLength(content, "utf8") > SYSTEM_PROMPT_MAX_BYTES) {
    content = content.slice(0, SYSTEM_PROMPT_MAX_BYTES);
    content += "\n\n[系统提示超长已截断]";
  }
  return content;
}
