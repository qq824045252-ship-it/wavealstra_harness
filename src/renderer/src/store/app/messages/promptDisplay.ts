import { stripInjectedUserPromptTail } from "../../../../../shared/user-prompt-display";

/**
 * 用户可见正文：去掉 /skill、【使用 MCP：…】、引用任务/文件块。
 * Agent 仍收完整 prompt；气泡与任务名只用这段，避免前缀盖住真实内容。
 * 同时抽出技能/MCP/连接器名，供用户气泡芯片展示（发送后仍可见）。
 */
export function userVisiblePromptText(text: string): {
  display: string;
  skillNames: string[];
  mcpNames: string[];
  connectorNames: string[];
} {
  let raw = text.trim();
  if (!raw)
    return { display: "", skillNames: [], mcpNames: [], connectorNames: [] };

  const mcpNames: string[] = [];
  const mcpRe = /【使用\s*MCP\s*[：:]([^】]*)】/g;
  for (const m of raw.matchAll(mcpRe)) {
    for (const name of m[1]!
      .split(/[、,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!mcpNames.includes(name)) mcpNames.push(name);
    }
  }

  const connectorNames: string[] = [];
  const connRe = /【使用连接器[：:]([^】]*)】/g;
  for (const m of raw.matchAll(connRe)) {
    // 形如「钉钉（技能：a、b）；飞书」——取每段主名
    for (const part of m[1]!
      .split(/[;；]/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      const name = part
        .replace(/（[^）]*）/g, "")
        .replace(/\([^)]*\)/g, "")
        .trim();
      if (name && !connectorNames.includes(name)) connectorNames.push(name);
    }
  }

  raw = stripInjectedUserPromptTail(raw)
    .replace(/【使用\s*MCP\s*[：:][^】]*】/g, "")
    .replace(/【使用连接器[：:][^】]*】/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const skillNames: string[] = [];
  let rest = raw;
  while (true) {
    const m = rest.match(/^\/([^\s/]+)(?:[ \t]+|\n+|$)/);
    if (!m) break;
    skillNames.push(m[1]!);
    rest = rest.slice(m[0].length).trimStart();
  }

  return { display: rest.trim(), skillNames, mcpNames, connectorNames };
}

/**
 * 首条消息生成侧栏任务名：去掉 /skill、MCP 提示前缀，优先用用户说明文字。
 * 例："/hello-buddy 你好" → "你好"；仅 "/hello-buddy" → "hello-buddy"
 */
export function taskTitleFromFirstMessage(text: string, maxLen = 24): string {
  const { display, skillNames } = userVisiblePromptText(text);
  const titleBase = (display || skillNames[skillNames.length - 1] || "新任务")
    .replace(/\s+/g, " ")
    .trim();
  if (titleBase.length <= maxLen) return titleBase;
  return `${titleBase.slice(0, maxLen).trimEnd()}…`;
}
