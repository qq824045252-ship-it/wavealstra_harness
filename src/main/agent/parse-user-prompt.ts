import type { ChatAttachmentDto, TaskReferenceDto } from "../../shared/agent-ipc";
import { stripInjectedUserPromptTail } from "../../shared/user-prompt-display";
import { selectionLabelsFromPrompt } from "../../shared/selection-display";

const ATTACHMENT_MARKER = "\n\n## 用户附带文件\n";
const REFERENCE_CONTEXT_END = "<!-- /mybuddy:reference-context -->";

function parseTaskReferences(text: string): TaskReferenceDto[] {
  const references: TaskReferenceDto[] = [];
  // 只把下一个「引用任务」或显式结束标记视为边界，不能被产物 Markdown 的 ## 标题截断。
  const pattern = new RegExp(
    `(?:^|\\n)## 引用任务：([^\\n]+)\\n([\\s\\S]*?)(?=\\n## 引用任务：|\\n${REFERENCE_CONTEXT_END}|$)`,
    "g",
  );
  for (const match of text.matchAll(pattern)) {
    const title = match[1]?.trim();
    if (!title) continue;
    const body = match[2] ?? "";
    const spaceMatch = /^来源空间：([^\n]+)$/m.exec(body);
    const files: TaskReferenceDto["files"] = [];
    const lines = body.split(/\r?\n/);
    const fileHeader = lines.findIndex((line) => line.trim() === "引用文件：");
    if (fileHeader >= 0) {
      for (let i = fileHeader + 1; i < lines.length; i += 1) {
        const line = lines[i]?.trim() ?? "";
        if (!line.startsWith("- ")) break;
        const raw = line.slice(2).trim();
        const pathMatch = /\s\| 路径：(.+)$/.exec(raw);
        const rawWithSource = pathMatch ? raw.slice(0, pathMatch.index).trim() : raw;
        const sourceMatch = /^(.*?)(?:（(产出物|附件|变更)）)$/.exec(rawWithSource);
        const name = (sourceMatch?.[1] ?? rawWithSource).trim();
        if (!name) continue;
        const source =
          sourceMatch?.[2] === "附件"
            ? "attachment"
            : sourceMatch?.[2] === "变更"
              ? "change"
              : "artifact";
        if (!files.some((file) => file.name === name)) {
          files.push({ name, path: pathMatch?.[1]?.trim() || undefined, source });
        }
      }
    }
    references.push({
      title,
      spaceName: spaceMatch?.[1]?.trim() || undefined,
      files,
    });
  }
  return references;
}

function extractAttachments(text: string): ChatAttachmentDto[] {
  const markerIndex = text.lastIndexOf(ATTACHMENT_MARKER);
  if (markerIndex < 0) return [];
  const after = text.slice(markerIndex + ATTACHMENT_MARKER.length);
  const attachments: ChatAttachmentDto[] = [];
  for (const line of after.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("## ") ||
      trimmed.startsWith("### ") ||
      trimmed.startsWith("请优先") ||
      trimmed.startsWith(">") ||
      trimmed.startsWith("<!--")
    ) {
      break;
    }
    const match = /^- (.*?): (.+)$/.exec(trimmed);
    if (!match) continue;
    const name = match[1].trim();
    const path = match[2].replace(/（[^）]*）\s*$/, "").trim();
    if (name && path) attachments.push({ name, path });
  }
  return attachments;
}

export function parseUserPrompt(text: string): {
  text: string;
  selectionLabels?: string[];
  attachments?: ChatAttachmentDto[];
  taskReferences?: TaskReferenceDto[];
} {
  const attachments = extractAttachments(text);
  const taskReferences = parseTaskReferences(text);
  const selectionLabels = selectionLabelsFromPrompt(text);
  const result: {
    text: string;
    selectionLabels?: string[];
    attachments?: ChatAttachmentDto[];
    taskReferences?: TaskReferenceDto[];
  } = {
    text: stripInjectedUserPromptTail(text),
  };

  if (attachments.length) result.attachments = attachments;
  if (selectionLabels.length) result.selectionLabels = selectionLabels;
  if (taskReferences.length) result.taskReferences = taskReferences;
  return result;
}
