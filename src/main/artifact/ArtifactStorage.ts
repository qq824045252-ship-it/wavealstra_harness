/**
 * ArtifactStorage — V3.5 Wave 2（§5）
 *
 * 职责：managed-content 物理落盘 / 读取 / 删除 / orphan 扫描 / 路径生成 / rootDir 管理。
 * 目录：<root>/<taskId>/<artifactId>/index.<ext>
 * 约束：稳定、可恢复、可删除、可定位、不与 workspace 混淆（root 默认 ~/.mybuddy/artifacts）。
 *
 * 不持有 metadata；metadata 真相在 ArtifactRepository。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const KIND_EXT: Record<string, string> = {
  markdown: "md",
  code: "txt",
  html: "html",
  svg: "svg",
  image: "bin",
  video: "bin",
  audio: "bin",
  pdf: "pdf",
  office: "bin",
};

export class ArtifactStorage {
  constructor(private readonly rootDir: string) {}

  get root(): string {
    return this.rootDir;
  }

  /** 生成 managed-content 落盘路径（相对 root）并写入；失败抛错（materialize fail） */
  materialize(taskId: string, artifactId: string, content: string, kind: string): string {
    const ext = KIND_EXT[kind] ?? "txt";
    const relativePath = join(taskId, artifactId, `index.${ext}`);
    const absolute = join(this.rootDir, relativePath);
    mkdirSync(join(this.rootDir, taskId, artifactId), { recursive: true });
    writeFileSync(absolute, content, "utf-8");
    return relativePath;
  }

  read(storagePath: string): string | null {
    const absolute = this.resolve(storagePath);
    if (absolute === null || !existsSync(absolute) || !statSync(absolute).isFile()) return null;
    return readFileSync(absolute, "utf-8");
  }

  exists(storagePath: string): boolean {
    const absolute = this.resolve(storagePath);
    return absolute !== null && existsSync(absolute) && statSync(absolute).isFile();
  }

  /** 删除 managed-content；返回是否成功（失败 → orphan，由 GC 后续清理） */
  remove(storagePath: string): boolean {
    try {
      const absolute = this.resolve(storagePath);
      if (absolute === null) return true; // 路径逃逸防御：视为已清理
      if (!existsSync(absolute)) return true;
      rmSync(absolute, { force: true });
      this.removeEmptyParents(absolute);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * orphan 候选：root 下存在文件但不在 known（repository rows）集合中。
   * 返回相对路径列表（§14 startup orphan GC 扫描用）
   */
  orphanCandidates(known: Set<string>): string[] {
    const orphans: string[] = [];
    if (!existsSync(this.rootDir)) return orphans;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          const rel = relative(this.rootDir, full).replace(/\\/g, "/");
          if (!known.has(rel)) orphans.push(rel);
        }
      }
    };
    walk(this.rootDir);
    return orphans;
  }

  /** 解析相对路径 → 绝对；防路径逃逸（root 之外一律 null） */
  resolve(storagePath: string): string | null {
    const absolute = join(this.rootDir, storagePath);
    if (absolute !== this.rootDir && !absolute.startsWith(this.rootDir + sep)) {
      return null;
    }
    return absolute;
  }

  private removeEmptyParents(absolute: string): void {
    let dir = join(absolute, "..");
    while (dir !== this.rootDir && dir.startsWith(this.rootDir)) {
      try {
        const entries = readdirSync(dir);
        if (entries.length > 0) break;
        // 注意：force:true 只忽略不存在的目标，删目录必须 recursive（Node ≥20 对目录抛 EISDIR）
        rmSync(dir, { recursive: true, force: true });
      } catch {
        break;
      }
      dir = join(dir, "..");
    }
  }
}
