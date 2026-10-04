import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getMyBuddyDir } from "../paths";
import type { BackupKind, FileBackupInfoDto } from "../../shared/agent-ipc";

/**
 * 读取和手动还原旧版本留下的历史备份。
 *
 * 存储结构（每个任务一个目录 + 一份 manifest）：
 *   ~/.mybuddy/backups/<taskId>/<backupId>.bak   ← 修改/删除前的原始内容（目录时是整棵副本）
 *   ~/.mybuddy/backups/<taskId>/manifest.json    ← backupId → { absPath, relPath, createdAt, size, kind, isDir }
 *
 * 不创建新备份，也不修改历史 manifest。
 */
interface ManifestEntry {
  absPath: string;
  relPath: string;
  createdAt: number;
  size: number;
  taskId: string;
  /** modified = 修改前备份；deleted = 删除前备份 */
  kind: BackupKind;
  /** 备份对象是目录（删除目录时保留整棵副本） */
  isDir: boolean;
}

/** 任务 ID 中的非法路径字符替换为下划线（gw-xxx / local-xxx 本身安全，仅兜底） */
function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[\\/:*?"<>|]/g, "_");
}

export class FileBackupService {
  constructor(private readonly rootDir?: string) {}

  private backupRoot(): string {
    return join(this.rootDir ?? getMyBuddyDir(), "backups");
  }

  private taskDir(taskId: string): string {
    return join(this.backupRoot(), sanitizeTaskId(taskId));
  }

  private manifestPath(taskId: string): string {
    return join(this.taskDir(taskId), "manifest.json");
  }

  private readManifest(taskId: string): Map<string, ManifestEntry> {
    const path = this.manifestPath(taskId);
    if (!existsSync(path)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, Partial<ManifestEntry>>;
      return new Map(
        Object.entries(raw)
          .filter(([, e]) => e && typeof e.absPath === "string")
          .map(([backupId, e]) => [
            backupId,
            {
              absPath: e.absPath as string,
              relPath: e.relPath ?? basename(e.absPath as string),
              createdAt: e.createdAt ?? 0,
              size: e.size ?? 0,
              taskId: e.taskId ?? "",
              // 旧版本 manifest 无 kind/isDir：一律按「修改前备份的文件」处理
              kind: e.kind === "deleted" ? "deleted" : "modified",
              isDir: e.isDir === true,
            },
          ]),
      );
    } catch {
      return new Map();
    }
  }

  private toDto(taskId: string, backupId: string, entry: ManifestEntry): FileBackupInfoDto {
    return {
      backupId,
      absPath: entry.absPath,
      relPath: entry.relPath,
      backupPath: join(this.taskDir(taskId), `${backupId}.bak`),
      createdAt: entry.createdAt,
      size: entry.size,
      taskId,
      kind: entry.kind,
      isDir: entry.isDir,
    };
  }

  /** 列出备份。taskId 缺省时列出全部任务的备份，按时间倒序（新 → 旧）。 */
  listBackups(taskId?: string): FileBackupInfoDto[] {
    const root = this.backupRoot();
    if (!existsSync(root)) return [];

    const ids = taskId ? [taskId] : readdirSync(root).filter((name) => name !== "." && name !== "..");
    const out: FileBackupInfoDto[] = [];
    for (const id of ids) {
      for (const [backupId, entry] of this.readManifest(id)) {
        out.push(this.toDto(id, backupId, entry));
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 将某份备份写回原始路径（覆盖）。备份文件缺失时抛错。 */
  restoreBackup(taskId: string, backupId: string): FileBackupInfoDto {
    const manifest = this.readManifest(taskId);
    const entry = manifest.get(backupId);
    if (!entry) throw new Error(`备份不存在: ${backupId}`);

    const backupPath = join(this.taskDir(taskId), `${backupId}.bak`);
    if (!existsSync(backupPath)) throw new Error(`备份文件缺失: ${backupPath}`);

    const target = entry.absPath;
    if (entry.isDir) {
      // 目录恢复：先移除当前路径（无论文件/目录），再整棵拷回
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      const dir = dirname(target);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      cpSync(backupPath, target, { recursive: true });
    } else {
      const dir = dirname(target);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      copyFileSync(backupPath, target);
    }
    return this.toDto(taskId, backupId, entry);
  }
}
