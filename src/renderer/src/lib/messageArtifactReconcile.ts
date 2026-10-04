/**
 * 历史恢复产物芯片对账：
 * session jsonl 里的 hist-art-* 伪 ID 与 Artifact Domain 真实 id 不一致，
 * 刷新后消息上的 artifactIds 对不上 projection → 芯片消失。
 * 用历史 write/edit 的 name/path 映射回 Domain，并把未挂接的孤儿产物挂到最后一条助手消息。
 */
import type { ChatMessage } from "@/types";
import type { ArtifactDescriptor } from "../../../shared/artifact-types";

export type HistoryArtifactHintItem = { name: string; path?: string };
export type HistoryArtifactHint = {
  messageId: string;
  items: HistoryArtifactHintItem[];
};

/** taskId → 历史消息产物线索（仅用于对账，非持久真相） */
const historyArtifactHintsByTask = new Map<string, HistoryArtifactHint[]>();

export function setHistoryArtifactHints(taskId: string, hints: HistoryArtifactHint[]): void {
  if (!taskId) return;
  if (!hints.length) {
    historyArtifactHintsByTask.delete(taskId);
    return;
  }
  historyArtifactHintsByTask.set(taskId, hints);
}

export function clearHistoryArtifactHints(taskId: string): void {
  historyArtifactHintsByTask.delete(taskId);
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").toLowerCase();
}

function entryFileOf(d: ArtifactDescriptor): string {
  if (d.source.type === "workspace-file") return d.source.entryFile;
  if (d.source.type === "managed-content") return d.source.storagePath;
  return "";
}

function baseName(pathOrName: string): string {
  const n = pathOrName.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return (i >= 0 ? n.slice(i + 1) : n).toLowerCase();
}

function matchDomainArtifact(
  hint: HistoryArtifactHintItem,
  descriptors: ArtifactDescriptor[],
  used: Set<string>,
): string | null {
  const name = hint.name.trim().toLowerCase();
  if (!name) return null;
  const path = hint.path ? normalizePath(hint.path) : "";

  if (path) {
    const byPath = descriptors.find((d) => {
      if (used.has(d.id)) return false;
      const entry = normalizePath(entryFileOf(d));
      if (!entry) return false;
      return entry === path || entry.endsWith(`/${name}`) || baseName(entry) === name;
    });
    if (byPath) return byPath.id;
  }

  const byName = descriptors.find((d) => {
    if (used.has(d.id)) return false;
    const title = (d.title ?? "").trim().toLowerCase();
    const base = baseName(entryFileOf(d));
    return title === name || base === name;
  });
  return byName?.id ?? null;
}

function sameIds(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  return aa.every((id, i) => id === bb[i]);
}

/**
 * 把消息上的 artifactIds 对齐到 Domain：
 * 1) 保留已是 Domain 真 id 的关联
 * 2) 用历史 name/path 线索补全
 * 3) 仍未挂接的 Domain 产物挂到最后一条助手消息（避免刷新后芯片全丢）
 */
export function reconcileMessagesArtifactIds(
  messages: ChatMessage[],
  descriptors: ArtifactDescriptor[],
  taskId: string,
): ChatMessage[] {
  if (!messages.length || !descriptors.length) return messages;

  const hints = historyArtifactHintsByTask.get(taskId) ?? [];
  const hintByMessage = new Map(hints.map((h) => [h.messageId, h.items] as const));
  const used = new Set<string>();

  let next = messages.map((m) => {
    const resolved: string[] = [];

    for (const id of m.artifactIds ?? []) {
      if (descriptors.some((d) => d.id === id) && !used.has(id)) {
        resolved.push(id);
        used.add(id);
      }
    }

    const items = hintByMessage.get(m.id);
    if (items?.length) {
      for (const item of items) {
        const id = matchDomainArtifact(item, descriptors, used);
        if (id) {
          resolved.push(id);
          used.add(id);
        }
      }
    }

    const artifactIds = resolved.length ? resolved : undefined;
    if (sameIds(artifactIds, m.artifactIds)) return m;
    return { ...m, artifactIds };
  });

  const orphans = descriptors.filter((d) => !used.has(d.id));
  if (orphans.length === 0) return next;

  let lastAsst = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i]?.role === "assistant") {
      lastAsst = i;
      break;
    }
  }
  if (lastAsst < 0) return next;

  const m = next[lastAsst]!;
  const merged = [...new Set([...(m.artifactIds ?? []), ...orphans.map((o) => o.id)])];
  if (sameIds(merged, m.artifactIds)) return next;
  next = next.slice();
  next[lastAsst] = { ...m, artifactIds: merged };
  return next;
}
