import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import JSZip from "jszip";
import { getConnectorsDir, getConnectorMarketDir, getPluginsDir, getSkillsDir } from "../paths";
import { connectorPlatformKey } from "../platform/apps";
import type { RuntimeAuditReader } from "../platform/runtime-audit";
import { editPluginConfig } from "../platform/plugin-config";

/**
 * 连接器（Connector）服务。
 *
 * 连接器 = 外部服务的 CLI 通道（官方 MyBuddy 格式）：
 *   connectors/<id>/
 *   ├── connector-meta.json   # 元信息：name/description/type/version/examples
 *   ├── cli.json              # CLI 运行时：init 安装命令 / versionCheck / auth 登录
 *   ├── icon.png              # 图标
 *   └── skills/               # 配套技能（SKILL.md 标准格式，一个子目录一个技能）
 *
 * 本应用暂不执行 CLI 运行时；「安装连接器」= ① 配套技能保存为 Connector Private Skills
 * （~/.mybuddy/plugins/connectors/<id>/skills/，不进入全局 Skill Center，随连接器生命周期）
 * ② 注册安装状态到 ~/.mybuddy/plugins/connectors/<id>/meta.json。CLI 本体需用户按卡片上的
 * init 命令自行安装。
 *
 * Active 语义：安装 ≠ active。已安装且 enabled（默认 true，可停用）的连接器，其
 * Private Skills 才会进入会话候选技能集（getPrivateSkillDirs）。requiresAuth 仅作信息
 * 展示（本应用不执行 CLI，无法验证 auth/ready 状态）。
 */

export interface LocalConnectorDto {
  id: string;
  name: string;
  description: string;
  /** meta.type，如 "cli" */
  type?: string;
  version?: string;
  examples?: string[];
  /** 当前平台的 CLI 安装命令（cli.json.init） */
  initCommand?: string;
  /** CLI 版本检查命令（cli.json.versionCheck.command） */
  versionCheckCommand?: string;
  iconPath?: string;
  /** 配套技能目录数 */
  skillCount: number;
  /** 已装技能名称列表 */
  installedSkillNames: string[];
  installed: boolean;
  /** 用户启用状态（安装默认 true；停用 = 私有技能不进入候选装配，安装 ≠ active） */
  enabled?: boolean;
  /** cli.json 声明了 auth 能力（本应用不执行 CLI，仅信息展示） */
  requiresAuth?: boolean;
  installedAt?: number;
  sourcePath: string;
}

interface ConnectorMeta {
  name?: string;
  name_en?: string;
  description?: string;
  description_zh?: string;
  description_en?: string;
  type?: string;
  version?: string;
  examples_zh?: string[];
  examples_en?: string[];
  source?: string;
}

/** 注册目录 meta.json（~/.mybuddy/plugins/connectors/<id>/meta.json） */
interface ConnectorRegistration {
  id?: string;
  name?: string;
  sourcePath?: string;
  installedAt?: number;
  installedSkillNames?: string[];
  /** 用户启用状态（缺省 = 启用，兼容旧安装） */
  enabled?: boolean;
}

interface CliJson {
  runtime?: { type?: string; version?: string };
  init?: Record<string, string>;
  versionCheck?: { command?: Record<string, string>; minVersion?: string };
  auth?: unknown;
}

function platformKey(): string {
  return connectorPlatformKey();
}

/** 本地市场根目录（含 connectors/ 子目录） */
function findLocalConnectorRoots(): string[] {
  const out: string[] = [];
  const appRoot = join(getConnectorMarketDir(), "connectors");
  if (existsSync(appRoot)) out.push(appRoot);
  const devRoot = join(process.cwd(), "mybuddyskills-main", "connectors");
  if (existsSync(devRoot)) out.push(devRoot);
  return out;
}

function normalizePathKey(p: string): string {
  return resolve(p).replace(/[/\\]+/g, sep).toLowerCase();
}

function isUnderRoots(target: string, roots: string[]): boolean {
  const t = normalizePathKey(target);
  return roots.some((root) => {
    const r = normalizePathKey(root);
    return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

function isAllowedMarketConnectorPath(target: string): boolean {
  const t = normalizePathKey(target);
  const markers = [
    `${sep}mybuddyskills-main${sep}connectors${sep}`,
    `${sep}connector-market${sep}connectors${sep}`,
  ];
  return markers.some((m) => t.includes(m));
}

function hiddenConnectorsPath(): string {
  return join(getPluginsDir(), "market-hidden-connectors.json");
}

function readHiddenConnectorIds(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(hiddenConnectorsPath(), "utf-8")) as string[];
    return new Set((raw ?? []).map((x) => x.toLowerCase()));
  } catch {
    return new Set();
  }
}

function writeHiddenConnectorIds(ids: Set<string>): void {
  writeFileSync(hiddenConnectorsPath(), JSON.stringify([...ids].sort(), null, 2), "utf-8");
}

function importedConnectorMarketRoot(): string {
  return join(getConnectorMarketDir(), "connectors");
}

/**
 * 解析已安装连接器的注册目录（~/.mybuddy/plugins/connectors/<id>/）。
 *
 * 注册目录名沿用「安装时连接器包目录名」的大小写（例如 demoX），而启用/停用、Active 判定、
 * 私有技能目录解析的入参 id 大小写不可控（往往被调用方 lowercase）。NTFS/APFS 默认大小写不敏感
 * 所以历史上没暴露，但 Linux 的 ext4 区分大小写 —— 必须按小写比对，找到真实目录名。
 * 非法 id（空、含路径分隔符）直接返回 null，避免越界访问。
 */
function resolveConnectorRegDir(id: string): string | null {
  const key = String(id ?? "").trim().toLowerCase();
  if (!key || /[\\/]/.test(key)) return null;
  const root = getConnectorsDir();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name.toLowerCase() !== key) continue;
    const dir = join(root, name);
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      /* 竞态删除：继续找 */
    }
  }
  return null;
}

function normalizeImportedConnectorId(raw: string): string {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!id) throw new Error("无法从连接器包确定有效 id");
  return id;
}

function findConnectorPackageDir(inputDir: string): string {
  const source = resolve(inputDir);
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error("连接器导入目录不存在");
  if (existsSync(join(source, "connector-meta.json")) || existsSync(join(source, "cli.json"))) return source;
  const candidates = readdirSync(source)
    .map((name) => join(source, name))
    .filter((candidate) => {
      try {
        return statSync(candidate).isDirectory() &&
          (existsSync(join(candidate, "connector-meta.json")) || existsSync(join(candidate, "cli.json")));
      } catch {
        return false;
      }
    });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error("目录中包含多个连接器，请直接选择其中一个连接器目录");
  throw new Error("不是有效的连接器目录：缺少 connector-meta.json / cli.json");
}

function ensureSafeZipRelativePath(raw: string): string[] {
  const segments = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`连接器 ZIP 含非法路径: ${raw}`);
  }
  return segments;
}

function unhideConnectorId(id: string): void {
  const hidden = readHiddenConnectorIds();
  if (!hidden.delete(id.toLowerCase())) return;
  writeHiddenConnectorIds(hidden);
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

interface CatalogConnector {
  name: string;
  dir: string;
  metadata: ConnectorMeta | null;
  cli: CliJson | null;
  iconPath?: string | null;
  skillNames: string[];
  installed: boolean;
  registration: ConnectorRegistration | null;
}

type NativeCatalogConnector = Omit<CatalogConnector, "metadata" | "cli" | "registration"> & {
  metadata: string | null;
  cli: string | null;
  registration: string | null;
};

function parseCatalogJson<T>(raw: string | null): T | null {
  try { return raw === null ? null : JSON.parse(raw) as T; } catch { return null; }
}

function connectorDto({ name, dir, metadata, cli, iconPath, skillNames, installed, registration }: CatalogConnector): LocalConnectorDto {
  return {
    id: name,
    name: metadata?.name || metadata?.name_en || name,
    description: metadata?.description_zh || metadata?.description || metadata?.description_en || "",
    type: metadata?.type,
    version: metadata?.version,
    examples: metadata?.examples_zh ?? metadata?.examples_en,
    initCommand: cli?.init?.[platformKey()],
    versionCheckCommand: cli?.versionCheck?.command?.[platformKey()],
    iconPath: iconPath ?? undefined,
    skillCount: skillNames.length,
    installedSkillNames: skillNames,
    installed,
    requiresAuth: Boolean(cli?.auth),
    installedAt: installed ? registration?.installedAt : undefined,
    ...(installed && { enabled: registration?.enabled !== false }),
    sourcePath: dir,
  };
}

function compareConnectors(a: LocalConnectorDto, b: LocalConnectorDto): number {
  return Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name, "zh");
}

export async function recoverConnectorInstallations(native?: RuntimeAuditReader): Promise<void> {
  for (const root of [getConnectorsDir(), importedConnectorMarketRoot()]) {
    if (!existsSync(join(dirname(root), ".mybuddy-connector-installs"))) continue;
    const result = await native?.recoverConnectorInstalls(root);
    if (result?.status === "recovered") {
      for (const warning of result.warnings) console.warn("[ConnectorService] 包目录恢复失败", warning);
    } else {
      console.warn("[ConnectorService] 包目录待恢复", result?.status === "failed" ? result.message : root);
    }
  }
}

export async function initializeConnectorStorage(native?: RuntimeAuditReader): Promise<void> {
  try {
    await recoverConnectorInstallations(native);
    const roots = findLocalConnectorRoots().filter(root => existsSync(join(dirname(root), ".mybuddy-connector-market-retired")));
    if (native && roots.length) {
      const result = await native.mutateConnectorMarket({ kind: "cleanup", roots });
      if (result?.status === "cleaned") {
        for (const warning of result.warnings) console.warn("[ConnectorService] 市场包清理失败", warning);
      }
    }
    const migrated = await new ConnectorService().maintainLegacySkills(native);
    if (migrated.migrated > 0 || migrated.removed > 0) {
      console.log(`[ConnectorService] legacy connector skills: moved=${migrated.migrated} removed=${migrated.removed}`);
    }
  } catch (error) {
    console.warn("[ConnectorService] 启动安装维护失败", error);
  }
}

export class ConnectorService {
  async readCatalog(native?: RuntimeAuditReader): Promise<LocalConnectorDto[]> {
    const rows = await native?.pluginCatalog<NativeCatalogConnector[]>({
      kind: "connectors", roots: findLocalConnectorRoots(), installedRoot: getConnectorsDir(),
      hiddenPath: hiddenConnectorsPath(),
    });
    if (!rows) return this.list();
    return rows.map(row => connectorDto({
      ...row, metadata: parseCatalogJson(row.metadata), cli: parseCatalogJson(row.cli),
      registration: parseCatalogJson(row.registration),
    })).sort(compareConnectors);
  }

  /** 扫描本地市场的全部连接器 */
  list(): LocalConnectorDto[] {
    const hidden = readHiddenConnectorIds();
    const out: LocalConnectorDto[] = [];
    const seenIds = new Set<string>();
    const installedRoot = getConnectorsDir();
    const installedIds = new Set(
      readdirSync(installedRoot)
        .filter((n) => {
          try {
            return statSync(join(installedRoot, n)).isDirectory();
          } catch {
            return false;
          }
        })
        .map((n) => n.toLowerCase()),
    );
    for (const root of findLocalConnectorRoots()) {
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        continue;
      }
      for (const name of names) {
        const normalizedId = name.toLowerCase();
        if (hidden.has(normalizedId) || seenIds.has(normalizedId)) continue;
        const dir = join(root, name);
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        const meta = readJson<ConnectorMeta>(join(dir, "connector-meta.json"));
        const cli = readJson<CliJson>(join(dir, "cli.json"));
        seenIds.add(normalizedId);
        const skillsDir = join(dir, "skills");
        // 兼容两种结构：skills/SKILL.md（单技能）与 skills/<sub>/SKILL.md（多技能）
        let skillNames: string[] = [];
        if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
          if (existsSync(join(skillsDir, "SKILL.md")) || existsSync(join(skillsDir, "skill.md"))) {
            skillNames = [basename(dir).toLowerCase()];
          } else {
            skillNames = readdirSync(skillsDir)
              .filter((n) => {
                try {
                  return statSync(join(skillsDir, n)).isDirectory();
                } catch {
                  return false;
                }
              })
              .map((n) => n.toLowerCase());
          }
        }
        const iconPath = ["icon.png", "icon.jpg", "icon.jpeg", "logo.png"].find((f) =>
          existsSync(join(dir, f)),
        );
        const installed = installedIds.has(normalizedId);
        const regDir = installed ? resolveConnectorRegDir(name) : null;
        out.push(connectorDto({
          name, dir, metadata: meta, cli, skillNames, installed,
          iconPath: iconPath ? join(dir, iconPath) : undefined,
          registration: regDir ? readJson<ConnectorRegistration>(join(regDir, "meta.json")) : null,
        }));
      }
    }
    return out.sort(compareConnectors);
  }

  /** 从本地目录导入连接器包到用户市场，并立即安装其 Private Skills。 */
  importDirectory(inputDir: string): LocalConnectorDto {
    const source = findConnectorPackageDir(inputDir);
    const id = normalizeImportedConnectorId(basename(source));
    this.copyImportedDirectoryOnHost(source, id);
    unhideConnectorId(id);
    this.install(id);
    return this.importedConnector(id, this.list());
  }

  async importDirectoryInBackground(inputDir: string, native?: RuntimeAuditReader): Promise<LocalConnectorDto> {
    if (!native) return this.importDirectory(inputDir);
    const source = findConnectorPackageDir(inputDir);
    const id = normalizeImportedConnectorId(basename(source));
    if (!await this.importIntoMarket(native, { kind: "directory", source, id })) {
      this.copyImportedDirectoryOnHost(source, id);
    }
    await this.unhideInBackground(id, native);
    await this.installInBackground(id, native);
    return this.importedConnector(id, await this.readCatalog(native));
  }

  private copyImportedDirectoryOnHost(source: string, id: string): void {
    const marketRoot = importedConnectorMarketRoot();
    const dest = join(marketRoot, id);
    mkdirSync(marketRoot, { recursive: true });

    if (normalizePathKey(source) !== normalizePathKey(dest)) {
      rmSync(dest, { recursive: true, force: true });
      cpSync(source, dest, { recursive: true });
    }
  }

  private importedConnector(id: string, catalog: LocalConnectorDto[]): LocalConnectorDto {
    const imported = catalog.find((item) => item.id.toLowerCase() === id);
    if (!imported) throw new Error("连接器导入完成，但无法从市场重新加载");
    return imported;
  }

  /** 从 ZIP 导入连接器包到用户市场，并立即安装；支持 ZIP 根目录或单层包目录。 */
  async importZip(zipPath: string, native?: RuntimeAuditReader): Promise<LocalConnectorDto> {
    const id = await this.importIntoMarket(native, { kind: "zip", source: resolve(zipPath) })
      ?? await this.unpackZipOnHost(zipPath);
    await this.unhideInBackground(id, native);
    await this.installInBackground(id, native);
    return this.importedConnector(id, await this.readCatalog(native));
  }

  private async importIntoMarket(
    native: RuntimeAuditReader | undefined, request: Parameters<RuntimeAuditReader["importConnectorMarket"]>[1],
  ): Promise<string | undefined> {
    if (!native) return;
    const result = await native.importConnectorMarket(importedConnectorMarketRoot(), request);
    if (result?.status === "imported") return result.id;
    if (result?.status === "needsHost") return;
    if (result?.status === "failed") throw new Error(`导入连接器失败：${result.message}`);
    throw new Error("未收到连接器导入确认，请刷新查看市场状态");
  }

  private async unhideInBackground(id: string, native?: RuntimeAuditReader): Promise<void> {
    if (!native) return unhideConnectorId(id);
    const result = await native.mutateConnectorMarket({ kind: "unhide", id, pluginRoot: getPluginsDir() });
    if (result?.status === "updated") return;
    if (result?.status === "needsHost") return unhideConnectorId(id);
    if (result?.status === "failed") throw new Error(`恢复市场连接器失败：${result.message}`);
    throw new Error("未收到恢复市场连接器的确认");
  }

  private async unpackZipOnHost(zipPath: string): Promise<string> {
    if (!existsSync(zipPath)) throw new Error("连接器 ZIP 文件不存在");
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    const fileNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    if (!fileNames.length) throw new Error("连接器 ZIP 为空");

    const marker = fileNames
      .filter((name) => /(^|\/)(connector-meta\.json|cli\.json)$/i.test(name.replace(/\\/g, "/")))
      .sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length)[0];
    if (!marker) throw new Error("不是有效的连接器 ZIP：缺少 connector-meta.json / cli.json");

    const markerNormalized = marker.replace(/\\/g, "/");
    const markerSlash = markerNormalized.lastIndexOf("/");
    const prefix = markerSlash >= 0 ? markerNormalized.slice(0, markerSlash + 1) : "";
    const sourceName = prefix
      ? prefix.slice(0, -1).split("/").filter(Boolean).pop() ?? basename(zipPath).replace(/\.zip$/i, "")
      : basename(zipPath).replace(/\.zip$/i, "");
    const id = normalizeImportedConnectorId(sourceName);
    const marketRoot = importedConnectorMarketRoot();
    const dest = join(marketRoot, id);
    mkdirSync(marketRoot, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });

    try {
      for (const entryName of fileNames) {
        const normalized = entryName.replace(/\\/g, "/");
        if (prefix && !normalized.startsWith(prefix)) continue;
        const relative = prefix ? normalized.slice(prefix.length) : normalized;
        if (!relative) continue;
        const segments = ensureSafeZipRelativePath(relative);
        if (!segments.length) continue;
        const target = join(dest, ...segments);
        if (!isUnderRoots(target, [dest])) throw new Error(`连接器 ZIP 路径越界: ${entryName}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, await zip.files[entryName].async("nodebuffer"));
      }
      findConnectorPackageDir(dest);
    } catch (error) {
      rmSync(dest, { recursive: true, force: true });
      throw error;
    }

    return id;
  }

  /**
   * 安装连接器：配套技能保存为 Connector Private Skills（~/.mybuddy/plugins/connectors/<id>/skills/），
   * 不进入全局 Skill Center；注册安装状态。
   * 旧版曾把配套技能复制到全局 ~/.mybuddy/plugins/skills（meta.source=connector:<id>）：
   * 安装时对 meta 校验过的自有副本做无损迁移（移动进连接器私有目录），不触碰用户全局技能。
   * 返回安装的技能名列表。
   */
  install(id: string): string[] {
    return this.installOnHost(this.findConnector(id, this.list()));
  }

  async installInBackground(id: string, native?: RuntimeAuditReader): Promise<string[]> {
    if (!native) return this.install(id);
    const connector = this.findConnector(id, await this.readCatalog(native));
    const result = await native.installConnector({
      root: getConnectorsDir(), legacySkillsRoot: getSkillsDir(), sourcePath: connector.sourcePath,
      id: connector.id, directory: connector.id.toLowerCase(), name: connector.name, installedAt: Date.now(),
    });
    if (result?.status === "installed") return result.names;
    if (result?.status === "needsHost") return this.installOnHost(connector);
    if (result?.status === "failed") throw new Error(`安装连接器失败：${result.message}`);
    throw new Error("未收到连接器安装确认，请刷新查看安装状态");
  }

  private findConnector(id: string, catalog: LocalConnectorDto[]): LocalConnectorDto {
    const key = id.trim().toLowerCase();
    const connector = catalog.find((c) => c.id.toLowerCase() === key || c.name.toLowerCase() === key);
    if (!connector) throw new Error(`未找到连接器: ${id}`);
    return connector;
  }

  private installOnHost(connector: LocalConnectorDto): string[] {
    // 注册安装状态：目录名统一用小写 id 落盘，并清理历史上大小写变体的遗留注册目录
    // （Windows 上 demoX/demox 指向同一目录，Linux 上会是两个目录 → 会读到过期状态）。
    const regDir = join(getConnectorsDir(), connector.id.toLowerCase());
    const legacyRegDir = resolveConnectorRegDir(connector.id);
    if (legacyRegDir && legacyRegDir !== regDir) rmSync(legacyRegDir, { recursive: true, force: true });
    if (existsSync(regDir)) rmSync(regDir, { recursive: true, force: true });
    mkdirSync(regDir, { recursive: true });

    const skillsDir = join(connector.sourcePath, "skills");
    const installedSkillNames: string[] = [];
    const skillsRoot = getSkillsDir();
    if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
      const destRoot = join(regDir, "skills");
      mkdirSync(destRoot, { recursive: true });
      // 单技能形式：skills/SKILL.md 直接复制整个目录
      if (existsSync(join(skillsDir, "SKILL.md")) || existsSync(join(skillsDir, "skill.md"))) {
        const dest = join(destRoot, connector.id.toLowerCase());
        cpSync(skillsDir, dest, { recursive: true });
        installedSkillNames.push(connector.id.toLowerCase());
      } else {
        for (const skillName of readdirSync(skillsDir)) {
          const src = join(skillsDir, skillName);
          try {
            if (!statSync(src).isDirectory()) continue;
          } catch {
            continue;
          }
          cpSync(src, join(destRoot, skillName.toLowerCase()), { recursive: true });
          installedSkillNames.push(skillName.toLowerCase());
        }
      }
      // 旧版全局副本迁移：仅移动 meta.source 校验为 connector:<id> 的目录，其余保留不动
      for (const name of installedSkillNames) {
        const legacy = join(skillsRoot, name);
        if (!existsSync(legacy)) continue;
        const meta = readJson<{ source?: string }>(join(legacy, "_skillhub_meta.json"));
        if (meta?.source === `connector:${connector.id}`) {
          try {
            rmSync(join(regDir, "skills", name), { recursive: true, force: true });
            cpSync(legacy, join(regDir, "skills", name), { recursive: true });
            rmSync(legacy, { recursive: true, force: true });
          } catch {
            /* 迁移失败保留原状（兼容读取），不阻断安装 */
          }
        }
      }
    }

    writeFileSync(
      join(regDir, "meta.json"),
      JSON.stringify(
        {
          id: connector.id,
          name: connector.name,
          sourcePath: connector.sourcePath,
          installedAt: Date.now(),
          installedSkillNames,
          enabled: true,
        },
        null,
        2,
      ),
      "utf-8",
    );
    return installedSkillNames;
  }

  /**
   * 启用/停用已安装连接器（Active 判定：installed + enabled）。
   * 停用后其 Private Skills 不再进入会话候选技能集（getPrivateSkillDirs 过滤）。
   */
  setEnabled(id: string, enabled: boolean): void {
    // 注册目录名大小写随安装时的包名，调用方传入的 id 大小写不可控 → 按大小写不敏感解析。
    const regDir = resolveConnectorRegDir(id);
    if (!regDir) {
      throw new Error(`连接器未安装: ${id}`);
    }
    this.writeConnectorEnabledOnHost(join(regDir, "meta.json"), enabled);
  }

  async writeEnabled(id: string, enabled: boolean, native?: RuntimeAuditReader): Promise<void> {
    const regDir = resolveConnectorRegDir(id);
    if (!regDir) throw new Error(`连接器未安装: ${id}`);
    const file = join(regDir, "meta.json");
    const saved = await editPluginConfig(native, "connector", [getConnectorsDir()], file, raw => {
      let reg: ConnectorRegistration | null = null;
      if (raw !== null) {
        try { reg = JSON.parse(raw) as ConnectorRegistration | null; } catch { /* recover an incomplete registration */ }
      }
      return this.connectorEnabledText(reg, enabled);
    });
    if (!saved) this.writeConnectorEnabledOnHost(file, enabled);
  }

  private writeConnectorEnabledOnHost(file: string, enabled: boolean): void {
    writeFileSync(file, this.connectorEnabledText(readJson<ConnectorRegistration>(file), enabled), "utf-8");
  }

  private connectorEnabledText(registration: ConnectorRegistration | null, enabled: boolean): string {
    const reg = registration ?? {};
    reg.enabled = enabled;
    return JSON.stringify(reg, null, 2);
  }

  /** Active = installed + enabled；Runtime resolution 与 Private Skills 共用此门禁。 */
  isActive(id: string): boolean {
    const normalized = String(id ?? "").trim().toLowerCase();
    if (!normalized || /[\\/]/.test(normalized)) return false;
    const regDir = resolveConnectorRegDir(normalized);
    if (!regDir) return false;
    const reg = readJson<ConnectorRegistration>(join(regDir, "meta.json"));
    return reg?.enabled !== false;
  }

  /**
   * 删除本地安装：移除注册目录（Connector Private Skills 随包消失）。
   * 兼容旧版：全局 ~/.mybuddy/plugins/skills 中 meta.source 校验为 connector:<id> 的历史副本一并清理；
   * 非自有/共享技能绝不动。
   */
  uninstall(id: string): void {
    // 不依赖 list()（会过滤隐藏项）：直接按大小写不敏感解析注册目录
    let regDir: string | null = resolveConnectorRegDir(id);
    let connectorId = id;
    // 再按 list 匹配 name
    if (!regDir) {
      const connector = this.list().find((c) => c.id === id || c.name === id);
      if (!connector?.installed) throw new Error(`连接器未安装: ${id}`);
      regDir = resolveConnectorRegDir(connector.id) ?? join(getConnectorsDir(), connector.id.toLowerCase());
      connectorId = connector.id;
    }
    // 旧版全局副本清理（meta 校验过才删，防误删共享技能）
    const reg = readJson<{ installedSkillNames?: string[] }>(join(regDir, "meta.json"));
    const skillNames = Array.isArray(reg?.installedSkillNames) ? reg.installedSkillNames : [];
    const skillsRoot = getSkillsDir();
    for (const name of skillNames) {
      if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\0]/.test(name)) continue;
      const skillDir = join(skillsRoot, name);
      if (!existsSync(skillDir)) continue;
      const meta = readJson<{ source?: string }>(join(skillDir, "_skillhub_meta.json"));
      if (meta?.source === `connector:${connectorId}` || meta?.source === `connector:${id}`) {
        rmSync(skillDir, { recursive: true, force: true });
      }
    }
    rmSync(regDir, { recursive: true, force: true });
  }

  async uninstallInBackground(id: string, native?: RuntimeAuditReader): Promise<void> {
    if (!native) return this.uninstall(id);
    const run = (candidate: string) => native.maintainConnectorStorage(
      getConnectorsDir(), getSkillsDir(), { kind: "uninstall", id: candidate },
    );
    let result = await run(id);
    if (result?.status === "missing") {
      const connector = (await this.readCatalog(native)).find(item => item.id === id || item.name === id);
      if (!connector?.installed) throw new Error(`连接器未安装: ${id}`);
      result = await run(connector.id);
    }
    if (result?.status === "uninstalled") {
      if (result.warning) console.warn("[ConnectorService] 卸载后文件待清理", result.warning);
      return;
    }
    if (result?.status === "needsHost") return this.uninstall(id);
    if (result?.status === "missing") throw new Error(`连接器未安装: ${id}`);
    if (result?.status === "failed") throw new Error(`卸载连接器失败：${result.message}`);
    throw new Error("未收到连接器卸载确认，请刷新查看安装状态");
  }

  /**
   * 当前 Active 连接器的 Private Skills 目录（~/.mybuddy/plugins/connectors/<id>/skills/）。
   * Active = 已安装 + enabled（默认 true）。只返回实际已安装且未停用连接器的目录；
   * 不存在/未安装/非法 id 静默跳过。
   */
  getPrivateSkillDirs(ids: string[]): string[] {
    const out: string[] = [];
    for (const raw of ids ?? []) {
      const id = String(raw ?? "").trim().toLowerCase();
      if (!id || /[\\/]/.test(id)) continue;
      // 注册目录名可能保留安装时的大小写（demoX），必须大小写不敏感解析
      const regDir = resolveConnectorRegDir(id);
      if (!regDir || !this.isActive(id)) continue;
      const dir = join(regDir, "skills");
      if (!existsSync(dir)) continue;
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push(dir);
    }
    return out;
  }

  /**
   * 旧版全局技能副本安全迁移（幂等，boot/install 时调用）：
   * 旧版把连接器配套技能复制到 ~/.mybuddy/plugins/skills（_skillhub_meta.json source=connector:<id>）。
   * 仅当 ① meta 归属校验通过 ② 连接器已安装注册（connectors/<id> 存在）时迁移：
   * - 目标目录已存在（新安装已复制，可能大小写不同）→ 删除旧全局副本（归属校验过）；
   * - 否则移动进连接器私有目录；
   * 注册缺失（连接器已被市场删除/从未在新版安装）→ 保留原处，绝不误删；
   * 无归属 meta 的用户/共享全局技能 → 绝不触碰。
   * 失败只报告（console.warn），不阻断启动。
   */
  migrateLegacyGlobalSkills(): { migrated: number; removed: number; skipped: number } {
    const stats = { migrated: 0, removed: 0, skipped: 0 };
    const skillsRoot = getSkillsDir();
    if (!existsSync(skillsRoot)) return stats;
    for (const name of readdirSync(skillsRoot)) {
      if (/[\\/]/.test(name)) {
        stats.skipped += 1;
        continue;
      }
      const dir = join(skillsRoot, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        stats.skipped += 1;
        continue;
      }
      const meta = readJson<{ source?: string }>(join(dir, "_skillhub_meta.json"));
      const match = /^connector:(.+)$/.exec(meta?.source ?? "");
      if (!match) continue; // 无归属/非连接器技能：绝不触碰
      const connectorId = match[1].trim().toLowerCase();
      if (!connectorId || /[\\/]/.test(connectorId)) {
        stats.skipped += 1;
        continue;
      }
      // 大小写不敏感解析注册目录（注册名保留安装时大小写，Linux 上不能直接 join 小写 id）
      const regDir = resolveConnectorRegDir(connectorId);
      if (!regDir) continue; // 注册缺失：保留
      const destRoot = join(regDir, "skills");
      try {
        const target = join(destRoot, name.toLowerCase());
        if (existsSync(target)) {
          // 新安装已复制同名（或大小写变体）：仅清理旧全局副本
          rmSync(dir, { recursive: true, force: true });
          stats.removed += 1;
          continue;
        }
        // 大小写不敏感碰撞检查：目标目录里已有同名不同大小写 → 视为已迁移，仅清旧副本
        const existingChild = existsSync(destRoot)
          ? readdirSync(destRoot).find((n) => n.toLowerCase() === name.toLowerCase())
          : undefined;
        if (existingChild) {
          rmSync(dir, { recursive: true, force: true });
          stats.removed += 1;
          continue;
        }
        mkdirSync(destRoot, { recursive: true });
        cpSync(dir, target, { recursive: true });
        rmSync(dir, { recursive: true, force: true });
        stats.migrated += 1;
      } catch (err) {
        stats.skipped += 1;
        console.warn(
          `[ConnectorService] migrate legacy skill failed: ${dir} · ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return stats;
  }

  async maintainLegacySkills(native?: RuntimeAuditReader): Promise<{ migrated: number; removed: number; skipped: number }> {
    if (!native) return this.migrateLegacyGlobalSkills();
    const result = await native.maintainConnectorStorage(getConnectorsDir(), getSkillsDir(), { kind: "startup" });
    if (result?.status === "maintained") {
      for (const warning of result.warnings) console.warn("[ConnectorService] 启动安装维护", warning);
      return { migrated: result.migrated, removed: result.removed, skipped: result.skipped };
    }
    if (result?.status === "needsHost") return this.migrateLegacyGlobalSkills();
    if (result?.status === "failed") throw new Error(result.message);
    throw new Error("未收到旧版连接器技能整理确认");
  }

  /**
   * 从市场删除连接器包（磁盘源目录），若已安装一并卸载本地。
   * 无磁盘路径时写入隐藏列表。
   */
  deleteFromMarket(id: string): void {
    const key = id.trim();
    if (!key) throw new Error("连接器 id 为空");

    let sourcePath: string | null = null;
    let connectorId = key;
    const listed = this.list().find(
      (c) => c.id === key || c.name === key || c.id.toLowerCase() === key.toLowerCase(),
    );
    if (listed) {
      sourcePath = listed.sourcePath;
      connectorId = listed.id;
    } else {
      for (const root of findLocalConnectorRoots()) {
        // 目录名可能与 id 大小写不同
        let names: string[] = [];
        try {
          names = readdirSync(root);
        } catch {
          continue;
        }
        const hit = names.find((n) => n.toLowerCase() === key.toLowerCase());
        if (hit) {
          sourcePath = join(root, hit);
          connectorId = hit;
          break;
        }
      }
    }
    if (!sourcePath || !existsSync(sourcePath)) {
      const hidden = readHiddenConnectorIds();
      hidden.add(connectorId.toLowerCase());
      writeHiddenConnectorIds(hidden);
      try {
        this.uninstall(connectorId);
      } catch {
        /* ignore */
      }
      return;
    }
    if (
      !isUnderRoots(sourcePath, findLocalConnectorRoots()) &&
      !isAllowedMarketConnectorPath(sourcePath)
    ) {
      throw new Error(`拒绝删除市场外路径: ${sourcePath}`);
    }
    try {
      this.uninstall(connectorId);
    } catch {
      /* 未安装忽略 */
    }
    try {
      rmSync(sourcePath, { recursive: true, force: true });
    } catch (err) {
      throw new Error(
        `删除市场连接器目录失败: ${sourcePath} · ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async deleteFromMarketInBackground(id: string, native?: RuntimeAuditReader): Promise<void> {
    if (!native) return this.deleteFromMarket(id);
    const key = id.trim();
    if (!key) throw new Error("连接器 id 为空");
    const listed = (await this.readCatalog(native)).find(item => item.name === key || item.id.toLowerCase() === key.toLowerCase());
    const result = await native.mutateConnectorMarket({
      kind: "delete", id: listed?.id ?? key, roots: findLocalConnectorRoots(),
      pluginRoot: getPluginsDir(), installedRoot: getConnectorsDir(), legacySkillsRoot: getSkillsDir(),
    });
    if (result?.status === "deleted") {
      for (const warning of result.warnings) console.warn("[ConnectorService] 删除后文件待清理", warning);
      return;
    }
    if (result?.status === "needsHost") return this.deleteFromMarket(id);
    if (result?.status === "failed") throw new Error(`删除连接器失败：${result.message}`);
    throw new Error("未收到连接器删除确认，请刷新查看市场状态");
  }
}
