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
    lines.push(`## 项目共享上下文（来自 .mybuddy/shared-context.md，${input.sharedContext.length} 字符）`);
    lines.push(input.sharedContext);
  } else {
    lines.push("- 项目共享上下文文件未提供：主 Agent 如需请在任务中内联。");
  }
  lines.push("");
  lines.push(`## 权限边界`);
  if (input.tools) {
    lines.push(`- 本会话可用工具（引擎白名单）: ${input.tools.join(", ")}`);
  } else {
    lines.push(`- 本会话可用工具: 未限制（宿主 permissionMode=auto）`);
  }
  if (input.deniedTools.length > 0) {
    lines.push(`- 已被策略禁用: ${input.deniedTools.join(", ")}`);
  }
  lines.push(
    "- 默认（角色未声明 tools）为只读分析集（read/ls/find/grep）；bash/write/edit 是高权限工具，仅在角色显式声明时可用，且子代理内无交互审批（预授权）。",
  );
  lines.push(`- 宿主权限模式: ${input.permissionMode}；深度: ${input.depth}（递归有硬上限，禁止再次委派）。`);
  lines.push("");
  lines.push(`## 输出要求`);
  lines.push(
    "- 完成任务后在最终回复给出简洁结论（结果、关键证据、产物路径）；不要输出内部推理过程。",
  );
  lines.push("- 遇到权限/工具不可用导致的阻塞，明确说明阻塞原因，不要假装完成。");
  return lines.join("\n");
}

/** 可选：读取 `<cwd>/.mybuddy/shared-context.md`（存在且小于上限才注入）。 */
export function readOptionalSharedContext(cwd: string): string | null {
  try {
    const p = path.join(cwd, ".mybuddy", "shared-context.md");
    const stat = fs.statSync(p);
    if (!stat.isFile()) return null;
    if (stat.size > SHARED_CONTEXT_MAX_BYTES) {
      return `(shared-context.md 超过 ${SHARED_CONTEXT_MAX_BYTES} 字节，未注入)`;
    }
    const text = fs.readFileSync(p, "utf-8");
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
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
