/**
 * 把侧栏任务装成可注入对话的 RefTaskItem。
 * InputAddMenu「引用任务」与侧栏「分享任务」共用，保证上下文装配一致。
 */
import type { Space, Task } from "@/types";
import { collectTaskDomainArtifacts, type RefFileItem } from "./refTaskArtifacts";
import type { RefTaskItem, RefTaskMessage } from "./taskReference";

function isAbsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

function joinPath(cwd: string, rel: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  const name = rel.replace(/^[\\/]+/, "");
  return `${base}\\${name}`.replace(/\//g, "\\");
}

function historyAttachmentPath(task: Task, path?: string): string | undefined {
  const raw = (path || "").trim();
  if (!raw) return undefined;
  if (isAbsPath(raw) || !task.cwd) return raw;
  return joinPath(task.cwd, raw);
}

function collectTaskMessages(task: Task): RefTaskMessage[] {
  return task.messages
    .map((message) => ({
      role: message.role,
      text: [...message.blocks, ...(message.finalBlocks ?? [])]
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim(),
    }))
    .filter((message) => message.text);
}

function mergeRefFiles(...lists: RefFileItem[][]): RefFileItem[] {
  const merged: RefFileItem[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const file of list) {
      const key = (file.path || file.name || file.id).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(file);
    }
  }
  return merged;
}

export interface LoadRefTaskOptions {
  task: Task;
  spaces: Space[];
  /** Artifact Domain client；缺省时只装对话/历史附件 */
  artifactDomain?: {
    snapshot?: (req: { taskId: string }) => Promise<unknown>;
    list?: (req: { taskId: string }) => Promise<unknown>;
    readContent?: (req: { artifactId: string }) => Promise<{ content?: string } | null>;
  } | null;
  loadHistory?: (taskId: string) => Promise<{
    messages?: Array<{
      role: "user" | "assistant";
      text: string;
      artifacts?: Array<{ id: string; name: string; path?: string; content?: string }>;
      attachments?: Array<{ name: string; path?: string }>;
    }>;
  } | null>;
}

/** 装载任务引用上下文（对话 + 产物 + 附件） */
export async function loadTaskAsRefItem(options: LoadRefTaskOptions): Promise<RefTaskItem> {
  const { task, spaces } = options;
  let messages = collectTaskMessages(task);
  let files: RefFileItem[] = [];

  if (task.sessionFile && options.loadHistory) {
    try {
      const history = await options.loadHistory(task.id);
      if (messages.length === 0) {
        messages = (history?.messages ?? [])
          .map((message) => ({ role: message.role, text: message.text.trim() }))
          .filter((message) => message.text);
      }
      const historyMessageArtifacts = (history?.messages ?? []).flatMap((message) =>
        (message.artifacts ?? []).map((artifact) => ({
          id: artifact.id,
          name: artifact.name,
          path: artifact.path,
          content: artifact.path ? undefined : artifact.content || undefined,
          source: "artifact" as const,
        })),
      );
      const historyAttachments = (history?.messages ?? []).flatMap((message) =>
        (message.attachments ?? []).map((attachment) => ({
          id: `hist-att:${attachment.path || attachment.name}`,
          name: attachment.name,
          path: historyAttachmentPath(task, attachment.path),
          source: "attachment" as const,
        })),
      );
      files = mergeRefFiles(
        files,
        await collectTaskDomainArtifacts(
          options.artifactDomain as Parameters<typeof collectTaskDomainArtifacts>[0],
          task.id,
        ),
        historyMessageArtifacts,
        historyAttachments,
      );
    } catch (err) {
      console.warn("[loadRefTask] load referenced task history failed", err);
    }
  } else if (options.artifactDomain) {
    try {
      files = await collectTaskDomainArtifacts(
        options.artifactDomain as Parameters<typeof collectTaskDomainArtifacts>[0],
        task.id,
      );
    } catch (err) {
      console.warn("[loadRefTask] collect domain artifacts failed", err);
    }
  }

  const space = task.spaceId ? spaces.find((item) => item.id === task.spaceId) : undefined;
  return {
    id: task.id,
    title: task.title || "未命名任务",
    spaceName: space?.name,
    cwd: task.cwd ?? space?.path,
    messages,
    files,
  };
}
