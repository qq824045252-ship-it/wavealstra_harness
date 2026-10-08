import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import type {
  ExpertDto,
  MarketExpertDto,
  PrivateSkillDto,
} from "../../shared/agent-ipc";
import type { ExpertDetailDto, ExpertUpdateRequest } from "../../shared/expert-binding";
import { getExpertExportsDir, getExpertsDir, getExpertMarketDir, getPluginsDir, getSkillsDir } from "../paths";
import { assertSingleExpertId } from "../../shared/expert-id";
import { sanitizePrivateSkillPackage } from "../skills/SkillAuthoringService";

/**
 * 专家（Agent 型插件）服务。
 *
 * 存储布局（对齐官方 MyBuddy 插件生态）：
 *   ~/.mybuddy/plugins/experts/<slug>/
 *   ├── expert.json      # 归一化元信息（本应用）
 *   ├── prompt.md        # 角色提示词：frontmatter + 正文（CodeBuddy agents/*.md 格式）
 *   ├── skills/          # 可选：专家 Private Skills（随专家导入/导出）
 *   └── avatar.png       # 可选头像
 *
 * 兼容导入（吃 GitHub 生态存量）：
 *   <name>/
 *   ├── .codebuddy-plugin/plugin.json   # 可选：name/version/description/tags/category
 *   ├── agents/<name>.md                # 核心：角色定义（frontmatter: name/description/displayName/profession/maxTurns）
 *   ├── avatars/expert.png              # 可选头像
 *   ├── skills/<skill>/SKILL.md          # 可选：专家 Private Skills
 *   └── README.md                       # 可选
 * 导入来源：zip 包（jszip 解包）或目录。
 *
 */

export interface RolePromptResult {
  kind: "expert";
  /** 注入系统提示的「## 专家角色」正文 */
  prompt: string;
  name: string;
  emoji: string;
}

interface StoredExpert {
  id: string;
  name: string;
  description: string;
  author: string;
  emoji: string;
  tags: string[];
  category?: string;
  version?: string;
  examples?: string[];
  enabled: boolean;
  source: string;
  installedAt: number;
  /** 角色提示词文件名（相对专家目录），默认 prompt.md */
  promptFile?: string;
  avatarFile?: string;
  /** 专家包自带 Private Skills 目录名（~/.mybuddy/plugins/experts/<id>/skills/，随专家生命周期） */
  skills?: string[];
  mcpIds?: string[];
  connectorIds?: string[];
  /** 单专家条目标记。 */
  kind?: "expert";
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function capabilityIds(values: unknown): string[] {
  if (values == null) return [];
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || /[\u0000-\u001f]/.test(value))) {
    throw new Error("专家能力引用必须是 id 列表");
  }
  return [...new Set(values.map(value => (value as string).trim()).filter(Boolean))];
}

/** Stage on the same volume; failed preparation/swap never destroys the accepted package. */
function stageExpertDirectory(target: string): { stage: string; commit: () => void; discard: () => void } {
  const root = resolve(getExpertsDir());
  const dest = resolve(target);
  if (dirname(dest) !== root) throw new Error("专家目标目录超出安装目录");
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error("拒绝覆盖符号链接专家目录");
  const token = randomUUID();
  const stage = join(root, `.stage-${basename(dest)}-${token}`);
  const backup = join(root, `.backup-${basename(dest)}-${token}`);
  ensureDir(stage);
  return {
    stage,
    discard: () => { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); },
    commit: () => {
      let backedUp = false;
      try {
        if (existsSync(dest)) { renameSync(dest, backup); backedUp = true; }
        renameSync(stage, dest);
      } catch (error) {
        if (backedUp && !existsSync(dest)) renameSync(backup, dest);
        throw error;
      }
      // The accepted package is already committed. A locked backup must not report a false save failure.
      if (backedUp) {
        try { rmSync(backup, { recursive: true, force: true }); }
        catch (error) { console.warn("[ExpertService] Retained previous expert package backup", backup, error); }
      }
    },
  };
}

function replaceExpertDirectory<T>(target: string, writer: (stage: string) => T): T {
  const staged = stageExpertDirectory(target);
  try { const result = writer(staged.stage); staged.commit(); return result; }
  finally { staged.discard(); }
}

function packageRevision(dir: string): string {
  const hash = createHash("sha256");
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path);
    hash.update(JSON.stringify(relative));
    if (stat.isSymbolicLink()) { hash.update("link:").update(readlinkSync(path)); return; }
    if (stat.isDirectory()) {
      hash.update("directory:");
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
    } else if (stat.isFile()) hash.update(`file:${stat.size}:`).update(readFileSync(path));
  };
  visit(dir, "");
  return hash.digest("hex");
}

function privateSkillPath(root: string, id: string): string {
  if (!id || id === "." || id === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(id)) throw new Error(`无效的 Private Skill id: ${id}`);
  const result = resolve(root, id);
  if (dirname(result) !== resolve(root)) throw new Error(`Private Skill 路径超出专家目录: ${id}`);
  return result;
}

function editablePrompt(original: string, stored: StoredExpert, instructions: string): string {
  const fields: Record<string, string> = { name: stored.id, displayName: stored.name,
    description: stored.description, version: stored.version ?? "1.0.0" };
  const header = original.replace(/^\uFEFF/, "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const preserved: string[] = [];
  let replacing = false;
  for (const line of header?.[1].split(/\r?\n/) ?? []) {
    const key = line.match(/^([\w-]+)\s*:/)?.[1];
    if (key) replacing = Object.prototype.hasOwnProperty.call(fields, key);
    if (!replacing) preserved.push(line);
  }
  const metadata = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${[...metadata, ...preserved].join("\n")}\n---\n\n${instructions.trim()}\n`;
}

/** 将目录内容递归写入 zip，保留相对路径；用于导出专家 Private Skills。 */
function addDirectoryToZip(zip: JSZip, sourceDir: string, zipPrefix: string): void {
  if (!existsSync(sourceDir)) return;
  const rootStat = lstatSync(sourceDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
  for (const name of readdirSync(sourceDir)) {
    if (["_user_meta.json", "_skillhub_meta.json"].includes(name.toLowerCase())) continue;
    const sourcePath = join(sourceDir, name);
    const zipPath = `${zipPrefix}/${name}`;
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      addDirectoryToZip(zip, sourcePath, zipPath);
    } else if (stat.isFile()) {
      zip.file(zipPath, readFileSync(sourcePath));
    }
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "expert";
}

/** 解析 markdown frontmatter（兼容 YAML 简子集，与 SkillsService 一致） */
function readFrontmatter(md: string): { body: string; fm: Record<string, unknown> } {
  if (!md.startsWith("---")) return { body: md, fm: {} };
  const end = md.indexOf("\n---", 3);
  if (end < 0) return { body: md, fm: {} };
  const raw = md.slice(3, end).trim();
  const body = md.slice(end + 4).replace(/^\r?\n/, "");
  const fm: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    fm[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return { body, fm };
}

function pickZh(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return String(o.zh ?? o["zh-CN"] ?? o.en ?? fallback ?? "");
  }
  return fallback;
}

/* ------------------------------------------------------------------ */
/* 内置市场：中文办公场景                                             */
/* ------------------------------------------------------------------ */

interface BuiltinExpertDef extends MarketExpertDto {
  promptMd: string;
}

const WEEKLY_REPORT_PROMPT = `---
name: weekly-report
description: 根据对话与工作区素材，按周报习惯整理工作进展、成果与问题，输出可直接粘贴的周报。
displayName:
  zh: "周报撰写专家"
  en: "Weekly Report Expert"
profession:
  zh: "周报撰写专家"
  en: "Weekly Report Expert"
tags: [周报, 工作总结, 工作汇报]
category: 效率办公
version: 1.0.0
maxTurns: 30
---

# 周报撰写专家

你是资深职场周报撰写专家，熟悉互联网与制造业团队的周报习惯，善于从零散素材中提炼「进展、成果、风险、计划」四条主线。

## 工作方法

1. **收集素材**：先向用户确认周报周期（本周/上周），主动读取用户提供的工作区文件、对话记录或粘贴内容；素材不足时明确提问，不要臆造。
2. **结构组织**：按「本周完成 → 关键成果 → 问题与风险 → 下周计划」组织，重点事项在前，用项目符号呈现；数字、进度、影响面尽量具体。
3. **语言风格**：简洁、客观、可交付；避免空话套话；每项工作一句话说清「做了什么、结果如何」。

## 输出规范

- 默认输出 Markdown 周报，段落标题用 ## 或 ###，单条不超过两行。
- 若用户要求「精简版」，压缩为不超过 5 条的要点列表。
- 若用户提供周报模板，严格按模板字段输出。
- 结尾给出「可直接粘贴」的提示，不要附加解释性评论。

## 注意事项

- 不编造数据；不确定的进度标注「待确认」。
- 用户提供的是多天记录时，按时间合并同类事项，避免重复。`;

const DATA_ANALYSIS_PROMPT = `---
name: data-analysis
description: 分析表格/CSV/文本数据，做统计、对比、洞察与可视化建议，输出可执行的分析结论。
displayName:
  zh: "数据分析专家"
  en: "Data Analysis Expert"
profession:
  zh: "数据分析专家"
  en: "Data Analysis Expert"
tags: [数据分析, Excel, 统计, 可视化]
category: 数据智能
version: 1.0.0
maxTurns: 40
---

# 数据分析专家

你是专业数据分析师，擅长用结构化方法处理表格数据（CSV/Excel/文本），产出可靠结论与可执行建议。

## 工作方法

1. **理解数据**：先明确数据规模、字段含义与口径；数据缺失或口径不明时先提问或做合理假设并注明。
2. **分析路径**：描述统计 → 对比/趋势 → 异常识别 → 相关性/归因 → 结论建议。每一步给出依据，不跳步。
3. **工具使用**：优先用 bash/脚本（如 python、node）对文件数据做真实计算，避免心算；结果要可复现。

## 输出规范

- 结论先行：开头一句话给出核心发现，再展开论据。
- 用表格呈现对比数据；数值保留合理精度，注明单位。
- 给出 3-5 条可执行建议，每条指明「做什么、为什么、预期效果」。
- 若可作图，给出图表类型与字段建议（柱状/折线/饼图等），必要时直接生成图表文件。

## 注意事项

- 区分「事实」与「推断」，推断必须标注假设。
- 数据不足时明确说明局限，不给过度结论。`;

const DOC_POLISH_PROMPT = `---
name: doc-polish
description: 对中文/英文文档进行润色、校对与改写：修正语病、统一风格、优化结构，适合公文、报告与邮件。
displayName:
  zh: "文档润色专家"
  en: "Document Polishing Expert"
profession:
  zh: "文档润色专家"
  en: "Document Polishing Expert"
tags: [润色, 校对, 公文, 邮件]
category: 内容创作
version: 1.0.0
maxTurns: 30
---

# 文档润色专家

你是资深中文文档编辑，擅长公文、汇报、邮件与文章的润色与校对，注重表达准确、逻辑通顺、风格得体。

## 工作方法

1. **通读理解**：先通读全文，判断文体（公文/汇报/邮件/文章）与目标读者，确定语气基调。
2. **分层修改**：先改结构（段落逻辑、标题层级），再改句子（语病、歧义、冗余），最后改用词（错别字、标点、术语一致性）。
3. **风格适配**：公文规范严谨、邮件简洁友好、汇报重点突出；保留原文风格与关键信息，不擅自增删事实。

## 输出规范

- 输出「润色后全文」；若改动较多，在全文后附「主要修改说明」清单（≤5 条）。
- 需要用户确认的改动（如删除段落、改写数据表述）以「【待确认】」标注。
- 提供「精简版」（压缩 30% 以上）与「正式版」两个版本供选择。

## 注意事项

- 保留专有名词、数字、引用与格式标记（如 Markdown 语法）。
- 不确定的语义不要猜改，标注疑问即可。`;

const BUILTIN_EXPERTS: BuiltinExpertDef[] = [
  {
    id: "weekly-report",
    name: "周报撰写专家",
    description: "根据对话与工作区素材，整理工作进展、成果与计划，输出可直接粘贴的周报。",
    author: "MyBuddy",
    emoji: "📝",
    tags: ["周报", "工作总结", "工作汇报"],
    category: "效率办公",
    version: "1.0.0",
    examples: ["帮我写本周周报", "把这两天的进展整理成周报"],
    promptMd: WEEKLY_REPORT_PROMPT,
  },
  {
    id: "data-analysis",
    name: "数据分析专家",
    description: "分析表格与文本数据，做统计、对比、洞察与可视化建议，输出可执行结论。",
    author: "MyBuddy",
    emoji: "📊",
    tags: ["数据分析", "Excel", "统计", "可视化"],
    category: "数据智能",
    version: "1.0.0",
    examples: ["分析这份销售数据的趋势", "对比两个方案的优劣，用数据说话"],
    promptMd: DATA_ANALYSIS_PROMPT,
  },
  {
    id: "doc-polish",
    name: "文档润色专家",
    description: "润色与校对中文文档：修正语病、统一风格、优化结构，适合公文、报告与邮件。",
    author: "MyBuddy",
    emoji: "✍️",
    tags: ["润色", "校对", "公文", "邮件"],
    category: "内容创作",
    version: "1.0.0",
    examples: ["帮我把这段报告润色得更正式", "检查这封邮件的语气和错别字"],
    promptMd: DOC_POLISH_PROMPT,
  },
];

/* ------------------------------------------------------------------ */
/* 读取 / 写入                                                        */
/* ------------------------------------------------------------------ */

function readStored(dir: string): StoredExpert | null {
  const metaPath = join(dir, "expert.json");
  if (!existsSync(metaPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    // Legacy team definitions and team-owned member records are intentionally invisible.
    if (raw.kind === "team" || typeof raw.teamOf === "string") return null;
    return raw as unknown as StoredExpert;
  } catch {
    return null;
  }
}

function expertDirOf(id: string): string {
  return join(getExpertsDir(), slugify(id));
}

function toExpertDto(dir: string, stored: StoredExpert): ExpertDto {
  return {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    author: stored.author,
    emoji: stored.emoji,
    tags: stored.tags ?? [],
    category: stored.category,
    version: stored.version,
    examples: stored.examples,
    enabled: stored.enabled,
    installed: true,
    source: stored.source,
    installedAt: stored.installedAt,
    filePath: join(dir, stored.promptFile ?? "prompt.md"),
    skills: stored.skills,
    mcpIds: capabilityIds(stored.mcpIds),
    connectorIds: capabilityIds(stored.connectorIds),
  };
}

/** 解析 CodeBuddy 官方 agents/*.md → 归一化元信息 + 正文 */
function parseAgentMd(
  mdContent: string,
  fallbackName: string,
): { meta: Omit<StoredExpert, "enabled" | "source" | "installedAt">; body: string } {
  const { body, fm } = readFrontmatter(mdContent);
  const name = pickZh(fm.displayName, String(fm.name ?? fallbackName));
  const tagsRaw = Array.isArray(fm.tags)
    ? fm.tags.map(String)
    : String(fm.tags ?? "")
        .split(/[,\s]+/)
        .filter(Boolean);
  return {
    meta: {
      id: slugify(String(fm.name ?? fallbackName)),
      name,
      description: String(fm.description ?? body.split("\n").find((l) => l.trim()) ?? name),
      author: String(fm.author ?? "MyBuddy 社区"),
      emoji: "🧙",
      tags: tagsRaw.length ? tagsRaw : ["导入专家"],
      category: String(fm.category ?? ""),
      version: fm.version ? String(fm.version) : undefined,
      examples: Array.isArray(fm.examples)
        ? fm.examples.map(String)
        : fm.examples
          ? [String(fm.examples)]
          : undefined,
      promptFile: "prompt.md",
    },
    body,
  };
}

/** 解析 .codebuddy-plugin/plugin.json（官方可选元数据，字段缺失时回退 agents/*.md） */
function parsePluginJson(
  content: string,
): Partial<Pick<StoredExpert, "id" | "name" | "description" | "author" | "emoji" | "tags" | "category" | "version" | "mcpIds" | "connectorIds">> {
  try {
    const j = JSON.parse(content) as Record<string, unknown>;
    return {
      id: j.id ? slugify(String(j.id)) : undefined,
      name: pickZh(j.displayName, String(j.name ?? "")),
      description: j.description ? String(j.description) : undefined,
      author: j.author ? String(j.author) : undefined,
      emoji: j.icon && typeof j.icon === "string" ? String(j.icon) : undefined,
      tags: Array.isArray(j.tags) ? j.tags.map(String) : undefined,
      category: j.category ? String(j.category) : undefined,
      version: j.version ? String(j.version) : undefined,
      mcpIds: capabilityIds(j.mcpIds),
      connectorIds: capabilityIds(j.connectorIds),
    };
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* 本地市场（MyBuddy 专家包归档）：mybuddyskills-main/experts 等   */
/* ------------------------------------------------------------------ */

/** 官方专家包 plugin.json 的完整结构（MyBuddy 专家中心导出格式） */
interface LocalPluginJson {
  mcpIds?: string[];
  connectorIds?: string[];
  name: string;
  version?: string;
  displayName?: { en?: string; zh?: string };
  profession?: { en?: string; zh?: string };
  displayDescription?: { en?: string; zh?: string };
  description?: string;
  author?: string | { name?: string };
  categoryId?: string;
  expertType?: "agent" | "team";
  /** agent 型：主角色 md 文件名（不含路径） */
  agentName?: string;
  agents?: string[];
  /** 头像相对路径（相对包目录） */
  avatar?: string;
  teamInfo?: { leadAgent?: string; memberAgents?: string[] };
  members?: Array<{
    id: string;
    name?: { en?: string; zh?: string };
    profession?: { en?: string; zh?: string };
    avatar?: string;
    role?: string;
  }>;
}

/** 官方 14 分类的中文名（对应 expert_center.json categories） */
const CATEGORY_ZH: Record<string, string> = {
  "01-ProductDesign": "产品设计",
  "02-Engineering": "技术工程",
  "03-GameSpatial": "游戏空间",
  "04-DataAI": "数据智能",
  "05-MarketingGrowth": "营销增长",
  "06-ContentCreative": "内容创作",
  "07-SalesCommerce": "销售商务",
  "08-FinanceInvestment": "金融投资",
  "09-OperationsHR": "运营人力",
  "10-ProjectQuality": "项目质量",
  "11-SecurityCompliance": "法务安全",
  "12-IndustryConsultant": "行业顾问",
  "13-TencentZone": "腾讯专区",
  "14-GlobalDevelopment": "全球发展",
};

function pickLocalZh(v: { en?: string; zh?: string } | string | undefined, fallback = ""): string {
  if (!v) return fallback;
  if (typeof v === "string") return v;
  return v.zh ?? v.en ?? fallback;
}

function authorName(author: LocalPluginJson["author"]): string {
  if (!author) return "MyBuddy 市场";
  if (typeof author === "string") return author;
  return author.name ?? "MyBuddy 市场";
}

function readLocalPlugin(dir: string): LocalPluginJson | null {
  try {
    const p = join(dir, ".codebuddy-plugin", "plugin.json");
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf-8")) as LocalPluginJson;
    if (!j?.name) return null;
    return j;
  } catch {
    return null;
  }
}

/** 本地市场根目录（含 experts/ 子目录） */
function findLocalMarketRoots(): string[] {
  const roots: string[] = [];
  // 应用级：~/.mybuddy/plugins/expert-market/experts（用户可把归档拷到这里）
  const appRoot = join(getExpertMarketDir(), "experts");
  if (existsSync(appRoot)) roots.push(appRoot);
  // 开发态：项目目录下解压的 mybuddyskills-main/experts
  const devRoot = join(process.cwd(), "mybuddyskills-main", "experts");
  if (existsSync(devRoot)) roots.push(devRoot);
  return roots;
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

function isAllowedMarketExpertPath(target: string): boolean {
  const t = normalizePathKey(target);
  const markers = [
    `${sep}mybuddyskills-main${sep}experts${sep}`,
    `${sep}expert-market${sep}experts${sep}`,
  ];
  return markers.some((m) => t.includes(m));
}

function hiddenMarketExpertsPath(): string {
  return join(getPluginsDir(), "market-hidden-experts.json");
}

function readHiddenExpertIds(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(hiddenMarketExpertsPath(), "utf-8")) as string[];
    return new Set((raw ?? []).map((x) => x.toLowerCase()));
  } catch {
    return new Set();
  }
}

function writeHiddenExpertIds(ids: Set<string>): void {
  writeFileSync(hiddenMarketExpertsPath(), JSON.stringify([...ids].sort(), null, 2), "utf-8");
}

interface LocalMarketPackage {
  /** 目录名（slug） */
  slug: string;
  /** 包绝对路径 */
  dir: string;
  plugin: LocalPluginJson;
  /** agentName → 角色 md 绝对路径 */
  agentMds: Map<string, string>;
  /** 第一个角色 md（无 agentName 时的兜底） */
  firstAgentMd: string | null;
  avatarPath: string | null;
}

/** 扫描本地市场的全部专家包 */
function scanLocalMarket(): LocalMarketPackage[] {
  const out: LocalMarketPackage[] = [];
  for (const root of findLocalMarketRoots()) {
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
      const plugin = readLocalPlugin(dir);
      if (!plugin) continue;
      const agentMds = new Map<string, string>();
      const agentsDir = join(dir, "agents");
      if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
        for (const f of readdirSync(agentsDir)) {
          if (!f.toLowerCase().endsWith(".md")) continue;
          agentMds.set(f.replace(/\.md$/i, "").toLowerCase(), join(agentsDir, f));
        }
      }
      let avatarPath: string | null = null;
      if (plugin.avatar) {
        const p = join(dir, plugin.avatar.replace(/^\//, ""));
        if (existsSync(p)) avatarPath = p;
      }
      if (!avatarPath) {
        const avatarsDir = join(dir, "avatars");
        if (existsSync(avatarsDir) && statSync(avatarsDir).isDirectory()) {
          const img = readdirSync(avatarsDir).find((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
          if (img) avatarPath = join(avatarsDir, img);
        }
      }
      out.push({
        slug: name,
        dir,
        plugin,
        agentMds,
        firstAgentMd: agentMds.size ? [...agentMds.values()][0] : null,
        avatarPath,
      });
    }
  }
  return out;
}

/** 包 → 市场专家条目（仅 agent 型；team 型在扫描后被过滤）。 */
function packageToMarketExpert(pkg: LocalMarketPackage): MarketExpertDto {
  const p = pkg.plugin;
  return {
    id: pkg.slug,
    name: pickLocalZh(p.displayName, p.name),
    description: pickLocalZh(p.displayDescription) || p.description || `来自 MyBuddy 专家市场的「${p.name}」`,
    author: pickLocalZh(p.profession) || authorName(p.author),
    emoji: "🧙",
    tags: p.categoryId && CATEGORY_ZH[p.categoryId] ? [CATEGORY_ZH[p.categoryId]] : [],
    category: p.categoryId ? CATEGORY_ZH[p.categoryId] : undefined,
    version: p.version,
    mcpIds: capabilityIds(p.mcpIds),
    connectorIds: capabilityIds(p.connectorIds),
    sourcePath: pkg.dir,
  };
}

/** 从原始插件目录解析为（可安装的）专家定义；找不到 agents/*.md 抛错 */
function parsePluginDir(srcDir: string): Omit<StoredExpert, "enabled" | "source" | "installedAt"> {
  const pluginJsonPath = join(srcDir, ".codebuddy-plugin", "plugin.json");
  let pluginContent: string | null = null;
  if (existsSync(pluginJsonPath)) {
    pluginContent = readFileSync(pluginJsonPath, "utf-8");
    try {
      const plugin = JSON.parse(pluginContent) as LocalPluginJson;
      if (plugin.expertType === "team") throw new Error("不支持 Team 类型专家包，仅支持单专家包");
    } catch (error) {
      if (error instanceof Error && error.message === "不支持 Team 类型专家包，仅支持单专家包") throw error;
    }
  }
  const pluginMeta = pluginContent ? parsePluginJson(pluginContent) : {};

  const agentsDir = join(srcDir, "agents");
  const installedPrompt = join(srcDir, "prompt.md");
  let agentMdPath: string | null = existsSync(join(srcDir, "expert.json")) && existsSync(installedPrompt) ? installedPrompt : null;
  if (!agentMdPath && existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
    agentMdPath =
      readdirSync(agentsDir)
        .filter((f) => f.toLowerCase().endsWith(".md"))
        .map((f) => join(agentsDir, f))
        .sort((a, b) => a.length - b.length)[0] ?? null;
  }
  if (!agentMdPath) {
    // 兼容：目录直接放 prompt.md
    const direct = join(srcDir, "prompt.md");
    if (existsSync(direct)) agentMdPath = direct;
  }
  if (!agentMdPath) throw new Error("未找到 agents/*.md 或 prompt.md，无法识别为专家插件");

  const agent = parseAgentMd(
    readFileSync(agentMdPath, "utf-8"),
    agentMdPath === join(srcDir, "prompt.md") ? "expert" : "expert",
  );
  return {
    ...agent.meta,
    ...pluginMeta,
    id: pluginMeta.id ?? agent.meta.id,
    name: pluginMeta.name ?? agent.meta.name,
    description: pluginMeta.description ?? agent.meta.description,
    author: pluginMeta.author ?? agent.meta.author,
    emoji: pluginMeta.emoji ?? agent.meta.emoji ?? "🧙",
    tags: pluginMeta.tags ?? agent.meta.tags,
    category: pluginMeta.category ?? agent.meta.category,
    version: pluginMeta.version ?? agent.meta.version,
    promptFile: agentMdPath === join(srcDir, "prompt.md") ? "prompt.md" : undefined,
  };
}

/** 拷贝原始目录中的头像（avatars/* 或 avatar.*），无则返回 undefined */
function copyAvatar(srcDir: string, destDir: string): string | undefined {
  const candidates: string[] = [];
  const avatarsDir = join(srcDir, "avatars");
  if (existsSync(avatarsDir) && statSync(avatarsDir).isDirectory()) {
    candidates.push(
      ...readdirSync(avatarsDir)
        .filter((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
        .map((f) => join(avatarsDir, f)),
    );
  }
  const rootAvatar = ["avatar.png", "avatar.jpg", "icon.png"].find((f) =>
    existsSync(join(srcDir, f)),
  );
  if (rootAvatar) candidates.push(join(srcDir, rootAvatar));
  if (candidates.length === 0) return undefined;
  const ext = candidates[0].split(".").pop() ?? "png";
  copyFileSync(candidates[0], join(destDir, `avatar.${ext}`));
  return `avatar.${ext}`;
}

/** 枚举某包 skills/ 目录下的技能目录名（单技能形式 skills/SKILL.md → [fallbackId]） */
function listPackageSkillDirs(skillsDir: string, fallbackId: string): string[] {
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return [];
  if (existsSync(join(skillsDir, "SKILL.md")) || existsSync(join(skillsDir, "skill.md"))) {
    return [fallbackId.toLowerCase()];
  }
  return readdirSync(skillsDir)
    .filter((n) => {
      try {
        return statSync(join(skillsDir, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((n) => n.toLowerCase());
}

/**
 * 复制专家包自带 skills/ 到专家私有目录（~/.mybuddy/plugins/experts/<id>/skills/）。
 * 单技能形式（skills/SKILL.md）与多技能形式（skills/<name>/SKILL.md）均支持。
 * 目录名来自 readdirSync 且经 slug 清洗（防路径穿越），不存在则静默跳过。
 * 返回安装的技能目录名（小写）。
 */
function copyPackageSkills(
  srcSkillsDir: string,
  destExpertDir: string,
  fallbackId: string,
): string[] {
  if (!existsSync(srcSkillsDir) || !statSync(srcSkillsDir).isDirectory()) return [];
  const safeName = (raw: string): string => {
    const n = raw
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return n || fallbackId.toLowerCase();
  };
  const destRoot = join(destExpertDir, "skills");
  if (existsSync(destRoot)) rmSync(destRoot, { recursive: true, force: true });
  ensureDir(destRoot);
  const installed: string[] = [];
  if (existsSync(join(srcSkillsDir, "SKILL.md")) || existsSync(join(srcSkillsDir, "skill.md"))) {
    const dest = join(destRoot, safeName(fallbackId));
    cpSync(srcSkillsDir, dest, { recursive: true });
    sanitizePrivateSkillPackage(dest);
    installed.push(safeName(fallbackId));
  } else {
    for (const name of readdirSync(srcSkillsDir)) {
      const src = join(srcSkillsDir, name);
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      const dest = join(destRoot, safeName(name));
      cpSync(src, dest, { recursive: true });
      sanitizePrivateSkillPackage(dest);
      installed.push(safeName(name));
    }
  }
  return installed;
}

/* ------------------------------------------------------------------ */
/* 服务                                                               */
/* ------------------------------------------------------------------ */

export class ExpertService {
  /* ---------- 市场 ---------- */

  listMarket(): MarketExpertDto[] {
    const hidden = readHiddenExpertIds();
    const catalog = new Map<string, MarketExpertDto>();
    for (const e of BUILTIN_EXPERTS) {
      if (hidden.has(e.id.toLowerCase())) continue;
      const { promptMd: _promptMd, ...dto } = e;
      catalog.set(e.id.toLowerCase(), dto);
    }
    // 本地市场（mybuddyskills 等专家包归档）：agent 型包 → 市场条目
    const local = new Map<string, LocalMarketPackage>();
    for (const pkg of scanLocalMarket()) {
      local.set(pkg.slug.toLowerCase(), pkg);
      if (hidden.has(pkg.slug.toLowerCase())) continue;
      if (pkg.plugin.expertType !== "team" && !catalog.has(pkg.slug.toLowerCase())) {
        catalog.set(pkg.slug.toLowerCase(), packageToMarketExpert(pkg));
      }
    }
    // 本地市场：~/.mybuddy/plugins/experts 里已安装的也可作为可重装来源
    for (const installed of this.listInstalled()) {
      if (hidden.has(installed.id.toLowerCase())) continue;
      if (installed.source !== "builtin-market" && !catalog.has(installed.id.toLowerCase())) {
        catalog.set(installed.id.toLowerCase(), {
          id: installed.id,
          name: installed.name,
          description: installed.description,
          author: installed.author,
          emoji: installed.emoji,
          tags: installed.tags,
          category: installed.category,
          version: installed.version,
          examples: installed.examples,
          mcpIds: installed.mcpIds,
          connectorIds: installed.connectorIds,
          sourcePath: installed.filePath ? join(installed.filePath, "..") : undefined,
        });
      }
    }
    return [...catalog.values()];
  }

  /**
   * - 磁盘包（local-market）：删除包目录
   * - 内置：写入隐藏列表
   * - 若已安装：一并删除本地安装
   * id 仅接受单专家 id。
   */
  deleteFromMarket(id: string): void {
    const targetId = id.trim();
    if (!targetId) throw new Error("专家 id 为空");
    assertSingleExpertId(targetId);
    const hidden = readHiddenExpertIds();
    const key = targetId.toLowerCase();

    const pkg = scanLocalMarket().find((p) => {
      if (p.plugin.expertType === "team") return false;
      const slug = p.slug.toLowerCase();
      const name = (p.plugin.name ?? "").toLowerCase();
      const display = pickLocalZh(p.plugin.displayName, p.plugin.name).toLowerCase();
      return slug === key || name === key || display === key;
    });
    if (pkg) {
      if (!isUnderRoots(pkg.dir, findLocalMarketRoots()) && !isAllowedMarketExpertPath(pkg.dir)) {
        throw new Error(`拒绝删除专家市场外路径: ${pkg.dir}`);
      }
      try { this.uninstall(pkg.slug); } catch { /* not installed */ }
      rmSync(pkg.dir, { recursive: true, force: true });
      return;
    }

    const builtin = BUILTIN_EXPERTS.find(
      (e) => e.id === targetId || e.name === targetId || e.id.toLowerCase() === key || e.name.toLowerCase() === key,
    );
    if (builtin) {
      hidden.add(builtin.id.toLowerCase());
      writeHiddenExpertIds(hidden);
      try { this.uninstall(builtin.id); } catch { /* not installed */ }
      return;
    }

    const market = this.listMarket().find(
      (e) => e.id === targetId || e.name === targetId || e.id.toLowerCase() === key || e.name.toLowerCase() === key,
    );
    if (market) {
      try { this.uninstall(market.id); } catch { /* not installed */ }
      hidden.add(market.id.toLowerCase());
      writeHiddenExpertIds(hidden);
      return;
    }
    throw new Error(`市场中未找到可删除的专家: ${id}`);
  }

  listInstalled(): ExpertDto[] {
    const root = getExpertsDir();
    const out: ExpertDto[] = [];
    for (const name of readdirSync(root)) {
      if (name.startsWith(".")) continue; // Pending swaps and recovery backups are not installed templates.
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const stored = readStored(dir);
      if (!stored) continue;
      out.push(toExpertDto(dir, stored));
    }
    return out.sort((a, b) => (b.installedAt ?? 0) - (a.installedAt ?? 0));
  }

  getDetail(id: string): ExpertDetailDto {
    assertSingleExpertId(id);
    const expert = this.findExpertById(id.trim());
    if (!expert?.filePath) throw new Error(`未找到已安装专家: ${id}`);
    const dir = dirname(expert.filePath);
    const stored = readStored(dir)!;
    return {
      ...expert,
      instructions: readFrontmatter(readFileSync(expert.filePath, "utf-8")).body.trim(),
      skills: listPackageSkillDirs(join(dir, "skills"), expert.id),
      revision: packageRevision(dir),
      mcpIds: capabilityIds(stored.mcpIds),
      connectorIds: capabilityIds(stored.connectorIds),
    };
  }

  /** Edits only this reusable template. Task-owned snapshots are stored independently. */
  update(input: ExpertUpdateRequest, skillSourceDirs: Record<string, string> = {}): ExpertDetailDto {
    const detail = this.getDetail(input.id);
    const name = input.name?.trim();
    const description = input.description?.trim();
    const instructions = input.instructions?.trim();
    if (!name || !description || !instructions) throw new Error("专家名称、描述和角色说明不能为空");
    if (!input.expectedRevision || input.expectedRevision !== detail.revision) throw new Error("专家已发生变化，请重新加载后再保存");
    const dir = dirname(detail.filePath!);
    const stored = readStored(dir)!;
    const skillIds = input.skillIds === undefined ? undefined : capabilityIds(input.skillIds);
    const next: StoredExpert = { ...stored, name, description, promptFile: "prompt.md",
      mcpIds: capabilityIds(input.mcpIds), connectorIds: capabilityIds(input.connectorIds) };
    replaceExpertDirectory(dir, stage => {
      cpSync(dir, stage, { recursive: true, filter: path => !lstatSync(path).isSymbolicLink() });
      if (skillIds !== undefined) {
        const root = join(stage, "skills");
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
        for (const id of skillIds) {
          const target = privateSkillPath(root, id);
          const existingRoot = join(dir, "skills");
          const existing = privateSkillPath(existingRoot, id);
          const singleSkill = id === stored.id && (existsSync(join(existingRoot, "SKILL.md")) || existsSync(join(existingRoot, "skill.md")));
          const source = detail.skills?.includes(id) ? (singleSkill ? existingRoot : existing) : skillSourceDirs[id];
          if (!source || !existsSync(source) || lstatSync(source).isSymbolicLink() ||
              !(existsSync(join(source, "SKILL.md")) || existsSync(join(source, "skill.md")))) {
            throw new Error(`Private Skill 未安装或缺少 SKILL.md: ${id}`);
          }
          ensureDir(root);
          cpSync(source, target, { recursive: true });
          sanitizePrivateSkillPackage(target);
        }
      }
      next.skills = listPackageSkillDirs(join(stage, "skills"), next.id);
      writeFileSync(join(stage, "prompt.md"), editablePrompt(readFileSync(detail.filePath!, "utf-8"), next, instructions), "utf-8");
      writeFileSync(join(stage, "expert.json"), JSON.stringify(next, null, 2), "utf-8");
      const pluginDir = join(stage, ".codebuddy-plugin");
      let plugin: Record<string, unknown> = {};
      try { plugin = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf-8")); } catch { /* optional import metadata */ }
      ensureDir(pluginDir);
      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ ...plugin, id: next.id, name: next.id,
        displayName: { zh: next.name, en: next.name }, description: next.description, version: next.version ?? "1.0.0",
        mcpIds: next.mcpIds, connectorIds: next.connectorIds }, null, 2), "utf-8");
      if (packageRevision(dir) !== input.expectedRevision) throw new Error("专家已发生变化，请重新加载后再保存");
    });
    return this.getDetail(detail.id);
  }

  /** Internal task snapshot copy source; enabled state is checked separately when admitting a new binding. */
  getPrivateSkillsDirectoryForSnapshot(id: string): string | null {
    const expert = this.getDetail(id);
    const skills = join(dirname(expert.filePath!), "skills");
    if (!existsSync(skills) || lstatSync(skills).isSymbolicLink() || !statSync(skills).isDirectory()) return null;
    return skills;
  }

  /* ---------- 安装 / 卸载 / 启停 ---------- */

  /**
   * 从市场安装：
   * - 内置市场 / 已安装回看 → 复制目录或写内置模板
   * - 本地市场 agent 型包 → 安装主角色（plugin.agentName 或第一个 agents/*.md）+ 头像
   * - team 型包不进入市场列表，直接导入时明确拒绝。
   */
  installFromMarket(id: string): ExpertDto {
    assertSingleExpertId(id);
    const market = this.listMarket();
    const def = market.find((e) => e.id === id || e.name === id);
    if (!def) throw new Error(`市场中未找到专家: ${id}`);
    const builtin = BUILTIN_EXPERTS.find((e) => e.id === def.id);

    // 本地市场 agent 型包：精确安装主角色（避免把 8 个 agent 的包整个拷过来）
    if (!builtin && def.sourcePath) {
      const pkg = scanLocalMarket().find((p) => p.slug.toLowerCase() === def.id.toLowerCase());
      if (pkg) return this.installLocalAgent(pkg);
    }

    const installedDest = expertDirOf(def.id);
    return replaceExpertDirectory(installedDest, dest => {
      let packageSkills: string[] | undefined;
      if (builtin) {
        writeFileSync(join(dest, "prompt.md"), builtin.promptMd, "utf-8");
      } else if (def.sourcePath && existsSync(def.sourcePath)) {
        cpSync(def.sourcePath, dest, { recursive: true });
        const privateSkillsRoot = join(dest, "skills");
        if (existsSync(privateSkillsRoot)) sanitizePrivateSkillPackage(privateSkillsRoot);
        // 目录里若有原始插件文件（agents/、.codebuddy-plugin/），保留无妨；
        // 归一化元信息统一写入 expert.json；自带 skills/ 记录为 Private Skills
        const skills = listPackageSkillDirs(join(dest, "skills"), def.id);
        packageSkills = skills.length ? skills : undefined;
      } else {
        throw new Error(`专家 ${def.id} 缺少可安装内容`);
      }

      const stored: StoredExpert = {
        id: def.id,
        name: def.name,
        description: def.description,
        author: def.author,
        emoji: def.emoji,
        tags: def.tags ?? [],
        category: def.category,
        version: def.version,
        examples: def.examples,
        enabled: true,
        source: builtin ? "builtin-market" : "local-market",
        installedAt: Date.now(),
        promptFile: "prompt.md",
        skills: packageSkills,
        mcpIds: capabilityIds(def.mcpIds),
        connectorIds: capabilityIds(def.connectorIds),
      };
      writeFileSync(join(dest, "expert.json"), JSON.stringify(stored, null, 2), "utf-8");
      return toExpertDto(installedDest, stored);
    });
  }

  /** 安装本地市场 agent 型包：主角色 md + 头像，不复制 skills/大文件 */
  private installLocalAgent(pkg: LocalMarketPackage): ExpertDto {
    const p = pkg.plugin;
    const targetMd =
      (p.agentName && pkg.agentMds.get(p.agentName.toLowerCase())) ?? pkg.firstAgentMd;
    if (!targetMd) throw new Error(`专家包 ${pkg.slug} 缺少 agents/*.md`);

    const installedDest = expertDirOf(pkg.slug);
    return replaceExpertDirectory(installedDest, dest => {
      const mdContent = readFileSync(targetMd, "utf-8");
      writeFileSync(join(dest, "prompt.md"), mdContent, "utf-8");
      let avatarFile: string | undefined;
      if (pkg.avatarPath) {
        const ext = (pkg.avatarPath.split(".").pop() ?? "png").toLowerCase();
        avatarFile = `avatar.${ext}`;
        copyFileSync(pkg.avatarPath, join(dest, avatarFile));
      }
      const category = p.categoryId ? CATEGORY_ZH[p.categoryId] : undefined;
      // 专家包自带 skills/ → 专家私有目录（不进入全局 Skill Center）
      const skills = copyPackageSkills(join(pkg.dir, "skills"), dest, pkg.slug);
      const stored: StoredExpert = {
        id: pkg.slug,
        name: pickLocalZh(p.displayName, p.name),
        description:
          pickLocalZh(p.displayDescription) || p.description || `来自 MyBuddy 专家市场的「${p.name}」`,
        author: authorName(p.author),
        emoji: "🧙",
        tags: category ? [category] : [],
        category,
        version: p.version,
        enabled: true,
        source: "local-market",
        installedAt: Date.now(),
        promptFile: "prompt.md",
        avatarFile,
        skills: skills.length ? skills : undefined,
        mcpIds: capabilityIds(p.mcpIds),
        connectorIds: capabilityIds(p.connectorIds),
      };
      writeFileSync(join(dest, "expert.json"), JSON.stringify(stored, null, 2), "utf-8");
      return toExpertDto(installedDest, stored);
    });
  }

  /** 从目录安装（官方插件结构：.codebuddy-plugin + agents/*.md + avatars/） */
  installByPath(srcPath: string): ExpertDto {
    const src = srcPath.trim();
    if (!src || !existsSync(src)) throw new Error("专家路径不存在");
    if (!statSync(src).isDirectory()) throw new Error("专家导入需要目录或 zip 包");

    const meta = parsePluginDir(src);
    const installedDest = expertDirOf(meta.id);
    return replaceExpertDirectory(installedDest, dest => {
      // 复制角色提示词与原始结构
      if (meta.promptFile) {
        copyFileSync(join(src, "prompt.md"), join(dest, "prompt.md"));
      } else {
        const agentsDir = join(src, "agents");
        cpSync(agentsDir, join(dest, "agents"), { recursive: true });
        const mdFiles = readdirSync(join(dest, "agents")).filter((f) =>
          f.toLowerCase().endsWith(".md"),
        );
        if (mdFiles.length === 0) throw new Error("专家目录缺少 agents/*.md");
        // 归一化：以第一个 md 作为 prompt.md 入口
        copyFileSync(join(dest, "agents", mdFiles[0]), join(dest, "prompt.md"));
      }
      const avatarFile = copyAvatar(src, dest);
      // 目录导入同样保留包内 skills/ 为专家私有技能
      const skills = copyPackageSkills(join(src, "skills"), dest, meta.id);

      const stored: StoredExpert = {
        ...meta,
        emoji: meta.emoji ?? "🧙",
        enabled: true,
        source: "folder",
        installedAt: Date.now(),
        promptFile: "prompt.md",
        avatarFile,
        skills: skills.length ? skills : undefined,
      };
      writeFileSync(join(dest, "expert.json"), JSON.stringify(stored, null, 2), "utf-8");
      return toExpertDto(installedDest, stored);
    });
  }

  /** 从 zip 导入（官方「导入专家」：解包后按目录安装） */
  async importZip(zipPath: string): Promise<ExpertDto> {
    if (!existsSync(zipPath)) throw new Error("zip 文件不存在");
    const data = readFileSync(zipPath);
    const zip = await JSZip.loadAsync(data);
    const entries = Object.keys(zip.files).filter((k) => !zip.files[k].dir);

    const findEntry = (suffix: string): string | undefined =>
      entries.find((k) => k.replace(/\\/g, "/").toLowerCase().endsWith(suffix));

    const agentMdEntry = findEntry("agents/.md")
      ? undefined
      : entries
          .filter((k) => k.replace(/\\/g, "/").match(/agents\/[^/]+\.md$/i))
          .sort((a, b) => a.length - b.length)[0];
    const pluginJsonEntry = findEntry(".codebuddy-plugin/plugin.json");
    const avatarEntry = entries.find((k) => k.replace(/\\/g, "/").match(/avatars\/[^/]+\.(png|jpg|jpeg|webp|gif)$/i));
    const promptMdEntry = entries.find(key => key.replace(/\\/g, "/").toLowerCase() === "prompt.md") ?? findEntry("/prompt.md");

    const agentMdPath = agentMdEntry ?? promptMdEntry;
    if (!agentMdPath) throw new Error("zip 中未找到 agents/*.md 或 prompt.md，不是有效的专家包");

    const agentMdContent = await zip.files[agentMdPath].async("string");
    const agent = parseAgentMd(agentMdContent, "expert");
    let pluginMeta: ReturnType<typeof parsePluginJson> = {};
    if (pluginJsonEntry) {
      const pluginContent = await zip.files[pluginJsonEntry].async("string");
      try {
        const plugin = JSON.parse(pluginContent) as LocalPluginJson;
        if (plugin.expertType === "team") throw new Error("Expert team packages are not supported");
      } catch (error) {
        if (error instanceof Error && error.message === "Expert team packages are not supported") throw error;
      }
      pluginMeta = parsePluginJson(pluginContent);
    }

    const meta = {
      ...agent.meta,
      ...pluginMeta,
      id: pluginMeta.id ?? agent.meta.id,
      name: pluginMeta.name ?? agent.meta.name,
      description: pluginMeta.description ?? agent.meta.description,
      author: pluginMeta.author ?? agent.meta.author,
      emoji: pluginMeta.emoji ?? agent.meta.emoji ?? "🧙",
      tags: pluginMeta.tags ?? agent.meta.tags,
      category: pluginMeta.category ?? agent.meta.category,
      version: pluginMeta.version ?? agent.meta.version,
    };

    const installedDest = expertDirOf(meta.id);
    const transaction = stageExpertDirectory(installedDest);
    const dest = transaction.stage;
    try {
      writeFileSync(join(dest, "prompt.md"), agentMdContent, "utf-8");
      let avatarFile: string | undefined;
      if (avatarEntry) {
        const ext = (avatarEntry.split(".").pop() ?? "png").toLowerCase();
        avatarFile = `avatar.${ext}`;
        writeFileSync(join(dest, avatarFile), await zip.files[avatarEntry].async("nodebuffer"));
      }

      // zip 包内 skills/ 目录 → 专家私有技能（路径分段校验防穿越）
      const installedSkills: string[] = [];
      let skillsPrefix: string | null = null;
      const skillRelFiles: Array<{ rel: string; entry: string }> = [];
      for (const key of entries) {
        const norm = key.replace(/\\/g, "/");
        const m = /^(.*\/)?skills\/(.+)$/.exec(norm);
        if (!m) continue;
        const prefix = m[1] ?? "";
        const rel = m[2];
        // 防穿越：拒绝 .. / 空段 / 绝对路径
        if (rel.split("/").some((s) => s === ".." || s === "")) continue;
        if (skillsPrefix === null) skillsPrefix = prefix;
        if (prefix !== skillsPrefix) continue;
        skillRelFiles.push({ rel, entry: key });
      }
      if (skillRelFiles.length > 0) {
        const skillsRoot = join(dest, "skills");
        ensureDir(skillsRoot);
        for (const { rel, entry } of skillRelFiles) {
          const target = join(skillsRoot, rel);
          ensureDir(dirname(target));
          writeFileSync(target, await zip.files[entry].async("nodebuffer"));
        }
        sanitizePrivateSkillPackage(skillsRoot);
        const top = skillRelFiles
          .map((f) => f.rel.split("/")[0])
          .filter((s, i, a) => a.indexOf(s) === i);
        installedSkills.push(...top.map((s) => s.toLowerCase()));
      }

      const stored: StoredExpert = {
        ...meta,
        enabled: true,
        source: "zip",
        installedAt: Date.now(),
        promptFile: "prompt.md",
        avatarFile,
        skills: installedSkills.length ? installedSkills : undefined,
      };
      writeFileSync(join(dest, "expert.json"), JSON.stringify(stored, null, 2), "utf-8");
      transaction.commit();
      return toExpertDto(installedDest, stored);
    } finally { transaction.discard(); }
  }

  /** 导出为官方兼容 zip（metadata + agent prompt + avatar + Private Skills），返回 zip 路径 */
  async exportZip(id: string): Promise<string> {
    assertSingleExpertId(id);
    const expert = this.listInstalled().find((e) => e.id === id || e.name === id);
    if (!expert?.filePath) throw new Error(`未找到已安装专家: ${id}`);
    const dir = join(expert.filePath, "..");
    const stored = readStored(dir) as StoredExpert | null;
    if (!stored) throw new Error(`专家元信息缺失: ${id}`);

    const md = readFileSync(join(dir, "prompt.md"), "utf-8");
    const zip = new JSZip();
    zip.file(
      ".codebuddy-plugin/plugin.json",
      JSON.stringify(
        {
          name: stored.id,
          version: stored.version ?? "1.0.0",
          description: stored.description,
          displayName: { zh: stored.name, en: stored.name },
          tags: stored.tags ?? [],
          category: stored.category,
          author: stored.author,
          mcpIds: capabilityIds(stored.mcpIds),
          connectorIds: capabilityIds(stored.connectorIds),
        },
        null,
        2,
      ),
    );
    zip.file(`agents/${stored.id}.md`, md);
    if (stored.avatarFile && existsSync(join(dir, stored.avatarFile))) {
      zip.file(
        `avatars/${stored.avatarFile}`,
        readFileSync(join(dir, stored.avatarFile)),
      );
    }

    // Private Skills 属于专家包的一部分；完整递归导出，确保导出 → 重导入能力不丢失。
    addDirectoryToZip(zip, join(dir, "skills"), "skills");
    zip.file(
      "README.md",
      `# ${stored.name}\n\n${stored.description}\n\n> 由 MyBuddy 导出的 MyBuddy 兼容专家插件（Agent 型）。\n> 安装：专家 → 专家中心 → 导入 ZIP / 从文件夹导入。\n`,
    );

    const outDir = getExpertExportsDir();
    ensureDir(outDir);
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const outPath = join(outDir, `${stored.id}-${ts}.zip`);
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    writeFileSync(outPath, buf);
    return outPath;
  }

  uninstall(id: string): void {
    assertSingleExpertId(id);
    const expert = this.listInstalled().find((e) => e.id === id || e.name === id);
    if (!expert?.filePath) throw new Error(`未找到已安装专家: ${id}`);
    const dir = join(expert.filePath, "..");
    rmSync(dir, { recursive: true, force: true });
  }

  setEnabled(id: string, enabled: boolean): ExpertDto {
    assertSingleExpertId(id);
    const expert = this.listInstalled().find((e) => e.id === id || e.name === id);
    if (!expert?.filePath) throw new Error(`未找到已安装专家: ${id}`);
    const dir = join(expert.filePath, "..");
    const stored = readStored(dir) as StoredExpert | null;
    if (!stored) throw new Error(`专家元信息缺失: ${id}`);
    stored.enabled = enabled;
    writeFileSync(join(dir, "expert.json"), JSON.stringify(stored, null, 2), "utf-8");
    return { ...expert, enabled };
  }

  /* ---------- 角色注入（供 AgentService 使用） ---------- */

  /** 与 getRolePrompt 共用真实可用性判断，供 Runtime resolution/trace 使用。 */
  isRuntimeAvailable(expertId: string): boolean {
    try {
      this.getRolePrompt(expertId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 返回注入系统提示的「## 专家角色」段落（正文）。
   */
  getRolePrompt(expertId: string): RolePromptResult {
    assertSingleExpertId(expertId);
    const id = expertId.trim();
    const expert = this.findExpertById(id);
    if (!expert) throw new Error(`专家未安装: ${id}，请先在专家中心安装`);
    if (!expert.enabled) throw new Error(`专家「${expert.name}」已停用，请先在专家中心启用`);
    if (!expert.filePath) throw new Error(`专家「${expert.name}」缺少 prompt 文件路径`);
    const md = readFileSync(expert.filePath, "utf-8");
    const { body } = readFrontmatter(md);
    const examples = expert.examples?.length
      ? `\n典型任务示例：\n${expert.examples.map((e) => `- ${e}`).join("\n")}`
      : "";
    return {
      kind: "expert",
      name: expert.name,
      emoji: expert.emoji,
      prompt: `## 专家角色\n名称：${expert.name}\n请以该专家的身份与专业视角处理本次任务${examples}\n\n${body}`,
    };
  }

  /**
   * 已安装且启用的专家 Private Skills 目录（~/.mybuddy/plugins/experts/<slug>/skills/）。
   * 未安装 / 已停用 / 无技能 → null。仅供会话装配按“当前选中专家”读取，不做全局扫描。
   * P3-4：enabled=false 的专家不贡献私有技能（与连接器 enabled 门禁对称）。
   */
  getPrivateSkillsDir(expertId: string): string | null {
    const id = expertId.trim();
    if (!id) return null;
    const dir = expertDirOf(id);
    const stored = readStored(dir);
    if (!stored || stored.enabled === false) return null;
    const skills = join(dir, "skills");
    if (!existsSync(skills)) return null;
    try {
      if (!statSync(skills).isDirectory()) return null;
    } catch {
      return null;
    }
    return skills;
  }

  /**
   * 只读枚举已安装专家的 Private Skills 详情（名称/描述）。
   * 读取 ~/.mybuddy/plugins/experts/<id>/skills/ 下各技能目录的 SKILL.md frontmatter；
   * 不写入全局 Skill Center、不做全局扫描；未安装/无技能 → 空数组。
   */
  listExpertPrivateSkills(expertId: string): PrivateSkillDto[] {
    const dir = this.getPrivateSkillsDir(expertId);
    if (!dir) return [];
    const out: PrivateSkillDto[] = [];
    // 单技能形式：skills/SKILL.md（id 回退为专家 id）
    const direct = ["SKILL.md", "skill.md"].map((n) => join(dir, n)).find((p) => existsSync(p));
    if (direct) {
      out.push(this.describePrivateSkill(dir, expertId));
      return out;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    for (const name of names) {
      const sub = join(dir, name);
      try {
        if (!statSync(sub).isDirectory()) continue;
      } catch {
        continue;
      }
      const skillMd = ["SKILL.md", "skill.md"].map((n) => join(sub, n)).find((p) => existsSync(p));
      if (!skillMd) continue;
      const { fm } = readFrontmatter(readFileSync(skillMd, "utf-8"));
      const fallbackName = name.toLowerCase();
      out.push({
        id: fallbackName,
        name: String(fm.name ?? fallbackName),
        description: String(fm.description ?? ""),
        // P3-2：被全局同名技能遮蔽的诊断（first-wins 优先级不变，仅提示）
        shadowed: this.isShadowedByGlobalSkill(String(fm.name ?? fallbackName)),
      });
    }
    return out;
  }

  /** P3-2：私有技能名是否被全局 ~/.mybuddy/plugins/skills 同名技能（大小写不敏感）覆盖 */
  private isShadowedByGlobalSkill(name: string): boolean {
    if (!name) return false;
    const root = getSkillsDir();
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      return false;
    }
    const key = name.toLowerCase();
    return entries.some((n) => {
      if (n.toLowerCase() !== key) return false;
      try {
        return statSync(join(root, n)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  /** 描述单个技能目录（单技能形式共用） */
  private describePrivateSkill(dir: string, fallbackId: string): PrivateSkillDto {
    const skillMd = ["SKILL.md", "skill.md"].map((n) => join(dir, n)).find((p) => existsSync(p));
    if (!skillMd) return { id: fallbackId.toLowerCase(), name: fallbackId, description: "" };
    try {
      const { fm } = readFrontmatter(readFileSync(skillMd, "utf-8"));
      const id = fallbackId.toLowerCase();
      return {
        id,
        name: String(fm.name ?? id),
        description: String(fm.description ?? ""),
        shadowed: this.isShadowedByGlobalSkill(String(fm.name ?? id)),
      };
    } catch {
      return { id: fallbackId.toLowerCase(), name: fallbackId, description: "" };
    }
  }

  /** 按 id 直接读已安装专家（含被隐藏的团队成员） */
  private findExpertById(id: string): ExpertDto | undefined {
    const dir = expertDirOf(id);
    const stored = readStored(dir);
    if (!stored) return undefined;
    const expert = toExpertDto(dir, stored as StoredExpert);
    return expert.id === id || expert.name === id ? expert : undefined;
  }
}
