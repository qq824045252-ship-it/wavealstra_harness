/**
 * Artifact Domain 装配 — V3.5 Wave 2 收口（W2.6/W2.7）
 *
 * 双系统施工态：
 *   - 新 Artifact Domain 已可独立运行（Storage → Repository → Registry → Service +
 *     Domain IPC + preload bridge），旧 consumer 未迁移、仍服务产品。
 *   - RefreshCoordinator 保持独立（W2.8：暂不接 AgentService.emitChangedArtifacts，
 *     等 Artifact consumer/source 迁移后再接入）。
 *
 * 启动动作（§7/§14）：
 *   - rebuildRegistry()：Registry 从 Repository 全量重建
 *   - orphanGC()：非阻塞清理，不阻塞应用启动
 */
import { BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import { join } from "node:path";

import { ArtifactDomainIpc } from "../../shared/artifact-ipc";
import type {
  ArtifactCreatedEvent,
  ArtifactRemovedEvent,
  ArtifactUpdatedEvent,
} from "../../shared/artifact-types";
import { getMyBuddyDir } from "../paths";
import { ArtifactRefreshCoordinator } from "./ArtifactRefreshCoordinator";
import { ArtifactRegistry } from "./ArtifactRegistry";
import { ArtifactRepository } from "./ArtifactRepository";
import { ArtifactService, type ArtifactEventSink, type LegacyArtifactInput } from "./ArtifactService";
import { ArtifactStorage } from "./ArtifactStorage";

export interface ArtifactDomain {
  service: ArtifactService;
  coordinator: ArtifactRefreshCoordinator;
}

/**
 * Legacy artifact 数据源（3B.2）：由 Main 装配处提供
 * （复用 AgentService.loadTaskHistory：session jsonl + artifact-index.json）。
 * 返回 null 表示该 task 无 session（直接标记 migrated）。
 */
export interface LegacyArtifactSource {
  loadLegacyArtifacts(
    taskId: string,
  ): Promise<{ artifacts: LegacyArtifactInput[]; cwd?: string } | null>;
}

/**
 * 一次性 legacy migration 编排（3B.2-3.4）：
 * - 未迁移 → 读取旧数据源 → registerLegacy（0 条也标记完成）
 * - 迁移失败（拿不到数据）→ 抛错，不标记 → 下次 hydrate 重试（M6）；
 *   聊天历史 restore 是独立路径，不受影响（M5/H4/H5 隔离）
 */
export async function ensureTaskLegacyMigrated(
  service: ArtifactService,
  source: LegacyArtifactSource,
  taskId: string,
): Promise<void> {
  if (service.isLegacyMigrated(taskId)) return;
  const legacy = await source.loadLegacyArtifacts(taskId);
  if (!legacy) {
    await service.registerLegacy(taskId, []); // 无 session → 空迁移，标记完成
    return;
  }
  await service.registerLegacy(taskId, legacy.artifacts, legacy.cwd);
}

/** Main → Renderer 事件广播（全窗口 webContents.send） */
function broadcastSink(): ArtifactEventSink {
  const send = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  };
  return {
    created: (e: ArtifactCreatedEvent) => send(ArtifactDomainIpc.created, e),
    updated: (e: ArtifactUpdatedEvent) => send(ArtifactDomainIpc.updated, e),
    removed: (e: ArtifactRemovedEvent) => send(ArtifactDomainIpc.removed, e),
  };
}

/**
 * 装配完整 Artifact Domain（共享 AppDatabase 的 SQLite 连接）。
 * extraSink：装配处附加事件消费者（4D SelectionStore 订阅 updated/removed）。
 */
export function createArtifactDomain(
  db: Database.Database,
  extraSink?: ArtifactEventSink,
): ArtifactDomain {
  const storage = new ArtifactStorage(join(getMyBuddyDir(), "artifacts"));
  const repository = new ArtifactRepository(db);
  const registry = new ArtifactRegistry();
  const broadcast = broadcastSink();
  const service = new ArtifactService(storage, repository, registry, {
    created: (e) => {
      broadcast.created?.(e);
      extraSink?.created?.(e);
    },
    updated: (e) => {
      broadcast.updated?.(e);
      extraSink?.updated?.(e);
    },
    removed: (e) => {
      broadcast.removed?.(e);
      extraSink?.removed?.(e);
    },
  });
  const coordinator = new ArtifactRefreshCoordinator(service);

  // 启动：Registry 从 Repository 全量重建（§7 Registry 可完全重建）
  service.rebuildRegistry();
  // 启动：orphan GC 非阻塞（§14，失败 log，下次启动重试）
  void service
    .orphanGC()
    .then((r) => {
      if (r.removed.length > 0 || r.failed.length > 0) {
        console.log(`[ArtifactDomain] startup orphan GC: removed=${r.removed.length}, failed=${r.failed.length}`);
      }
    })
    .catch((e) => console.error("[ArtifactDomain] startup orphan GC 失败:", e));

  return { service, coordinator };
}
