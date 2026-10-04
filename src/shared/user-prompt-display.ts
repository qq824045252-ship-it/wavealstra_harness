/**
 * 用户气泡展示文本：附件、终端和 Vision 使用已有显式附加格式。
 * Memory 不按标题隐藏：有来源证明的旧注入由主进程用 Pi ContextEdit 修正。
 */

const INJECTED_TAIL_MARKERS: RegExp[] = [
  /\n*<!-- mybuddy:reference-context -->/,
  /\n*## 引用任务：/,
  /\n*## 引用文件：/,
  /\n*## 用户附带文件(?:\n|$)/,
  /\n*## 用户附带的终端上下文/,
  /\n*## 内部 Vision 视觉描述/,
  /\n*\[Artifact Context\]/,
  /\n*（用户附带了 \d+ 张图片/,
];

/** 从存储的完整 prompt 切掉尾部注入块，只留用户自己打的字。 */
export function stripInjectedUserPromptTail(raw: string): string {
  if (!raw) return "";
  let cut = raw.length;
  for (const re of INJECTED_TAIL_MARKERS) {
    re.lastIndex = 0;
    const match = re.exec(raw);
    if (match && match.index >= 0 && match.index < cut) cut = match.index;
  }
  return raw.slice(0, cut).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 对话框正文：去掉注入块、MCP/连接器标记、开头 /skill，保留用户换行。
 */
export function userPromptDisplayText(raw: string): string {
  let text = stripInjectedUserPromptTail(raw);
  if (!text) return "";

  text = text
    .replace(/【使用\s*MCP\s*[：:][^】]*】/g, "")
    .replace(/【使用连接器[：:][^】]*】/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  while (true) {
    const match = text.match(/^\/([^\s/]+)(?:[ \t]+|\n+|$)/);
    if (!match) break;
    text = text.slice(match[0].length).trimStart();
  }

  return text.trim();
}
