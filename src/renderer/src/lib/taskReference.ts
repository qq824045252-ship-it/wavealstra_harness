/**
 * 任务引用（refTask）文本机制 — 纯函数层。
 *
 * 现有“引用任务”能力：把源任务的标题/空间/工作目录/文件清单/最近对话拼成
 * `## 引用任务` 块，随首条 prompt 注入（显示层经 parseUserPrompt 剥离，不进入聊天气泡）。
 * ChatInput（+ 菜单手动引用）与 createRelatedTask（自动关联任务）共用本模块，
 * 保证“从任务创建关联任务”与手工引用使用同一份上下文语义。
 */
import type { RefFileItem } from "./refTaskArtifacts";

export const REFERENCE_CONTEXT_START = "<!-- mybuddy:reference-context -->";
export const REFERENCE_CONTEXT_END = "<!-- /mybuddy:reference-context -->";

/** 引用任务的对话消息（文本子集） */
export interface RefTaskMessage {
  role: "user" | "assistant";
  text: string;
}

/** 可引用的任务（供 buildTaskReferenceBlock 组装） */
export interface RefTaskItem {
  id: string;
  title: string;
  /** 任务所属空间名称 */
  spaceName?: string;
  /** 任务工作目录，供 Agent 定位未内嵌的产出物 */
  cwd?: string;
  /** 选中时一并加载的任务对话，供发送时注入上下文 */
  messages?: RefTaskMessage[];
  /** 任务附件、产物和变更文件 */
  files?: RefFileItem[];
}

/** 把引用任务的上下文拼进 prompt；任务正文只给 Agent，UI 只显示引用摘要。 */
export function buildTaskReferenceBlock(task: RefTaskItem): string {
  const lines: string[] = [`## 引用任务：${task.title || "未命名任务"}`];
  if (task.spaceName) lines.push(`来源空间：${task.spaceName}`);
  if (task.cwd) lines.push(`工作目录：${task.cwd}`);

  const files = task.files ?? [];
  if (files.length > 0) {
    lines.push("引用文件：");
    for (const file of files) {
      const source = file.source === "artifact" ? "产出物" : file.source === "change" ? "变更" : "附件";
      const pathHint = file.path ? ` | 路径：${file.path}` : "";
      lines.push(`- ${file.name}（${source}）${pathHint}`);
    }
  }

  const msgs = (task.messages ?? []).slice(-8);
  if (msgs.length === 0) {
    lines.push("（该任务暂无可用对话记录）");
  } else {
    lines.push("最近对话：");
    for (const message of msgs) {
      const text = message.text.trim();
      if (!text) continue;
      const role = message.role === "user" ? "用户" : "助手";
      const clipped = text.length > 800 ? `${text.slice(0, 800)}…` : text;
      lines.push(`### ${role}\n${clipped}`);
    }
  }

  const inlineFiles = files.filter((file) => !file.path?.trim() && file.content?.trim());
  if (inlineFiles.length > 0) {
    lines.push("引用产出物内容：");
    for (const file of inlineFiles) {
      const content = file.content!.trim();
      const clipped = content.length > 12_000 ? `${content.slice(0, 12_000)}\n…（已截断）` : content;
      lines.push(`### ${file.name}`);
      lines.push("```");
      lines.push(clipped);
      lines.push("```");
    }
  }
  return lines.join("\n\n");
}

/** 用隐藏标记包裹引用块（发送文本用；UI 显示层会剥离标记区） */
export function wrapReferenceContext(blocks: string): string {
  if (!blocks.trim()) return "";
  return [REFERENCE_CONTEXT_START, blocks, REFERENCE_CONTEXT_END].join("\n");
}
