import { createHash, randomUUID } from "node:crypto";
import { pathKey, resolvedPathKey } from "../platform/paths";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { loadSkills, loadSkillsFromDir, type ResourceDiagnostic, type Skill as PiSkill } from "@earendil-works/pi-coding-agent";
import type { SkillDto } from "../../shared/agent-ipc";
import { getExpertMarketDir, getPluginsDir, getMyBuddyDir, getSkillsDir } from "../paths";
import { DIMAGENT_DEBUG_SKILL_ID, DIMAGENT_DEBUG_SKILL_MD } from "./BuiltinSkills";

export interface MarketSkillDto {
  id: string;
  name: string;
  description: string;
  author: string;
  icon: string;
  version?: string;
  /** 本地可复制源目录；无则安装时写入内置内容/模板 */
  sourcePath?: string;
  /** 内置完整 SKILL.md 内容；用于随应用打包而不依赖外部市场目录。 */
  content?: string;
  /** 市场来源分类：local=内置/MyBuddy；mybuddy=MyBuddy 归档 */
  source?: "local" | "mybuddy";
}

export interface LearnedSkillMetadata {
  skillId: string;
  candidateId?: string;
  sourceMemoryIds: string[];
  scopeType?: "global" | "workspace" | "project";
  scopeId?: string;
  filePath: string;
}

export interface LearnedSkillRevisionSource {
  skillId: string;
  candidateId?: string;
  version: string;
  title: string;
  description: string;
  instructions: string;
  contentHash: string;
  sourceMemoryIds: string[];
  scopeType: "global" | "workspace" | "project";
  scopeId?: string;
  filePath: string;
}

export interface RuntimeSkillSelection {
  skills: PiSkill[];
  dtos: SkillDto[];
  diagnostics: ResourceDiagnostic[];
  shadowedExtraSkillNames: string[];
}

/**
 * 脚本文件的技能归属。
 *
 * frontmatter 的值可能是字符串或数组：依赖声明常写成 YAML 列表，
 * 扁平解析会把它变成空字符串、让声明静默失效，所以这里保留原始形状。
 */
export interface SkillScriptOwner {
  name: string;
  /** 技能根目录（绝对路径），脚本必须落在它内部才允许执行 */
  baseDir: string;
  frontmatter: Record<string, unknown>;
}

export interface LearnedSkillInstallInput {
  candidateId: string;
  slug: string;
  title: string;
  description: string;
  instructions: string;
  sourceMemoryIds: string[];
  scopeType: "global" | "workspace" | "project";
  scopeId?: string;
  version?: string;
  supersedesCandidateId?: string;
}

const BUILTIN_MARKET: MarketSkillDto[] = [
  {
    id: DIMAGENT_DEBUG_SKILL_ID,
    name: DIMAGENT_DEBUG_SKILL_ID,
    description: "DimAgent 风格证据优先调试：先真实复现、做对照、验证测试本身，再最小修复并原路径重放。",
    author: "MyBuddy",
    icon: "🧪",
    version: "1.0.0",
    source: "local",
    content: DIMAGENT_DEBUG_SKILL_MD,
  },
  {
    id: "hello-buddy",
    name: "hello-buddy",
    description: "示例技能：用友好的方式打个招呼，演示技能安装与 /skill 命令。",
    author: "MyBuddy",
    icon: "👋",
    version: "1.0.0",
    source: "local",
  },
  {
    id: "weekly-summary",
    name: "weekly-summary",
    description: "根据对话与工作区改动整理本周工作摘要，适合周报草稿。",
    author: "MyBuddy",
    icon: "📝",
    version: "1.0.0",
    source: "local",
  },
];

/**
 * 聚合根目录顶层 stray SKILL.md 的检疫文件名。
 * ~/.mybuddy/plugins/skills 是聚合根（每个子目录一个技能）；顶层 SKILL.md 是非法扁平安装
 * （曾因 fcp 扁平复制产生）。pi SDK 会把聚合根当成单一 top-level 技能并停止下钻，
 * 导致全部子目录技能静默只剩 1 个——必须隔离而不是静默放行。
 */
export const STRAY_ROOT_SKILL_QUARANTINE_NAME = "SKILL.md.stray";
const SWAP_READY_MARKER = ".mybuddy-swap-ready";

/**
 * Recover only MyBuddy's own staged directory names. A backup is authoritative
 * until the staged directory has been renamed to the final destination; after
 * that rename the destination is authoritative and the backup is cleanup debt.
 */
function recoverInterruptedSkillSwaps(root: string): void {
  ensureDir(root);
  const pattern = /^\.([a-z0-9][a-z0-9-]*)\.(authoring|learned)-.+\.(tmp|bak)$/;
  const artifacts = readdirSync(root).map((name) => ({ name, match: name.match(pattern) })).filter(
    (item): item is { name: string; match: RegExpMatchArray } => Boolean(item.match),
  );
  const groups = new Map<string, { id: string; tmp?: string; bak?: string }>();
  for (const artifact of artifacts) {
    const [, id, channel, kind] = artifact.match;
    const key = `${id}:${channel}:${artifact.name.slice(0, -4)}`;
    const group = groups.get(key) ?? { id };
    group[kind as "tmp" | "bak"] = join(root, artifact.name);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const dest = join(root, group.id);
    if (group.bak && existsSync(group.bak)) {
      if (existsSync(dest)) {
        rmSync(group.bak, { recursive: true, force: true });
        rmSync(join(dest, SWAP_READY_MARKER), { force: true });
      } else {
        if (group.tmp) rmSync(group.tmp, { recursive: true, force: true });
        renameSync(group.bak, dest);
      }
      continue;
    }
    if (!group.tmp || !existsSync(group.tmp)) continue;
    const ready = existsSync(join(group.tmp, SWAP_READY_MARKER));
    if (!existsSync(dest) && ready) {
      renameSync(group.tmp, dest);
      rmSync(join(dest, SWAP_READY_MARKER), { force: true });
    } else {
      rmSync(group.tmp, { recursive: true, force: true });
    }
  }
  // A crash immediately after the final rename may leave no tmp/bak artifact,
  // only the ready marker inside the committed destination.
  for (const name of readdirSync(root)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue;
    try { if (!statSync(join(root, name)).isDirectory()) continue; } catch { continue; }
    rmSync(join(root, name, SWAP_READY_MARKER), { force: true });
  }
}

/**
 * 隔离聚合根目录顶层 stray SKILL.md（仅针对 ~/.mybuddy/plugins/skills 聚合根，绝不碰子目录）。
 * 优先重命名到明确 stray 名；失败时保留原文件但给出明确诊断（loadSkills 仍可能被
 * 遮蔽，日志会指出）。幂等：已隔离/不存在时直接返回 false。
 */
function quarantineStrayRootSkill(): { moved: boolean; detail?: string } {
  const root = getSkillsDir();
  const stray = join(root, "SKILL.md");
  if (!existsSync(stray)) return { moved: false };
  const target = join(root, STRAY_ROOT_SKILL_QUARANTINE_NAME);
  try {
    if (existsSync(target)) {
      // 旧检疫残留（前一次隔离后用户又放回同名文件）→ 覆盖仅限 stray 名
      rmSync(target, { force: true });
    }
    renameSync(stray, target);
    const detail = `聚合根目录顶层 SKILL.md 已隔离为 ${STRAY_ROOT_SKILL_QUARANTINE_NAME}（非法扁平安装；子目录技能不受影响）`;
    console.warn(`[SkillsService] ${detail}`);
    return { moved: true, detail };
  } catch (error) {
    const detail = `聚合根目录顶层 SKILL.md 隔离失败：${error instanceof Error ? error.message : String(error)}；技能发现可能被 pi SDK 遮蔽，请手动移除 ${stray}`;
    console.warn(`[SkillsService] ${detail}`);
    return { moved: false, detail };
  }
}

/**
 * 列表前守卫：聚合根目录顶层 SKILL.md 会遮蔽全部子目录技能（pi SDK 停止递归），
 * 必须隔离后再扫描。listInstalled / listShadowedSkillNames 等 loadSkills 路径共用。
 */
function guardStrayRootSkillBeforeScan(): void {
  recoverInterruptedSkillSwaps(getSkillsDir());
  quarantineStrayRootSkill();
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 本地市场根目录（含 skills/ 子目录）：项目内 mybuddyskills-main + 应用级 expert-market 旁路 */
export function findLocalSkillMarketDirs(): string[] {
  const out: string[] = [];
  const appRoot = join(getExpertMarketDir(), "skills");
  if (existsSync(appRoot)) out.push(appRoot);
  const devRoot = join(process.cwd(), "mybuddyskills-main", "skills");
  if (existsSync(devRoot)) out.push(devRoot);
  return out;
}

function readFrontmatter(skillMd: string): { body: string; fm: Record<string, string> } {
  if (!skillMd.startsWith("---")) return { body: skillMd, fm: {} };
  const end = skillMd.indexOf("\n---", 3);
  if (end < 0) return { body: skillMd, fm: {} };
  const raw = skillMd.slice(3, end).trim();
  const body = skillMd.slice(end + 4).replace(/^\r?\n/, "");
  const fm: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    fm[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return { body, fm };
}

/**
 * frontmatter → 值表，额外支持 YAML 列表。
 *
 * 为什么不直接改 readFrontmatter：那份要负责写回（writeFrontmatter），必须保持扁平。
 * 但技能声明 Python 依赖时自然会写成列表：
 *   python-dependencies:
 *     - PyMuPDF>=1.23
 * 扁平解析只能得到空字符串，依赖声明静默丢失、环境退化成基础环境——
 * 这正是「不能悄悄降级」要避免的形态，所以这里单独解析列表。
 */
function readFrontmatterValues(skillMd: string): Record<string, unknown> {
  const normalized = skillMd.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return {};
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return {};
  const fm: Record<string, unknown> = {};
  let key: string | null = null;
  for (const line of normalized.slice(3, end).split(/\r?\n/)) {
    const item = line.match(/^\s+-\s*(.+)$/);
    if (item && key) {
      const existing = fm[key];
      // 标量后面接列表项时丢弃标量：`key:` 空值只是列表的引导行
      const list = Array.isArray(existing) ? (existing as string[]) : [];
      list.push(item[1].replace(/^["']|["']$/g, "").trim());
      fm[key] = list;
      continue;
    }
    const flat = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!flat) continue;
    key = flat[1];
    fm[key] = flat[2].replace(/^["']|["']$/g, "").trim();
  }
  return fm;
}

/** frontmatter 单行序列化：含 YAML 特殊字符或多行时加引号。 */
function frontmatterLine(key: string, value: string): string {
  const needsQuote = /[:#{}[\],&*?|>!%@`]/.test(value) || value.includes("\n");
  return needsQuote ? `${key}: ${JSON.stringify(value)}` : `${key}: ${value}`;
}

function writeFrontmatter(fm: Record<string, string>, body: string): string {
  const lines = Object.entries(fm).map(([k, v]) => frontmatterLine(k, v));
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\r?\n/, "")}`;
}

/**
 * 只改 disable-model-invocation（并补齐缺失的 defaults），其余 frontmatter 原样保留。
 *
 * 为什么不用 readFrontmatter → writeFrontmatter 往返：那份解析是扁平的，
 * YAML 列表会在往返中被整段丢弃。技能声明 Python 依赖最自然的写法就是列表
 * （`python-dependencies:` 后跟 `- PyMuPDF>=1.23`），一旦在安装或启停环节被抹掉，
 * 技能就只能静默退化到基础环境——正是「不能悄悄降级」要避免的形态。
 *
 * defaults 只补不覆盖：已有键保留原值与原始写法。
 */
function setModelInvocationPreservingFrontmatter(
  raw: string,
  enabled: boolean,
  defaults: Record<string, string> = {},
): string {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) {
    const parsed = readFrontmatter(normalized);
    for (const [key, value] of Object.entries(defaults)) {
      if (!parsed.fm[key]) parsed.fm[key] = value;
    }
    if (enabled) delete parsed.fm["disable-model-invocation"];
    else parsed.fm["disable-model-invocation"] = "true";
    return writeFrontmatter(parsed.fm, parsed.body);
  }
  const lines = match[1].split(/\r?\n/);
  const index = lines.findIndex((line) => /^disable-model-invocation\s*:/.test(line));
  if (enabled) {
    if (index >= 0) lines.splice(index, 1);
  } else if (index >= 0) {
    lines[index] = "disable-model-invocation: true";
  } else {
    lines.push("disable-model-invocation: true");
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (lines.some((line) => line.startsWith(`${key}:`) || line.startsWith(`${key} :`))) continue;
    lines.push(frontmatterLine(key, value));
  }
  const body = normalized.slice(match[0].length);
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\s+/, "")}`;
}

function skillMdTemplate(skill: MarketSkillDto): string {
  return writeFrontmatter(
    {
      name: skill.name,
      description: skill.description,
    },
    `# ${skill.name}\n\n${skill.description}\n\n## Usage\n\n通过 \`/skill:${skill.name}\` 或让 Agent 在相关任务中自动加载本技能。\n`,
  );
}

function findSkillMd(dir: string): string | null {
  const direct = join(dir, "SKILL.md");
  if (existsSync(direct)) return direct;
  const lower = join(dir, "skill.md");
  if (existsSync(lower)) return lower;
  return null;
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

/** 允许删除的市场路径：已知归档目录（不依赖 cwd 与 roots 完全一致） */
function isAllowedMarketSkillPath(target: string): boolean {
  const t = normalizePathKey(target);
  const markers = [
    `${sep}mybuddyskills-main${sep}skills${sep}`,
    `${sep}.mybuddy${sep}plugins${sep}skills${sep}`,
    `${sep}expert-market${sep}skills${sep}`,
  ];
  return markers.some((m) => t.includes(m));
}

/** 内置市场隐藏列表（无磁盘路径的条目用此方式“删除”） */
function hiddenMarketSkillsPath(): string {
  return join(getPluginsDir(), "market-hidden-skills.json");
}

function readHiddenSkillIds(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(hiddenMarketSkillsPath(), "utf-8")) as string[];
    return new Set((raw ?? []).map((x) => x.toLowerCase()));
  } catch {
    return new Set();
  }
}

function writeHiddenSkillIds(ids: Set<string>): void {
  writeFileSync(hiddenMarketSkillsPath(), JSON.stringify([...ids].sort(), null, 2), "utf-8");
}

/**
 * 扫描旧版手放技能（~/.mybuddy/plugins/skills 根下无元信息的目录）作为可重装市场源。
 * 带 _skillhub_meta.json / _user_meta.json 的是受管安装副本（市场/本地导入/连接器旧版），
 * 不作为市场源（避免 sourcePath 指向自身、重复安装时自复制崩溃）。
 */
function scanLegacyMybuddySkills(): MarketSkillDto[] {
  const root = getSkillsDir();
  if (!existsSync(root)) return [];
  const out: MarketSkillDto[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    // 受管安装副本不进入市场（安装状态由 UI 经 listInstalled 展示）
    if (existsSync(join(dir, "_skillhub_meta.json")) || existsSync(join(dir, "_user_meta.json"))) {
      continue;
    }
    const md = findSkillMd(dir);
    if (!md) continue;
    const raw = readFileSync(md, "utf-8");
    const { fm } = readFrontmatter(raw);
    out.push({
      id: (fm.slug || fm.name || name).toLowerCase().replace(/\s+/g, "-"),
      name: fm.name || name,
      description: fm.description || `来自 MyBuddy 的技能：${name}`,
      author: "MyBuddy",
      icon: "⚡",
      version: fm.version,
      sourcePath: dir,
      source: "mybuddy",
    });
  }
  return out;
}

/** 扫描本地技能市场（mybuddyskills-main/skills 等）：只读源，用户按需安装 */
function scanLocalSkillMarket(): MarketSkillDto[] {
  const out: MarketSkillDto[] = [];
  const seen = new Set<string>();
  for (const root of findLocalSkillMarketDirs()) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const md = findSkillMd(dir);
      if (!md) continue;
      const raw = readFileSync(md, "utf-8");
      const { fm } = readFrontmatter(raw);
      const id = (fm.slug || fm.name || name).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: fm.name || name,
        description: fm.description || `MyBuddy 官方技能：${name}`,
        author: "MyBuddy 官方",
        icon: "⚡",
        version: fm.version,
        sourcePath: dir,
        source: "mybuddy",
      });
    }
  }
  return out;
}

export class SkillsService {
  /**
   * 列出候选技能：默认 = 全局技能（~/.mybuddy/plugins/skills + 项目 .pi/skills）。
   * extraSkillPaths = 当前会话附加来源（专家 Private Skills / 激活连接器 Private Skills），
   * 与全局技能共用同一套加载与去重（重名时全局优先），随后统一经 Mode/Tag skillPolicy 过滤。
   */
  private mapLoadedSkill(s: PiSkill): SkillDto {
    const scope = s.sourceInfo.scope;
    const source = s.sourceInfo.source;
    let sourceTag: string | undefined;
    if (s.filePath) {
      const metaPath = join(s.filePath, "..", "_skillhub_meta.json");
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { source?: string };
          sourceTag = meta.source;
        } catch {
          /* ignore */
        }
      }
    }
    return {
      id: s.name,
      name: s.name,
      description: s.description || "",
      author: scope === "user" ? "用户技能" : scope === "project" ? "项目技能" : source || "磁盘",
      icon: "⚡",
      installed: true,
      enabled: !s.disableModelInvocation,
      builtin: scope === "user" && source === "local",
      command: s.name,
      filePath: s.filePath,
      source: sourceTag,
    };
  }

  listInstalled(cwd?: string, extraSkillPaths: string[] = []): SkillDto[] {
    getSkillsDir();
    guardStrayRootSkillBeforeScan();
    const { skills } = loadSkills({
      cwd: cwd?.trim() || process.cwd(),
      agentDir: getPluginsDir(),
      skillPaths: extraSkillPaths,
      includeDefaults: true,
    });
    return skills.map((s) => this.mapLoadedSkill(s));
  }

  /**
   * Runtime discovery with eligibility-before-collision semantics. Each source is discovered independently,
   * caller eligibility is applied first, then first-wins is resolved in the same Global -> Project -> extra order.
   * This prevents an out-of-scope learned Global Skill from shadowing a same-named Project/Private Skill.
   */
  resolveRuntimeSkills(
    cwd?: string,
    extraSkillPaths: string[] = [],
    include?: (skill: SkillDto) => boolean,
  ): RuntimeSkillSelection {
    getSkillsDir();
    guardStrayRootSkillBeforeScan();
    const resolvedCwd = resolve(cwd?.trim() || process.cwd());
    const agentDir = getMyBuddyDir();
    const sourceResults = [
      loadSkillsFromDir({ dir: getSkillsDir(), source: "user" }),
      loadSkillsFromDir({ dir: join(resolvedCwd, ".pi", "skills"), source: "project" }),
      ...extraSkillPaths.map((skillPath) => loadSkills({
        cwd: resolvedCwd, agentDir, skillPaths: [skillPath], includeDefaults: false,
      })),
    ];
    const extraRoots = extraSkillPaths.map((value) => resolve(value).toLowerCase());
    const underExtra = (filePath: string): boolean => {
      const candidate = resolve(filePath).toLowerCase();
      return extraRoots.some((base) => candidate === base || candidate.startsWith(base + sep));
    };
    const selected = new Map<string, { skill: PiSkill; dto: SkillDto }>();
    const seenPaths = new Set<string>();
    const diagnostics: ResourceDiagnostic[] = [];
    const shadowedExtraSkillNames: string[] = [];
    const shadowSeen = new Set<string>();
    for (const result of sourceResults) {
      diagnostics.push(...result.diagnostics);
      for (const skill of result.skills) {
        const dto = this.mapLoadedSkill(skill);
        // disable-model-invocation is runtime eligibility, not collision priority. A disabled Global
        // Skill must not reserve the name and shadow an active Project/Expert/Connector copy.
        if (!dto.enabled) continue;
        if (include && !include(dto)) continue;
        const pathKey = resolvedPathKey(skill.filePath);
        if (seenPaths.has(pathKey)) continue;
        const existing = selected.get(skill.name);
        if (existing) {
          if (underExtra(skill.filePath) && !shadowSeen.has(skill.name)) {
            shadowSeen.add(skill.name);
            shadowedExtraSkillNames.push(skill.name);
          }
          continue;
        }
        selected.set(skill.name, { skill, dto });
        seenPaths.add(pathKey);
      }
    }
    return {
      skills: [...selected.values()].map((item) => item.skill),
      dtos: [...selected.values()].map((item) => item.dto),
      diagnostics,
      shadowedExtraSkillNames,
    };
  }

  /**
   * 脚本路径 → 所属技能。
   *
   * execute_code 的 script 模式用它做两件事：确认路径确实落在某个技能目录内
   * （而不是任务区外的任意文件），以及取出该技能的依赖声明来决定用哪套受管环境。
   * 复用 resolveRuntimeSkills，因此遮蔽与优先级规则与真实会话一致。
   */
  resolveSkillScriptOwner(
    scriptPath: string,
    cwd?: string,
    extraSkillPaths: string[] = [],
  ): SkillScriptOwner | null {
    const lower = (value: string): string => pathKey(value);
    const target = lower(resolve(scriptPath));
    let best: SkillScriptOwner | null = null;
    for (const skill of this.resolveRuntimeSkills(cwd, extraSkillPaths).skills) {
      if (!skill.baseDir) continue;
      const base = resolve(skill.baseDir);
      const baseKey = lower(base);
      if (target !== baseKey && !target.startsWith(baseKey + sep)) continue;
      // 同名技能可能来自多个根：取最深的那份，脚本归属离它最近的副本
      if (best && best.baseDir.length >= base.length) continue;
      let frontmatter: Record<string, unknown> = {};
      try {
        frontmatter = readFrontmatterValues(readFileSync(skill.filePath, "utf-8"));
      } catch {
        /* SKILL.md 读不到就当作没有声明；猜依赖会准备出错环境 */
      }
      best = { name: skill.name, baseDir: base, frontmatter };
    }
    return best;
  }

  /**
   * P3-2：检测 extra 目录中被更高优先级同名技能遮蔽的私有技能名（first-wins 优先级不变，仅诊断）。
   * 与 listInstalled 同一 loadSkills 输入（cwd = 任务/预览 cwd，与真实 session 对齐，不再硬编码
   * process.cwd()），取 diagnostics 中 loser 位于 extra 目录的 collision。
   * 返回被遮蔽的私有技能名（已去重、保序）。
   */
  listShadowedSkillNames(cwd: string | undefined, extraSkillPaths: string[] = []): string[] {
    if (extraSkillPaths.length === 0) return [];
    guardStrayRootSkillBeforeScan();
    const { diagnostics } = loadSkills({
      cwd: cwd?.trim() || process.cwd(),
      agentDir: getPluginsDir(),
      skillPaths: extraSkillPaths,
      includeDefaults: true,
    });
    const extraDirs = extraSkillPaths.map((p) => resolve(p).toLowerCase());
    const shadowed: string[] = [];
    const seen = new Set<string>();
    for (const d of diagnostics) {
      if (d.type !== "collision") continue;
      const loser = resolve(d.path ?? "").toLowerCase();
      const underExtra = extraDirs.some((root) => loser === root || loser.startsWith(root + sep));
      if (!underExtra) continue;
      const name = typeof d.collision?.name === "string" ? d.collision.name : "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      shadowed.push(name);
    }
    return shadowed;
  }

  listMarket(cwd?: string): MarketSkillDto[] {
    // 市场源：内置 + 磁盘归档。已安装项保留在列表中，由前端展示状态
    const hidden = readHiddenSkillIds();
    const catalog = new Map<string, MarketSkillDto>();
    for (const s of BUILTIN_MARKET) {
      if (!hidden.has(s.id.toLowerCase())) catalog.set(s.id.toLowerCase(), s);
    }
    for (const s of scanLegacyMybuddySkills()) {
      if (hidden.has(s.id.toLowerCase())) continue;
      if (!catalog.has(s.id.toLowerCase())) catalog.set(s.id.toLowerCase(), s);
    }
    for (const s of scanLocalSkillMarket()) {
      if (hidden.has(s.id.toLowerCase())) continue;
      if (!catalog.has(s.id.toLowerCase())) catalog.set(s.id.toLowerCase(), s);
    }
    return [...catalog.values()];
  }

  /**
   * 从市场删除：有 sourcePath 则删磁盘包；内置无路径则写入隐藏列表。
   * 若本地已安装，一并删除本地副本。
   */
  deleteFromMarket(id: string): void {
    const key = id.trim();
    if (!key) throw new Error("技能 id 为空");

    // 优先用当前市场列表（含 sourcePath）；再用全量扫描
    const fromList = this.listMarket().find(
      (s) => s.id === key || s.name === key || s.id.toLowerCase() === key.toLowerCase(),
    );
    const all = [
      ...BUILTIN_MARKET,
      ...scanLegacyMybuddySkills(),
      ...scanLocalSkillMarket(),
    ];
    const skill =
      fromList ??
      all.find(
        (s) => s.id === key || s.name === key || s.id.toLowerCase() === key.toLowerCase() || s.name.toLowerCase() === key.toLowerCase(),
      );
    if (!skill) throw new Error(`市场中未找到技能: ${id}`);

    if (skill.sourcePath && existsSync(skill.sourcePath)) {
      const roots = [
        ...findLocalSkillMarketDirs(),
        getSkillsDir(),
      ];
      if (!isUnderRoots(skill.sourcePath, roots) && !isAllowedMarketSkillPath(skill.sourcePath)) {
        throw new Error(`拒绝删除市场外路径: ${skill.sourcePath}`);
      }
      try {
        rmSync(skill.sourcePath, { recursive: true, force: true });
      } catch (err) {
        throw new Error(
          `删除市场技能目录失败: ${skill.sourcePath} · ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // 内置或无磁盘路径：隐藏
      const hidden = readHiddenSkillIds();
      hidden.add(skill.id.toLowerCase());
      writeHiddenSkillIds(hidden);
    }

    // 同步清理本地安装副本（若有）
    try {
      this.uninstall(skill.id);
    } catch {
      try {
        this.uninstall(skill.name);
      } catch {
        /* 未安装则忽略 */
      }
    }
  }

  installFromMarket(id: string): SkillDto {
    const market = [...BUILTIN_MARKET, ...scanLegacyMybuddySkills(), ...scanLocalSkillMarket()];
    const skill = market.find((s) => s.id === id || s.name === id);
    if (!skill) throw new Error(`市场中未找到技能: ${id}`);

    const destRoot = getSkillsDir();
    // Use the market id slug as the runtime directory name.
    const destName = skill.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "skill";
    const dest = join(destRoot, destName);

    // Legacy manually placed Skills are discovered from ~/.mybuddy/plugins/skills as market sources.
    // In that case sourcePath and dest are the same path; deleting dest before copying would delete the only source.
    // Archive it into the real user market first, then install from that archive.
    let installSourcePath = skill.sourcePath;
    if (
      installSourcePath &&
      existsSync(installSourcePath) &&
      normalizePathKey(installSourcePath) === normalizePathKey(dest)
    ) {
      const archiveRoot = join(getExpertMarketDir(), "skills");
      ensureDir(archiveRoot);
      const archivedSource = join(archiveRoot, destName);
      if (existsSync(archivedSource)) rmSync(archivedSource, { recursive: true, force: true });
      cpSync(installSourcePath, archivedSource, { recursive: true });
      installSourcePath = archivedSource;
    }

    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
    }
    ensureDir(dest);

    if (installSourcePath && existsSync(installSourcePath)) {
      cpSync(installSourcePath, dest, { recursive: true });
    } else {
      writeFileSync(join(dest, "SKILL.md"), skill.content ?? skillMdTemplate(skill), "utf-8");
    }
    writeFileSync(
      join(dest, "_skillhub_meta.json"),
      JSON.stringify(
        {
          id: skill.id,
          name: skill.name,
          version: skill.version ?? "1.0.0",
          installedAt: Date.now(),
          source: skill.source === "local" || !skill.sourcePath ? "builtin-market" : "local-market",
          marketSource: skill.source ?? (skill.sourcePath ? "mybuddy" : "local"),
        },
        null,
        2,
      ),
      "utf-8",
    );

    const installed = this.listInstalled().find((s) => s.name === skill.name || s.id === skill.id);
    if (installed) return installed;
    return {
      id: skill.name,
      name: skill.name,
      description: skill.description,
      author: skill.author,
      icon: skill.icon,
      installed: true,
      enabled: true,
      command: skill.name,
      filePath: join(dest, "SKILL.md"),
    };
  }

  installByPath(sourcePath: string): SkillDto {
    const src = sourcePath.trim();
    if (!src || !existsSync(src)) throw new Error("技能路径不存在");

    let skillDir = src;
    let skillMd = findSkillMd(src);
    if (!skillMd && statSync(src).isFile() && basename(src).toLowerCase() === "skill.md") {
      skillDir = join(src, "..");
      skillMd = src;
    }
    if (!skillMd) throw new Error("目录中未找到 SKILL.md");

    const raw = readFileSync(skillMd, "utf-8");
    const { fm } = readFrontmatter(raw);
    const name = (fm.name || basename(skillDir)).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const dest = join(getSkillsDir(), name);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });

    if (statSync(skillDir).isDirectory()) {
      cpSync(skillDir, dest, { recursive: true });
    } else {
      ensureDir(dest);
      copyFileSync(skillMd, join(dest, "SKILL.md"));
    }

    writeFileSync(
      join(dest, "_user_meta.json"),
      JSON.stringify({ installedAt: Date.now(), sourcePath: src }, null, 2),
      "utf-8",
    );

    const installed = this.listInstalled().find((s) => s.filePath?.includes(dest) || s.name === name);
    if (installed) return installed;
    return {
      id: name,
      name,
      description: fm.description || "",
      author: "本地导入",
      icon: "⚡",
      installed: true,
      enabled: true,
      command: name,
      filePath: join(dest, "SKILL.md"),
    };
  }

  /**
   * Authoring-only atomic install/replace. Unlike generic installByPath(), this never removes the
   * last-known-good installed Skill before a complete staged package exists.
   */
  installAuthoredPackage(sourcePath: string, expectedId: string, enabled: boolean, replaceExisting: boolean): SkillDto {
    const src = sourcePath.trim();
    const id = expectedId.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Authoring Skill id 非法：${expectedId}`);
    if (!src || !existsSync(src) || !statSync(src).isDirectory()) throw new Error("Authoring Skill 包目录不存在");
    const sourceMd = findSkillMd(src);
    if (!sourceMd) throw new Error("Authoring Skill 包缺少 SKILL.md");
    const sourceRaw = readFileSync(sourceMd, "utf-8");
    const sourceParsed = readFrontmatter(sourceRaw);
    const sourceId = (sourceParsed.fm.name || basename(src)).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    if (sourceId !== id) throw new Error(`Authoring Skill identity 不一致：expected=${id}, package=${sourceId}`);

    const root = getSkillsDir();
    recoverInterruptedSkillSwaps(root);
    const dest = join(root, id);
    if (existsSync(dest) && !replaceExisting) throw new Error(`技能「${id}」已存在，拒绝覆盖`);
    const token = randomUUID();
    const staged = join(root, `.${id}.authoring-${token}.tmp`);
    const backup = join(root, `.${id}.authoring-${token}.bak`);
    rmSync(staged, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
    try {
      cpSync(src, staged, { recursive: true });
      const stagedMd = findSkillMd(staged);
      if (!stagedMd) throw new Error("Authoring staged package 缺少 SKILL.md");
      writeFileSync(
        stagedMd,
        setModelInvocationPreservingFrontmatter(readFileSync(stagedMd, "utf-8"), enabled, { name: "skill" }),
        "utf-8",
      );
      writeFileSync(join(staged, "_user_meta.json"), JSON.stringify({ installedAt: Date.now(), sourcePath: src, source: "authoring" }, null, 2), "utf-8");
      writeFileSync(join(staged, SWAP_READY_MARKER), "ready\n", "utf-8");

      let oldMoved = false;
      try {
        if (existsSync(dest)) { renameSync(dest, backup); oldMoved = true; }
        renameSync(staged, dest);
        if (oldMoved) rmSync(backup, { recursive: true, force: true });
        try { rmSync(join(dest, SWAP_READY_MARKER), { force: true }); } catch { /* recovered on next scan */ }
      } catch (error) {
        if (oldMoved && existsSync(backup)) {
          try {
            if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
            renameSync(backup, dest);
          } catch (restoreError) {
            throw new Error(`Authoring Skill 原子替换失败且旧版本恢复失败：${error instanceof Error ? error.message : String(error)}；恢复错误：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
          }
        }
        throw error;
      }
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }

    const installed = this.listInstalled().find((skill) => skill.id === id || skill.name === id);
    if (installed) return { ...installed, enabled };
    return {
      id, name: id, description: sourceParsed.fm.description || "", author: "用户技能", icon: "⚡",
      installed: true, enabled, command: id, filePath: join(dest, "SKILL.md"), source: "manual",
    };
  }

  getLearnedSkillMetadata(skillId: string): LearnedSkillMetadata | undefined {
    const slug = skillId.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(slug)) return undefined;
    return this.readLearnedSkillMetadata(join(getSkillsDir(), slug, "SKILL.md"));
  }

  getLearnedSkillMetadataForFile(filePath: string): LearnedSkillMetadata | undefined {
    return this.readLearnedSkillMetadata(filePath);
  }

  getLearnedSkillRevisionSource(skillId: string): LearnedSkillRevisionSource | undefined {
    const metadata = this.getLearnedSkillMetadata(skillId);
    if (!metadata?.scopeType || metadata.sourceMemoryIds.length === 0) return undefined;
    const raw = readFileSync(metadata.filePath, "utf-8");
    const { fm, body } = readFrontmatter(raw);
    const metaPath = join(metadata.filePath, "..", "_skillhub_meta.json");
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { version?: string; learnedTitle?: string };
      return {
        ...metadata,
        scopeType: metadata.scopeType,
        version: typeof meta.version === "string" && meta.version.trim() ? meta.version.trim() : "1.0.0",
        title: typeof meta.learnedTitle === "string" && meta.learnedTitle.trim() ? meta.learnedTitle.trim() : metadata.skillId,
        description: (fm.description ?? "").trim(),
        instructions: body.trim(),
        // Hash semantic Skill content only. Enable/disable toggles rewrite frontmatter but must not stale a revision.
        contentHash: createHash("sha256").update(`${(fm.description ?? "").trim()}\n${body.trim()}`).digest("hex"),
      };
    } catch {
      return undefined;
    }
  }

  resolveLearnedSkillRead(rawPath: string, cwd: string): LearnedSkillMetadata | undefined {
    const input = rawPath.trim();
    if (!input) return undefined;
    const expanded = input === "~"
      ? homedir()
      : input.startsWith("~/") || input.startsWith("~\\")
        ? join(homedir(), input.slice(2))
        : input;
    const filePath = resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
    if (basename(filePath).toLowerCase() !== "skill.md") return undefined;
    return this.readLearnedSkillMetadata(filePath);
  }

  private readLearnedSkillMetadata(filePath: string): LearnedSkillMetadata | undefined {
    const canonicalFile = resolve(filePath);
    const skillsRoot = resolve(getSkillsDir());
    const parent = resolve(join(canonicalFile, ".."));
    const cmpParent = pathKey(parent);
    const cmpRoot = pathKey(skillsRoot);
    if (!(cmpParent === cmpRoot || cmpParent.startsWith(cmpRoot + sep))) return undefined;
    const metaPath = join(parent, "_skillhub_meta.json");
    if (!existsSync(canonicalFile) || !existsSync(metaPath)) return undefined;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
        source?: string;
        id?: string;
        name?: string;
        candidateId?: string;
        sourceMemoryIds?: unknown;
        scopeType?: string;
        scopeId?: string | null;
      };
      if (meta.source !== "memory-learned") return undefined;
      const skillId = String(meta.id ?? meta.name ?? basename(parent)).trim();
      if (!skillId) return undefined;
      const sourceMemoryIds = Array.isArray(meta.sourceMemoryIds)
        ? meta.sourceMemoryIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        : [];
      const scopeType = ["global", "workspace", "project"].includes(String(meta.scopeType))
        ? meta.scopeType as LearnedSkillMetadata["scopeType"]
        : undefined;
      return {
        skillId,
        candidateId: typeof meta.candidateId === "string" && meta.candidateId ? meta.candidateId : undefined,
        sourceMemoryIds: [...new Set(sourceMemoryIds)],
        scopeType,
        scopeId: typeof meta.scopeId === "string" && meta.scopeId ? meta.scopeId : undefined,
        filePath: canonicalFile,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Human-approved Memory Skill Candidate -> real user Skill.
   * Learned skills are intentionally installed with disable-model-invocation=true; approval creates the
   * artifact, while activation remains an explicit Skill Center decision. Existing non-learned skills
   * are never overwritten. Re-approving a newer candidate from the same learned lineage may update it.
   */
  installLearnedSkill(input: LearnedSkillInstallInput): SkillDto {
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(slug)) throw new Error(`学习技能 slug 非法：${input.slug}`);
    if (!input.candidateId.trim()) throw new Error("Skill Candidate id 为空");
    if (!input.sourceMemoryIds.length) throw new Error("学习技能缺少 Procedure Memory provenance");
    const skillsRoot = getSkillsDir();
    ensureDir(skillsRoot);
    recoverInterruptedSkillSwaps(skillsRoot);
    const dest = join(skillsRoot, slug);
    const metaPath = join(dest, "_skillhub_meta.json");
    if (existsSync(dest)) {
      let meta: { source?: string; sourceMemoryIds?: string[]; candidateId?: string; version?: string } | null = null;
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { source?: string; sourceMemoryIds?: string[]; candidateId?: string; version?: string };
      } catch {
        meta = null;
      }
      if (meta?.source !== "memory-learned") {
        throw new Error(`技能「${slug}」已存在且不是 Memory 学习技能，拒绝覆盖`);
      }
      const oldSources = new Set(meta.sourceMemoryIds ?? []);
      if (!input.sourceMemoryIds.some((id) => oldSources.has(id))) {
        throw new Error(`技能「${slug}」属于另一条学习 lineage，拒绝覆盖`);
      }
      if (input.supersedesCandidateId && meta.candidateId !== input.supersedesCandidateId) {
        throw new Error(`技能「${slug}」当前版本已变化，拒绝用过期 Revision Candidate 覆盖`);
      }
    }
    const description = input.description.replace(/\s+/g, " ").trim().slice(0, 320) || input.title.trim();
    const body = input.instructions.trim();
    if (!body) throw new Error("学习技能正文为空");

    // Stage the complete learned Skill beside the final directory, then swap directories. Never delete
    // the last known-good learned Skill before the replacement has been fully written.
    const swapToken = randomUUID();
    const staged = join(skillsRoot, `.${slug}.learned-${swapToken}.tmp`);
    const backup = join(skillsRoot, `.${slug}.learned-${swapToken}.bak`);
    rmSync(staged, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
    ensureDir(staged);
    try {
      writeFileSync(
        join(staged, "SKILL.md"),
        writeFrontmatter(
          {
            name: slug,
            description,
            "disable-model-invocation": "true",
          },
          body,
        ),
        "utf-8",
      );
      writeFileSync(
        join(staged, "_skillhub_meta.json"),
        JSON.stringify(
          {
            id: slug,
            name: slug,
            version: input.version ?? "1.0.0",
            installedAt: Date.now(),
            source: "memory-learned",
            candidateId: input.candidateId,
            supersedesCandidateId: input.supersedesCandidateId ?? null,
            sourceMemoryIds: [...new Set(input.sourceMemoryIds)],
            scopeType: input.scopeType,
            scopeId: input.scopeId ?? null,
            learnedTitle: input.title,
          },
          null,
          2,
        ),
        "utf-8",
      );
      writeFileSync(join(staged, SWAP_READY_MARKER), "ready\n", "utf-8");

      let oldMoved = false;
      try {
        if (existsSync(dest)) {
          renameSync(dest, backup);
          oldMoved = true;
        }
        renameSync(staged, dest);
        if (oldMoved) rmSync(backup, { recursive: true, force: true });
        try { rmSync(join(dest, SWAP_READY_MARKER), { force: true }); } catch { /* recovered on next scan */ }
      } catch (error) {
        // rename within one filesystem is atomic. If swapping the new directory fails, restore the old
        // learned Skill before surfacing the error; never leave a half-written final directory.
        if (oldMoved && existsSync(backup)) {
          try {
            if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
            renameSync(backup, dest);
          } catch (restoreError) {
            throw new Error(
              `学习技能替换失败且旧版本恢复失败：${error instanceof Error ? error.message : String(error)}；恢复错误：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
            );
          }
        }
        throw error;
      }
    } finally {
      rmSync(staged, { recursive: true, force: true });
      // A successful swap removes backup above. A failed restore may intentionally leave backup for manual recovery.
    }
    const installed = this.listInstalled().find((skill) => skill.name === slug || skill.id === slug);
    if (installed) return { ...installed, enabled: false, source: "memory-learned" };
    return {
      id: slug,
      name: slug,
      description,
      author: "Memory Kernel",
      icon: "⚡",
      installed: true,
      enabled: false,
      command: slug,
      filePath: join(dest, "SKILL.md"),
      source: "memory-learned",
    };
  }

  uninstall(id: string): void {
    const skill = this.listInstalled().find((s) => s.id === id || s.name === id);
    if (!skill?.filePath) throw new Error(`未找到已安装技能: ${id}`);
    const dir = resolve(join(skill.filePath, ".."));
    const skillsRoot = resolve(getSkillsDir());
    const normalizedDir = dir.toLowerCase();
    const normalizedRoot = skillsRoot.toLowerCase();
    if (!normalizedDir.startsWith(normalizedRoot)) {
      throw new Error("只能卸载用户目录下的技能（~/.mybuddy/plugins/skills）");
    }
    rmSync(dir, { recursive: true, force: true });
  }

  setEnabled(id: string, enabled: boolean): SkillDto {
    const skill = this.listInstalled().find((s) => s.id === id || s.name === id);
    if (!skill?.filePath || !existsSync(skill.filePath)) {
      throw new Error(`未找到技能文件: ${id}`);
    }
    const raw = readFileSync(skill.filePath, "utf-8");
    const { fm } = readFrontmatter(raw);
    // 保序写入：扁平往返会把 YAML 列表整段丢掉，用户点一次「启用」就抹掉依赖声明
    writeFileSync(
      skill.filePath,
      setModelInvocationPreservingFrontmatter(raw, enabled, {
        name: fm.name || skill.name,
        description: fm.description || skill.description || skill.name,
      }),
      "utf-8",
    );
    return { ...skill, enabled };
  }

  /**
   * 从本地市场批量安装技能（mybuddyskills-main/skills 等）。
   * 默认写 disable-model-invocation: true（不自动进模型上下文，避免数百技能膨胀提示词），
   * 用户按需在技能页启用。幂等：同名已安装的跳过。
   * 返回本次新安装数量。
   */
  installLocalSkills(): { installed: number; skipped: number } {
    const roots = findLocalSkillMarketDirs();
    const destRoot = getSkillsDir();
    const destNames = new Set(
      readdirSync(destRoot)
        .filter((n) => statSync(join(destRoot, n)).isDirectory())
        .map((n) => n.toLowerCase()),
    );
    let installed = 0;
    let skipped = 0;
    for (const root of roots) {
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        continue;
      }
      for (const name of names) {
        const src = join(root, name);
        try {
          if (!statSync(src).isDirectory()) continue;
        } catch {
          continue;
        }
        const skillMd = findSkillMd(src);
        if (!skillMd) continue;
        const raw = readFileSync(skillMd, "utf-8");
        const { fm } = readFrontmatter(raw);
        const skillName = (fm.name || name).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
        if (!skillName || destNames.has(skillName)) {
          skipped += 1;
          continue;
        }
        const dest = join(destRoot, skillName);
        cpSync(src, dest, { recursive: true });
        // 默认禁用模型自动调用（防上下文膨胀），保留用户后续启停能力
        const destMd = findSkillMd(dest)!;
        const destRaw = readFileSync(destMd, "utf-8");
        // 保序写入：扁平往返会把技能声明的 YAML 列表（python-dependencies 等）整段丢掉
        if (!readFrontmatter(destRaw).fm["disable-model-invocation"]) {
          writeFileSync(destMd, setModelInvocationPreservingFrontmatter(destRaw, false), "utf-8");
        }
        writeFileSync(
          join(dest, "_skillhub_meta.json"),
          JSON.stringify(
            {
              name: skillName,
              version: fm.version ?? "1.0.0",
              installedAt: Date.now(),
              source: "local-market",
            },
            null,
            2,
          ),
          "utf-8",
        );
        destNames.add(skillName);
        installed += 1;
      }
    }
    return { installed, skipped };
  }
}
