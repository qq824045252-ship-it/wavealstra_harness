/**
 * LEGACY READ-ONLY 数据源 — V3.5 Wave 3 收口（P1）
 *
 * ~/.mybuddy/artifact-index.json 不再是 Artifact 真相源，生产代码已停止写入
 * （rememberTaskArtifact 已移除；Agent ingest / renderer register 全部走 SQLite
 * ArtifactRepository）。
 *
 * 本模块仅保留读取能力：ensureTaskLegacyMigrated/registerLegacy 在首次 hydrate 时
 * 把老用户 artifact-index 数据一次性迁移进 SQLite Artifact Domain（迁移只跑一次，
 * 不删除原文件；loadTaskArtifacts 供迁移 source 使用）。
 *
 * 历史写入格式（仅供理解旧数据，不再产出）：
 *   { "<taskId>": [{ path, messageId, updatedAt }, ...] }  // FIFO 追加，同 path 去重
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatArtifactDto } from "../../shared/agent-ipc";
import { getMyBuddyDir } from "../paths";
import { previewWorkspaceFile } from "../workspace/WorkspaceService";

interface ArtifactRecord {
  path: string;
  messageId: string;
  updatedAt: number;
}

type ArtifactIndex = Record<string, ArtifactRecord[]>;

const indexPath = (): string => join(getMyBuddyDir(), "artifact-index.json");

function readIndex(): ArtifactIndex {
  try {
    const value = JSON.parse(readFileSync(indexPath(), "utf-8")) as ArtifactIndex;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Legacy migration 数据源：读取老 artifact-index 的 task 记录（只读，不写） */
export async function loadTaskArtifacts(taskId: string): Promise<ChatArtifactDto[]> {
  const records = readIndex()[taskId] ?? [];
  const artifacts: ChatArtifactDto[] = [];
  for (const record of records) {
    if (!existsSync(record.path)) continue;
    try {
      const preview = await previewWorkspaceFile(record.path);
      artifacts.push({
        id: `indexed-${taskId}-${Buffer.from(record.path).toString("base64url")}`,
        name: preview.name,
        kind: preview.kind,
        content: preview.content,
        language: preview.language,
        path: preview.path,
      });
    } catch {
      /* malformed or temporarily locked file */
    }
  }
  return artifacts;
}
