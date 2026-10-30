/**
 * 官方专家包 plugin.json 归一化回归测试。
 *
 * 背景：CodeBuddy 官方 plugin.json 里 author 可能是 { name } 对象、tags 元素可能是
 * { en, zh } 双语对象、分类写在 categoryId（14 分类枚举）、中文简介写在
 * displayDescription.zh。旧解析器用 String() 强转这些字段，把已安装专家的
 * author / tags 写成 "[object Object]"、category 写成空串。
 *
 * 本用例锁定修复后的归一化结果，防止回归：
 * - author: 字符串 / { name } / { zh, en } 都要拿到可读名字；
 * - tags: 取中文、去空去重；没有可用标签时不产生垃圾标签；
 * - category: categoryId 映射中文分类，老包 category 字段照旧可用；
 * - description: 优先 displayDescription.zh，缺中文才用 description。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ExpertService } from "../src/main/experts/ExpertService";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const work = mkdtempSync(join(tmpdir(), "expert-meta-"));
const expertsRoot = join(homedir(), ".mybuddy", "plugins", "experts");
const created: string[] = [];

function makePackage(
  dirName: string,
  plugin: Record<string, unknown>,
  agentName: string,
  agentFrontmatter: string,
): string {
  const dir = join(work, dirName);
  mkdirSync(join(dir, ".codebuddy-plugin"), { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, ".codebuddy-plugin", "plugin.json"), JSON.stringify(plugin, null, 2), "utf8");
  writeFileSync(join(dir, "agents", `${agentName}.md`), `---\n${agentFrontmatter}\n---\n\n# 角色正文\n`, "utf8");
  return dir;
}

function installedMeta(id: string): Record<string, unknown> | null {
  const file = join(expertsRoot, id, "expert.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

const service = new ExpertService();

try {
  /* ---------- 官方双语结构（柠檬云财税专家同构） ---------- */
  const officialDir = makePackage(
    "official-style",
    {
      name: "official-style",
      version: "1.0.1",
      description: "English only description",
      author: { name: "柠檬云" },
      displayName: { zh: "柠檬云AI财税专家", en: "Ningmengyun AI Tax Expert" },
      displayDescription: { zh: "查询财税政策，提供依据与原文链接。", en: "Research tax policies." },
      categoryId: "12-IndustryConsultant",
      tags: [
        { zh: "政策查询", en: "Policy Research" },
        { zh: "财税咨询", en: "Tax Consultation" },
        { zh: "依据溯源", en: "Source Traceability" },
      ],
    },
    "official-style",
    'name: official-style\ndescription: Research tax policies.\ndisplayName:\n  zh: "柠檬云AI财税专家"',
  );

  const dto = service.installByPath(officialDir);
  created.push(dto.id);
  const official = installedMeta(dto.id);

  assert(dto.id === "official-style", "安装 id 取自 plugin.json name");
  assert(!!official, "写入 expert.json");
  assert(official?.author === "柠檬云", "author 对象 { name } 归一化为可读名字");
  assert(official?.name === "柠檬云AI财税专家", "name 取 displayName.zh");
  assert(
    JSON.stringify(official?.tags) === JSON.stringify(["政策查询", "财税咨询", "依据溯源"]),
    "tags 双语对象取中文、按序去重",
  );
  assert(official?.category === "行业顾问", "categoryId 映射为中文分类");
  assert(official?.description === "查询财税政策，提供依据与原文链接。", "description 优先 displayDescription.zh");
  assert(!JSON.stringify(official).includes("[object Object]"), "expert.json 不含 [object Object]");
  assert(existsSync(join(expertsRoot, dto.id, "prompt.md")), "agents/*.md 归一化为 prompt.md");

  /* ---------- 兼容老包：字符串 author / 字符串 tags / category 字段 ---------- */
  const legacyDir = makePackage(
    "legacy-style",
    {
      name: "legacy-style",
      version: "0.9.0",
      description: "老包简介",
      author: "MyBuddy 社区",
      displayName: { zh: "老包专家" },
      category: "内容创作",
      tags: ["润色", "校对", "润色"],
    },
    "legacy-style",
    'name: legacy-style\ndisplayName: "老包专家"',
  );
  const legacyDto = service.installByPath(legacyDir);
  created.push(legacyDto.id);
  const legacy = installedMeta(legacyDto.id);

  assert(legacy?.author === "MyBuddy 社区", "字符串 author 原样保留");
  assert(JSON.stringify(legacy?.tags) === JSON.stringify(["润色", "校对"]), "字符串 tags 去重");
  assert(legacy?.category === "内容创作", "老包 category 字段仍生效");
  assert(legacy?.description === "老包简介", "无中文 displayDescription 时用 description");

  /* ---------- 无标签/无作者：不得编造，也不得留垃圾值 ---------- */
  const bareDir = makePackage(
    "bare-style",
    { name: "bare-style", version: "1.0.0", description: "只有简介" },
    "bare-style",
    'name: bare-style\ndisplayName: "极简专家"',
  );
  const bareDto = service.installByPath(bareDir);
  created.push(bareDto.id);
  const bare = installedMeta(bareDto.id);

  assert(bare?.tags === undefined || Array.isArray(bare?.tags), "无 tags 时结构合法");
  assert(!JSON.stringify(bare).includes("[object Object]"), "极简包同样不产生 [object Object]");
} finally {
  for (const id of created) rmSync(join(expertsRoot, id), { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
