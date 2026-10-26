import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { shell } from "electron";
import type { UserFontDto } from "../shared/agent-ipc";
import { getFontsDir } from "./paths";
import { listSystemFonts as listSystemFontsFromPlatform } from "./platform/fonts";

const FONT_EXTS = new Set([".ttf", ".otf", ".woff", ".woff2"]);

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function formatOf(ext: string): UserFontDto["format"] {
  switch (ext.toLowerCase()) {
    case ".otf":
      return "opentype";
    case ".woff":
      return "woff";
    case ".woff2":
      return "woff2";
    default:
      return "truetype";
  }
}

/** 从文件名生成可读 CSS family（去扩展名，-/_ 转空格） */
export function familyFromFileName(fileName: string): string {
  const base = basename(fileName, extname(fileName))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base || "Custom Font";
}

function safeId(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  const stem = basename(fileName, extname(fileName))
    .replace(/[^\w.\u4e00-\u9fff-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return `${stem || "font"}${ext}`;
}

function toDto(fileName: string): UserFontDto {
  const ext = extname(fileName).toLowerCase();
  return {
    id: fileName,
    family: familyFromFileName(fileName),
    fileName,
    format: formatOf(ext),
  };
}

/**
 * 用户字体：落盘 ~/.mybuddy/fonts/，供 UI 用 FontFace 加载。
 */
export class UserFontsStore {
  private systemFontsCache: string[] | null = null;

  private dir(): string {
    const d = getFontsDir();
    ensureDir(d);
    return d;
  }

  list(): UserFontDto[] {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => FONT_EXTS.has(extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, "zh"))
      .map((fileName) => {
        const dto = toDto(fileName);
        try {
          const metaPath = join(dir, `${fileName}.json`);
          if (!existsSync(metaPath)) return dto;
          const raw = JSON.parse(readFileSync(metaPath, "utf-8")) as { family?: unknown };
          return typeof raw.family === "string" && raw.family.trim()
            ? { ...dto, family: raw.family.trim() }
            : dto;
        } catch {
          return dto;
        }
      });
  }

  /**
   * 系统已安装字体（family 名）。平台实现见 `platform/fonts.ts`：
   *   Windows = PowerShell InstalledFontCollection → 注册表兜底（逻辑逐字搬迁）；
   *   Linux   = fontconfig 的 `fc-list --format=%{family}\n`；
   *   macOS   = []（尚未接入原生字体 API）。
   * 仅缓存非空结果，避免一次临时失败把“0 个字体”缓存到整个进程生命周期。
   */
  listSystemFonts(): string[] {
    if (this.systemFontsCache?.length) return [...this.systemFontsCache];
    const list = listSystemFontsFromPlatform();
    if (list.length) this.systemFontsCache = list;
    return [...list];
  }

  /** 从本地路径复制到 fonts 目录；同名覆盖 */
  importFromPath(sourcePath: string): UserFontDto {
    const ext = extname(sourcePath).toLowerCase();
    if (!FONT_EXTS.has(ext)) {
      throw new Error("仅支持 .ttf / .otf / .woff / .woff2 字体文件");
    }
    const dir = this.dir();
    let id = safeId(basename(sourcePath));
    // 若源路径已在 fonts 内则直接返回
    const dest = join(dir, id);
    if (sourcePath !== dest) {
      // 避免不同源同 id 冲突时覆盖前先确认 id 唯一（同名覆盖可接受）
      copyFileSync(sourcePath, dest);
    }
    // 写一份 sidecar 方便以后扩展元数据（family 覆盖等）
    const metaPath = join(dir, `${id}.json`);
    const dto = toDto(id);
    try {
      writeFileSync(metaPath, `${JSON.stringify({ family: dto.family, importedAt: Date.now() }, null, 2)}\n`);
    } catch {
      /* optional */
    }
    return dto;
  }

  private resolveInFontsDir(id: string): string {
    const dir = resolve(this.dir());
    const file = resolve(dir, basename(id));
    if (file !== dir && !file.startsWith(dir + "\\") && !file.startsWith(dir + "/")) {
      throw new Error("非法字体 id");
    }
    return file;
  }

  remove(id: string): void {
    const file = this.resolveInFontsDir(id);
    if (existsSync(file)) unlinkSync(file);
    const meta = `${file}.json`;
    if (existsSync(meta)) unlinkSync(meta);
  }

  readBytes(id: string): Buffer {
    const file = this.resolveInFontsDir(id);
    if (!existsSync(file)) {
      throw new Error(`字体不存在: ${id}`);
    }
    return readFileSync(file);
  }

  async openDir(): Promise<string> {
    const dir = this.dir();
    // shell.openPath 成功返回 ""，失败返回错误信息字符串
    const err = await shell.openPath(dir);
    if (err) {
      throw new Error(`无法打开字体目录：${err}`);
    }
    return dir;
  }
}
