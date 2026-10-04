import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";
import { getMyBuddyDir } from "../paths";
import type {
  ExpertAuthoringCreateRequest,
  SkillAuthoringCreateRequest,
  SkillAuthoringDraft,
  SkillEvalDefinitionDto,
  SkillEvalRunResultDto,
  SkillPackageValidationDto,
  SkillResourceCategory,
  SkillResourceEntryDto,
  SkillRevisionSnapshotDto,
} from "../../shared/agent-ipc";

export interface AuthoredSkillPackage {
  id: string;
  path: string;
  validation: SkillPackageValidationDto;
}

export interface AuthoredExpertPackage {
  id: string;
  path: string;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function slugify(value: string, fallback: string): string {
  const normalized = value.normalize("NFKC").toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug) return slug;
  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 8);
  return `${fallback}-${digest}`;
}

export function skillAuthoringIdFromName(value: string): string {
  return slugify(value, "skill");
}

export type SkillAuthoringPartialStage = "validation" | "install";
export class SkillAuthoringPartialStateError extends Error {
  constructor(
    public readonly stage: SkillAuthoringPartialStage,
    public readonly skillId: string,
    public readonly packagePath: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillAuthoringPartialStateError";
  }
}
function stableKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  const slug = normalized.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug) return slug.slice(0, 80);
  return `skill-${createHash("sha1").update(normalized).digest("hex").slice(0, 12)}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

function authoringRoot(kind: "skills" | "experts"): string {
  const root = join(getMyBuddyDir(), "authoring", kind);
  ensureDir(root);
  return root;
}

function authoringStatePath(kind: "reports" | "history", skillId: string): string {
  return join(getMyBuddyDir(), "authoring-state", kind, stableKey(skillId));
}

function authoringStateRoot(kind: "reports" | "history", skillId: string): string {
  const root = authoringStatePath(kind, skillId);
  ensureDir(root);
  return root;
}

function replaceDirectory(target: string, writer: (stage: string) => void): void {
  const stage = `${target}.tmp-${process.pid}-${Date.now()}`;
  rmSync(stage, { recursive: true, force: true });
  ensureDir(stage);
  try {
    writer(stage);
    rmSync(target, { recursive: true, force: true });
    cpSync(stage, target, { recursive: true });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function findSkillMd(dir: string): string | null {
  for (const name of ["SKILL.md", "skill.md"]) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

function countEvalCases(evalsDir: string): number {
  if (!existsSync(evalsDir)) return 0;
  let count = 0;
  for (const name of readdirSync(evalsDir)) {
    const path = join(evalsDir, name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    if (name.toLowerCase().endsWith(".json")) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as { cases?: unknown[] };
        count += Array.isArray(parsed.cases) ? parsed.cases.length : 1;
      } catch {
        count += 1;
      }
    } else {
      count += 1;
    }
  }
  return count;
}

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return { fields: {}, body: normalized };
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return { fields: {}, body: normalized };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    fields[m[1]] = m[2].trim();
  }
  return { fields, body: normalized.slice(match[0].length) };
}

function renderFrontmatter(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\s+/, "")}`;
}

function rewriteFrontmatterPreservingUnknown(raw: string, updates: Record<string, string>, body: string): string {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return renderFrontmatter(updates, body);
  const lines = match[1].split(/\r?\n/);
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
    const index = lines.findIndex((line) => pattern.test(line));
    if (index >= 0) lines[index] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  }
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\s+/, "")}`;
}

function removeFrontmatterFieldPreservingStructure(raw: string, key: string): string {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return normalized;
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const lines = match[1].split(/\r?\n/).filter((line) => !pattern.test(line));
  return `---\n${lines.join("\n")}\n---\n\n${normalized.slice(match[0].length).replace(/^\s+/, "")}`;
}

export function sanitizePrivateSkillPackage(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let stat;
    try { stat = lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) {
      rmSync(full, { recursive: true, force: true });
      continue;
    }
    if (stat.isDirectory()) sanitizePrivateSkillPackage(full);
  }
  for (const localMeta of ["_user_meta.json", "_skillhub_meta.json"]) {
    rmSync(join(dir, localMeta), { force: true });
  }
  const skillMd = findSkillMd(dir);
  if (skillMd) {
    const raw = readFileSync(skillMd, "utf-8");
    writeFileSync(skillMd, removeFrontmatterFieldPreservingStructure(raw, "disable-model-invocation"), "utf-8");
  }
}

function versionFromDir(dir: string): string | undefined {
  for (const filename of ["skill.json", "_skillhub_meta.json", "_user_meta.json"]) {
    const path = join(dir, filename);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
    } catch { /* ignore metadata parse failures */ }
  }
  const md = findSkillMd(dir);
  if (md) {
    const { fields } = parseFrontmatter(readFileSync(md, "utf-8"));
    const raw = fields.version?.replace(/^["']|["']$/g, "").trim();
    if (raw) return raw;
  }
  return undefined;
}

function nextPatchVersion(current?: string): string {
  const value = current?.trim();
  if (!value) return "1.0.0";
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return value;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3]) + 1}`;
}

function resourceCategory(rel: string): SkillResourceCategory {
  const first = rel.split(/[\\/]/)[0]?.toLowerCase();
  if (first === "references" || first === "scripts" || first === "templates" || first === "evals") return first;
  return "other";
}

function listFiles(root: string, current = root, out: SkillResourceEntryDto[] = []): SkillResourceEntryDto[] {
  if (out.length >= 300) return out;
  for (const name of readdirSync(current).sort()) {
    if (out.length >= 300) break;
    if (name === "_user_meta.json" || name === "_skillhub_meta.json" || name === "skill.json" || name.toLowerCase() === "skill.md") continue;
    const full = join(current, name);
    let stat;
    try { stat = lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      listFiles(root, full, out);
      continue;
    }
    if (!stat.isFile()) continue;
    const rel = relative(root, full).split(sep).join("/");
    out.push({ path: rel, category: resourceCategory(rel), size: stat.size });
  }
  return out;
}

function buildSkillBody(name: string, description: string, instructions: string, positive: string[], negative: string[]): string {
  return `# ${name}\n\n## Intent\n\n${description}\n\n## Trigger\n\nUse this skill when the request clearly matches the intent above.\n${positive.length ? `\nPositive examples:\n${positive.slice(0, 2).map((x) => `- ${x}`).join("\n")}\n` : ""}\n## Boundary\n\nDo not invoke this skill for unrelated work. User instructions and safety constraints override this skill.\n${negative.length ? `\nNegative examples:\n${negative.slice(0, 2).map((x) => `- ${x}`).join("\n")}\n` : ""}\n## Workflow\n\n${instructions}\n\n## Resources\n\n- Keep stable domain knowledge in \`references/\`.\n- Keep deterministic reusable logic in \`scripts/\`.\n- Keep reusable output skeletons in \`templates/\`.\n- Load supporting resources only when needed; \`SKILL.md\` remains the runtime entry point.\n`;
}

export class SkillPackageValidator {
  validate(path: string): SkillPackageValidationDto {
    const root = resolve(path);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!existsSync(root)) {
      return { valid: false, errors: ["技能目录不存在"], warnings: [], hasReferences: false, hasScripts: false, hasTemplates: false, hasEvals: false, evalCount: 0 };
    }
    let directory = false;
    try { directory = statSync(root).isDirectory(); } catch { /* noop */ }
    if (!directory) errors.push("技能包必须是目录");
    const skillMd = directory ? findSkillMd(root) : null;
    if (!skillMd) errors.push("缺少 SKILL.md");
    if (skillMd) {
      const text = readFileSync(skillMd, "utf-8");
      if (!/^---\s*[\r\n]/.test(text)) warnings.push("SKILL.md 缺少 frontmatter");
      if (!/^name\s*:/m.test(text)) warnings.push("SKILL.md frontmatter 缺少 name");
      if (!/^description\s*:/m.test(text)) warnings.push("SKILL.md frontmatter 缺少 description");
      if (text.trim().length < 120) warnings.push("SKILL.md 内容过短，建议补充 Trigger / Boundary / Workflow");
      if (text.length > 8_000) warnings.push("SKILL.md 初始上下文偏大；建议把稳定长知识移入 references/，把确定性逻辑移入 scripts/");
    }
    const hasReferences = existsSync(join(root, "references"));
    const hasScripts = existsSync(join(root, "scripts"));
    const hasTemplates = existsSync(join(root, "templates"));
    const hasEvals = existsSync(join(root, "evals"));
    const evalCount = hasEvals ? countEvalCases(join(root, "evals")) : 0;
    if (!hasEvals || evalCount === 0) warnings.push("缺少 evals；无法验证触发与边界稳定性");
    return { valid: errors.length === 0, errors, warnings, hasReferences, hasScripts, hasTemplates, hasEvals, evalCount };
  }
}

/** Authoring/Factory layer. Runtime reaches this service only through the guarded Meta Skill native tools. */
export class SkillAuthoringService {
  private readonly validator = new SkillPackageValidator();

  validateSkillPackage(path: string): SkillPackageValidationDto {
    return this.validator.validate(path);
  }

  createSkillPackage(input: SkillAuthoringCreateRequest): AuthoredSkillPackage {
    const name = input.name.trim();
    const description = input.description.trim();
    const instructions = input.instructions.trim();
    if (!name) throw new Error("Skill 名称不能为空");
    if (!description) throw new Error("Skill 描述不能为空");
    if (!instructions) throw new Error("Skill 工作说明不能为空");
    const id = slugify(name, "skill");
    const target = join(authoringRoot("skills"), id);
    replaceDirectory(target, (stage) => {
      for (const dir of ["references", "scripts", "templates", "evals"]) ensureDir(join(stage, dir));
      const positive = (input.triggerExamples ?? []).map((x) => x.trim()).filter(Boolean);
      const negative = (input.nonTriggerExamples ?? []).map((x) => x.trim()).filter(Boolean);
      const body = buildSkillBody(name, description, instructions, positive, negative);
      writeFileSync(join(stage, "SKILL.md"), renderFrontmatter({ name: id, description: yamlString(description), version: "1.0.0" }, body), "utf-8");
      writeFileSync(join(stage, "references", "README.md"), "# References\n\nAdd stable domain references here.\n", "utf-8");
      writeFileSync(join(stage, "scripts", "README.md"), "# Scripts\n\nAdd deterministic reusable scripts here.\n", "utf-8");
      writeFileSync(join(stage, "templates", "README.md"), "# Templates\n\nAdd reusable output templates here.\n", "utf-8");
      writeFileSync(join(stage, "evals", "trigger.json"), JSON.stringify({ schemaVersion: 1, skill: id, cases: [...positive.map((prompt) => ({ prompt, expected: "trigger" })), ...negative.map((prompt) => ({ prompt, expected: "no-trigger" }))] }, null, 2), "utf-8");
      writeFileSync(join(stage, "skill.json"), JSON.stringify({ schemaVersion: 1, id, displayName: name, version: "1.0.0", createdBy: "mybuddy-skill-authoring", maturity: "draft", createdAt: Date.now() }, null, 2), "utf-8");
    });
    return { id, path: target, validation: this.validator.validate(target) };
  }

  readSkillMarkdown(path: string): string {
    const root = resolve(path);
    const skillMd = statSync(root).isDirectory() ? findSkillMd(root) : root;
    if (!skillMd || !existsSync(skillMd)) throw new Error("缺少 SKILL.md");
    return readFileSync(skillMd, "utf-8");
  }

  skillContentHash(path: string): string {
    return createHash("sha256").update(this.readSkillMarkdown(path)).digest("hex");
  }

  assertSkillContentHash(path: string, expectedHash: string): void {
    const expected = expectedHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected) || this.skillContentHash(path) !== expected) {
      throw new Error("Skill 已在改进草稿生成后发生变化，拒绝覆盖；请重新生成改进草稿");
    }
  }

  readSkillVersion(path: string): string | undefined {
    const root = resolve(path);
    const dir = statSync(root).isDirectory() ? root : resolve(join(root, ".."));
    return versionFromDir(dir);
  }

  listSkillResources(path: string): SkillResourceEntryDto[] {
    const root = resolve(path);
    const dir = statSync(root).isDirectory() ? root : resolve(join(root, ".."));
    return listFiles(dir);
  }

  readSkillEvalCases(path: string): SkillEvalDefinitionDto[] {
    const root = resolve(path);
    const dir = statSync(root).isDirectory() ? root : resolve(join(root, ".."));
    const evalsDir = join(dir, "evals");
    if (!existsSync(evalsDir)) return [];
    const out: SkillEvalDefinitionDto[] = [];
    for (const name of readdirSync(evalsDir).sort()) {
      if (!name.toLowerCase().endsWith(".json") || out.length >= 24) continue;
      const file = join(evalsDir, name);
      let stat;
      try { stat = lstatSync(file); } catch { continue; }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as { cases?: unknown[] };
        for (const raw of parsed.cases ?? []) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const item = raw as { prompt?: unknown; expected?: unknown };
          const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
          const expected = item.expected;
          if (!prompt || (expected !== "trigger" && expected !== "no-trigger")) continue;
          out.push({ prompt: prompt.slice(0, 1000), expected });
          if (out.length >= 24) break;
        }
      } catch { /* malformed eval files are ignored by execution */ }
    }
    return out;
  }

  persistEvalResult(result: SkillEvalRunResultDto): void {
    const root = authoringStateRoot("reports", result.skillId);
    writeFileSync(join(root, "latest.json"), JSON.stringify(result, null, 2), "utf-8");
  }

  readLatestEvalResult(skillId: string): SkillEvalRunResultDto | null {
    const path = join(authoringStatePath("reports", skillId), "latest.json");
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as SkillEvalRunResultDto;
      if (parsed.skillId !== skillId || parsed.evaluator !== "model-judge-v1" || !Array.isArray(parsed.cases)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  snapshotSkillPackage(skillId: string, sourceDirRaw: string, reason: "before-improve"): SkillRevisionSnapshotDto {
    const sourceDir = resolve(sourceDirRaw);
    if (!findSkillMd(sourceDir)) throw new Error("源 Skill 缺少 SKILL.md，无法创建版本快照");
    const createdAt = Date.now();
    const version = versionFromDir(sourceDir);
    const id = `${createdAt}-${createHash("sha1").update(`${skillId}:${createdAt}`).digest("hex").slice(0, 6)}`;
    const root = join(authoringStateRoot("history", skillId), id);
    ensureDir(root);
    cpSync(sourceDir, join(root, "package"), { recursive: true });
    writeFileSync(join(root, "snapshot.json"), JSON.stringify({ id, skillId, createdAt, reason, version: version ?? null }, null, 2), "utf-8");
    // Full package snapshots are intentionally bounded: keep the newest 20 per Skill.
    const historyRoot = authoringStatePath("history", skillId);
    const snapshots = readdirSync(historyRoot).map((name) => ({
      name,
      path: join(historyRoot, name),
    })).filter((item) => {
      try { return statSync(item.path).isDirectory() && existsSync(join(item.path, "snapshot.json")); } catch { return false; }
    }).sort((a, b) => b.name.localeCompare(a.name));
    for (const stale of snapshots.slice(20)) rmSync(stale.path, { recursive: true, force: true });
    return { id, createdAt, reason, version };
  }

  listSkillRevisions(skillId: string): SkillRevisionSnapshotDto[] {
    const root = authoringStatePath("history", skillId);
    const out: SkillRevisionSnapshotDto[] = [];
    if (!existsSync(root)) return out;
    for (const name of readdirSync(root)) {
      const meta = join(root, name, "snapshot.json");
      if (!existsSync(meta)) continue;
      try {
        const parsed = JSON.parse(readFileSync(meta, "utf-8")) as { id?: unknown; createdAt?: unknown; reason?: unknown; version?: unknown };
        if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "number" || parsed.reason !== "before-improve") continue;
        out.push({
          id: parsed.id,
          createdAt: parsed.createdAt,
          reason: "before-improve",
          version: typeof parsed.version === "string" ? parsed.version : undefined,
          packagePath: existsSync(join(root, name, "package")) ? join(root, name, "package") : undefined,
        });
      } catch { /* ignore malformed historical metadata */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  }

  improveSkillPackage(skillId: string, sourceDirRaw: string, input: SkillAuthoringDraft): AuthoredSkillPackage {
    const sourceDir = resolve(sourceDirRaw);
    const sourceSkillMd = findSkillMd(sourceDir);
    if (!sourceSkillMd) throw new Error("源 Skill 缺少 SKILL.md");
    const id = skillId.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Skill identity 非法，无法安全改进");
    const name = input.name.trim();
    const description = input.description.trim();
    const instructions = input.instructions.trim();
    if (!name || !description || !instructions) throw new Error("改进草稿缺少 name / description / instructions");
    const positive = input.triggerExamples.map((x) => x.trim()).filter(Boolean);
    const negative = input.nonTriggerExamples.map((x) => x.trim()).filter(Boolean);
    const currentVersion = versionFromDir(sourceDir);
    const nextVersion = nextPatchVersion(currentVersion);
    const currentSkillMarkdown = readFileSync(sourceSkillMd, "utf-8");
    const target = join(authoringRoot("skills"), id);
    replaceDirectory(target, (stage) => {
      for (const entry of readdirSync(sourceDir)) {
        if (entry === "_user_meta.json" || entry === "_skillhub_meta.json") continue;
        cpSync(join(sourceDir, entry), join(stage, entry), { recursive: true });
      }
      for (const dirName of ["references", "scripts", "templates", "evals"]) ensureDir(join(stage, dirName));
      const body = buildSkillBody(name, description, instructions, positive, negative);
      writeFileSync(
        join(stage, "SKILL.md"),
        rewriteFrontmatterPreservingUnknown(currentSkillMarkdown, { name: id, description: yamlString(description), version: nextVersion }, body),
        "utf-8",
      );
      writeFileSync(join(stage, "evals", "trigger.json"), JSON.stringify({ schemaVersion: 1, skill: id, cases: [...positive.map((prompt) => ({ prompt, expected: "trigger" })), ...negative.map((prompt) => ({ prompt, expected: "no-trigger" }))] }, null, 2), "utf-8");
      writeFileSync(join(stage, "skill.json"), JSON.stringify({ schemaVersion: 1, id, displayName: name, version: nextVersion, updatedBy: "mybuddy-skill-authoring", maturity: "draft", updatedAt: Date.now(), previousVersion: currentVersion ?? null }, null, 2), "utf-8");
    });
    return { id, path: target, validation: this.validator.validate(target) };
  }

  createExpertPackage(input: ExpertAuthoringCreateRequest, skillSourceDirs: string[]): AuthoredExpertPackage {
    const name = input.name.trim();
    const description = input.description.trim();
    const instructions = input.instructions.trim();
    if (!name) throw new Error("专家名称不能为空");
    if (!description) throw new Error("专家描述不能为空");
    if (!instructions) throw new Error("专家角色说明不能为空");
    const id = slugify(name, "expert");
    const target = join(authoringRoot("experts"), id);
    replaceDirectory(target, (stage) => {
      writeFileSync(join(stage, "prompt.md"), `---\nname: ${id}\ndescription: ${yamlString(description)}\ndisplayName: ${yamlString(name)}\nversion: 1.0.0\n---\n\n# ${name}\n\n${instructions}\n\n## Operating principles\n\n- Use bundled private skills when they match the task.\n- Do not invent facts, files, tool results, or measurements.\n- State uncertainty explicitly and separate judgement from tool execution.\n`, "utf-8");
      const skillsRoot = join(stage, "skills");
      ensureDir(skillsRoot);
      for (const sourceDirRaw of skillSourceDirs) {
        const sourceDir = resolve(sourceDirRaw);
        if (!findSkillMd(sourceDir)) continue;
        const privateDir = join(skillsRoot, slugify(basename(sourceDir), "skill"));
        cpSync(sourceDir, privateDir, { recursive: true });
        // Expert-bound Private Skills are a portable capability copy: they are independently active
        // inside the Expert and must not leak local installation metadata or package-external symlinks.
        sanitizePrivateSkillPackage(privateDir);
      }
      writeFileSync(join(stage, "expert-authoring.json"), JSON.stringify({ schemaVersion: 1, id, displayName: name, createdBy: "mybuddy-expert-authoring", privateSkillCount: skillSourceDirs.length, createdAt: Date.now() }, null, 2), "utf-8");
    });
    return { id, path: target };
  }
}
