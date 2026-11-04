import type { Artifact, ChatMessage, FileChange } from "@/types";

function extractFilenameFromToolCall(
  tool: string,
  summary?: string,
  detail?: string,
  targetPath?: string,
): string | null {
  if (targetPath) {
    const parts = targetPath.replaceAll("\\", "/").split("/");
    return parts[parts.length - 1] || null;
  }
  const text = `${summary ?? ""} ${detail ?? ""}`;
  // 匹配常见文件名 pattern
  const m = text.match(/([\w.-]+\.(?:go|ts|tsx|js|jsx|json|md|py|html|css|rs|c|cpp|h|yml|yaml|sql|sh))/i);
  return m ? m[1] : null;
}

export function resolveTaskFileChanges(
  rawChanges: FileChange[] | undefined,
  artifacts: Artifact[],
  messages?: ChatMessage[],
): FileChange[] {
  const result: FileChange[] = [];
  const seen = new Set<string>();

  // 1. 优先使用已记录的 rawChanges
  for (const c of rawChanges ?? []) {
    const key = c.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(c);
    }
  }

  // 2. 将当前任务的产物文件（代码/文本）作为可靠兜底补齐
  for (const a of artifacts) {
    const key = a.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      const lines = (a.content ?? "").split("\n").length;
      result.push({
        id: `fc-art-${a.id}`,
        name: a.name,
        additions: lines > 0 ? lines : 1,
        deletions: 0,
      });
    }
  }

  // 3. 从 messages 的工具调用中回溯补充修改过的文件名
  for (const msg of messages ?? []) {
    for (const block of msg.blocks ?? []) {
      if (block.type === "tool") {
        const tc = block.toolCall;
        const fn = extractFilenameFromToolCall(tc.tool, tc.summary, tc.detail, tc.targetPath);
        if (fn && !seen.has(fn.toLowerCase())) {
          seen.add(fn.toLowerCase());
          result.push({
            id: `fc-msg-${tc.id}`,
            name: fn,
            additions: 1,
            deletions: 0,
          });
        }
      }
    }
  }

  return result;
}
