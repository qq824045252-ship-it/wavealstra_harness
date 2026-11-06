/**
 * context-usage-categories-test.ts — 上下文用量弹窗分类占比的行为断言。
 *
 * 断言的是「用户最终在弹窗里看到的数字/文案」，不是实现细节：
 * 1) 有对话消息时「对话消息」必须 > 0%（旧实现恒为 0%）；
 *    - 消息正文在（正常会话）
 *    - 消息正文不在（历史尚未加载完 / 只有余额）：余额归「对话消息」，仍不能是 0%
 * 2) 装配检视可用时，技能目录字符要真的分给「技能」「连接器」；启用连接器时连接器不能显示 0%；
 * 3) 没有数据来源的分类（未取到装配数据 / 未取到 MCP 元工具字符数时）显示「—」，不伪装成 0%；
 *    主进程给出 inspection.mcpContext.chars 时，MCP 分类必须是真实比例（不再是「—」）；
 * 4) 各分类 token 之和 === Pi 回报的 used（误差 < 1 token），percent = tokens / window，无负数/NaN。
 *
 * 夹具数值来源：真实 app.db —— welcome_mode=working 的任务 task_runtime_context_snapshots
 * 最近一次执行的装配段：
 *   soul(db,33) | mode(user,1543) | skillCatalog(skill,356) | memoryRules(runtime,229) | workspace(runtime,44)
 * 真实上下文窗口 1,048,000 / 使用 22,597（tasks.context_used_tokens / context_window_tokens）。
 */
import {
  buildCategories,
  formatCategoryPercent,
  measureAssemblyChars,
  splitSkillCatalogChars,
  type ContextCategory,
} from "../src/renderer/src/components/chat/ContextUsageControl";
import type { ChatMessage, Skill } from "../src/renderer/src/types";
import type { AssemblyTraceDto } from "../src/shared/mode-profile";

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
function eq<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

function byKey(categories: ContextCategory[], key: string): ContextCategory {
  const found = categories.find((c) => c.key === key);
  if (!found) throw new Error(`分类缺失：${key}`);
  return found;
}

function sumTokens(categories: ContextCategory[]): number {
  return categories.reduce((n, c) => n + (c.tokens ?? 0), 0);
}

/** 只声明弹窗实际读取的字段；其余按契约补空值 */
function assembly(input: {
  segments: Array<{ id: string; source: string; chars: number }>;
  visibleSkills?: string[];
}): AssemblyTraceDto {
  return {
    welcomeMode: "working",
    segments: input.segments.map((s) => ({ ...s, title: s.id, content: "" })),
    skillFilter: {
      prefer: [],
      demote: [],
      hide: [],
      allow: [],
      visible: input.visibleSkills ?? [],
      demoted: [],
      hidden: [],
    },
    toolPolicy: { mode: "soft", prefer: [], demote: [], deny: [] },
    mcpPolicy: { mode: "soft", allow: [], deny: [] },
    mcpFilter: { enabled: [], hidden: [], reasons: {}, policyMode: "soft" },
    artifactPolicy: { allow: [], deny: [] },
    totalChars: input.segments.reduce((n, s) => n + s.chars, 0),
    warnings: [],
    effectiveAt: "new_session_only",
    appendParts: [],
  } as unknown as AssemblyTraceDto;
}

function userMessage(id: string, text: string): ChatMessage {
  return { id, role: "user", blocks: [{ type: "text", text }], createdAt: 1 };
}

/** durable 投影形态：过程块不含正文，最终回复在 finalBlocks */
function assistantMessage(id: string, finalText: string, thinking = ""): ChatMessage {
  return {
    id,
    role: "assistant",
    blocks: [
      ...(thinking ? [{ type: "thinking" as const, text: thinking }] : []),
      {
        type: "tool" as const,
        toolCall: { id: `${id}-tool`, tool: "read", summary: "a.ts", output: "x".repeat(400), status: "success" as const },
      },
    ],
    finalBlocks: [{ type: "text", text: finalText }],
    createdAt: 2,
  };
}

/** 只有正文、没有过程块的助手消息（便于手算精确比例） */
function plainAssistantMessage(id: string, finalText: string): ChatMessage {
  return {
    id,
    role: "assistant",
    blocks: [],
    finalBlocks: [{ type: "text", text: finalText }],
    createdAt: 2,
  };
}

const realAssembly = assembly({
  segments: [
    { id: "soul", source: "db", chars: 33 },
    { id: "mode", source: "user", chars: 1543 },
    { id: "skillCatalog", source: "skill", chars: 356 },
    { id: "memoryRules", source: "runtime", chars: 229 },
    { id: "workspace", source: "runtime", chars: 44 },
  ],
  visibleSkills: ["pdf-extract", "slack-send", "docx"],
});
const REAL_SYSTEM_CHARS = 33 + 1543 + 229 + 44;
const REAL_SKILL_CHARS = 356;
const realSkills: Skill[] = [
  { id: "pdf-extract", name: "pdf-extract", description: "从 PDF 提取文字", author: "", icon: "", installed: true, enabled: true, source: "manual" },
  { id: "slack-send", name: "slack-send", description: "发送 Slack 消息", author: "", icon: "", installed: true, enabled: true, source: "connector:slack" },
  { id: "docx", name: "docx", description: "生成 Word 文档", author: "", icon: "", installed: true, enabled: true, source: "manual" },
];
const realMessages: ChatMessage[] = [
  userMessage("u1", "你好"),
  assistantMessage("a1", "你好，需要我做什么？", "思考一下"),
  userMessage("u2", "整理一下这个项目的上下文用量口径"),
  assistantMessage("a2", "口径是：token 一律用 M，最多 3 位小数。".repeat(6)),
];

console.log("== 1. 有对话消息时「对话消息」必须 > 0%（旧实现恒为 0%）==");
{
  const categories = buildCategories({
    messages: realMessages,
    usedTokens: 22_597,
    windowTokens: 1_048_000,
    assembly: realAssembly,
    skills: realSkills,
  });
  const dialog = byKey(categories, "dialog");
  assert((dialog.tokens ?? 0) > 0, `对话消息 tokens > 0（实际 ${dialog.tokens}）`);
  assert(formatCategoryPercent(dialog) !== "0%", `对话消息不显示 0%（实际「${formatCategoryPercent(dialog)}」）`);
  const system = byKey(categories, "system");
  const skills = byKey(categories, "skills");
  const connectors = byKey(categories, "connectors");
  assert((system.tokens ?? 0) > 0, "系统提示词来自实测装配字符（>0）");
  // 等比缩放对各类同时生效 → 系统 : (技能+连接器) 的比例必须等于实测字符比（不依赖消息正文）
  const catalogTokens = (skills.tokens ?? 0) + (connectors.tokens ?? 0);
  assert(
    Math.abs((system.tokens ?? 0) / catalogTokens - REAL_SYSTEM_CHARS / REAL_SKILL_CHARS) < 1e-6,
    "系统 : 技能目录（技能+连接器）比例 === 装配实测字符比",
  );
  assert(Math.abs(sumTokens(categories) - 22_597) < 1e-6, `分类之和 === used（实际 ${sumTokens(categories)}）`);

  // 分类百分比合计与总百分比一致（每类各自四舍五入到一位小数，允许 0.05 × 类数 的舍入差）
  const totalPct = Math.round((22_597 / 1_048_000) * 1000) / 10;
  const sumPct = categories.reduce((n, c) => n + (c.percent ?? 0), 0);
  const visibleCount = categories.filter((c) => c.percent != null).length;
  assert(
    Math.abs(sumPct - totalPct) <= 0.05 * visibleCount + 1e-9,
    `分类百分比合计与总百分比一致（${sumPct.toFixed(1)} vs ${totalPct}）`,
  );
}

console.log("== 2. 技能 / 连接器：装配字符真的分给了两类 ==");
{
  const categories = buildCategories({
    messages: realMessages,
    usedTokens: 22_597,
    windowTokens: 1_048_000,
    assembly: realAssembly,
    skills: realSkills,
  });
  const skills = byKey(categories, "skills");
  const connectors = byKey(categories, "connectors");
  assert((skills.tokens ?? 0) > 0, `技能 tokens > 0（实际 ${skills.tokens}）`);
  assert((connectors.tokens ?? 0) > 0, `连接器 tokens > 0（实际 ${connectors.tokens}）`);
  assert(formatCategoryPercent(skills) !== "0%", `技能不显示 0%（实际「${formatCategoryPercent(skills)}」）`);
  assert(formatCategoryPercent(connectors) !== "0%", `连接器不显示 0%（实际「${formatCategoryPercent(connectors)}」）`);
  const mcp = byKey(categories, "mcp");
  eq(mcp.tokens, null, "会话里有 MCP 工具 → tokens 为 null（字符数未记录）");
  eq(formatCategoryPercent(mcp), "—", "MCP 显示「—」而不是 0%");
}

console.log("== 2b. MCP：只有「会话里确实没有 MCP 工具」才显示 0% ==");
{
  const idle = buildCategories({
    messages: realMessages,
    usedTokens: 22_597,
    windowTokens: 1_048_000,
    assembly: realAssembly,
    skills: realSkills,
    mcpServers: 0,
  });
  eq(byKey(idle, "mcp").tokens, 0, "无 MCP 工具在上下文 → 成本确定 0");
  eq(formatCategoryPercent(byKey(idle, "mcp")), "0%", "无 MCP 工具 → 显示 0%");

  const active = buildCategories({
    messages: realMessages,
    usedTokens: 22_597,
    windowTokens: 1_048_000,
    assembly: realAssembly,
    skills: realSkills,
    mcpServers: 2,
  });
  eq(formatCategoryPercent(byKey(active, "mcp")), "—", "有 MCP 工具但字符数未知 → 「—」");
}

console.log("== 2c. MCP：主进程实测元工具字符数时，MCP 分类是真实比例，不再是「—」==");
{
  // 主进程 inspectRuntimeContext 返回的 mcpContext.chars 口径（5 个元工具 ≈1088 字符，
  // 配置的服务器越多 mcp_list_tools.description 里的清单越长）。这里用 4200 字符模拟多服务器会话。
  const MCP_CHARS = 4_200;
  const measured = buildCategories({
    messages: realMessages,
    usedTokens: 22_597,
    windowTokens: 1_048_000,
    assembly: realAssembly,
    skills: realSkills,
    mcpChars: MCP_CHARS,
  });
  const mcp = byKey(measured, "mcp");
  assert((mcp.tokens ?? 0) > 0, `MCP tokens > 0（实际 ${mcp.tokens}）`);
  assert(formatCategoryPercent(mcp) !== "—", `MCP 显示实测比例，不再是「—」（实际「${formatCategoryPercent(mcp)}」）`);
  assert(formatCategoryPercent(mcp) !== "0%", `MCP 不显示 0%（实际「${formatCategoryPercent(mcp)}」）`);
  assert(Math.abs(sumTokens(measured) - 22_597) < 1e-6, `六类之和仍 === used（实际 ${sumTokens(measured)}）`);
  // 等比缩放对 MCP 同样生效 → MCP : 系统 的比例必须等于实测字符比（不依赖消息正文）
  const systemTokens = byKey(measured, "system").tokens ?? 0;
  assert(
    Math.abs((mcp.tokens ?? 0) / systemTokens - MCP_CHARS / REAL_SYSTEM_CHARS) < 1e-6,
    "MCP : 系统提示词比例 === 实测字符比（chars / 4 走同一归一）",
  );

  // 实测字符优先：即使状态快照说有 2 台服务器，字符数为 0 就是确定 0，不退化成「—」
  const zeroChars = buildCategories({
    messages: realMessages,
    usedTokens: 22_597,
    windowTokens: 1_048_000,
    assembly: realAssembly,
    skills: realSkills,
    mcpChars: 0,
    mcpServers: 2,
  });
  eq(byKey(zeroChars, "mcp").tokens, 0, "mcpChars=0 优先于服务器数 → 确定为零");
  eq(formatCategoryPercent(byKey(zeroChars, "mcp")), "0%", "mcpChars=0 → 显示 0%");
  assert(Math.abs(sumTokens(zeroChars) - 22_597) < 1e-6, `mcpChars=0 时六类之和仍 === used（实际 ${sumTokens(zeroChars)}）`);

  // 取不到字符数（旧主进程 / 任务未启动）→ 保留原降级语义
  const fallback = buildCategories({
    messages: realMessages,
    usedTokens: 22_597,
    windowTokens: 1_048_000,
    assembly: realAssembly,
    skills: realSkills,
    mcpChars: null,
    mcpServers: 2,
  });
  eq(formatCategoryPercent(byKey(fallback, "mcp")), "—", "没有 mcpChars 时仍显示「—」（降级不变）");
  eq(byKey(fallback, "mcp").tokens, null, "没有 mcpChars 且已启用服务器 → tokens = null");
}

console.log("== 3. 精确算例：按实测字符等比归一到 used（可手算核对）==");
{
  // 装配：db 段 800 字符 → 系统 200 tokens；技能目录 0；消息正文 1600 字符 → 对话 400 tokens
  // raw = 600 → scale = 4000/600；系统 1333.33 / 对话 2666.67，窗口 100000
  const categories = buildCategories({
    messages: [plainAssistantMessage("a", "a".repeat(1600))],
    usedTokens: 4000,
    windowTokens: 100_000,
    assembly: assembly({ segments: [{ id: "soul", source: "db", chars: 800 }] }),
    skills: [],
  });
  eq(byKey(categories, "system").percent, 1.3, "系统提示词 1.3%");
  eq(byKey(categories, "dialog").percent, 2.7, "对话消息 2.7%");
  eq(byKey(categories, "tools").percent, 0, "无工具调用 → 工具及子智能体 0%");
  eq(byKey(categories, "skills").percent, 0, "无技能目录 → 技能 0%");
  eq(byKey(categories, "connectors").percent, 0, "无目录 → 连接器 0%（确定为零，不是未知）");
  eq(byKey(categories, "mcp").tokens, null, "MCP 仍为未知");
  assert(Math.abs(sumTokens(categories) - 4000) < 1, "分类之和 === used（误差 < 1 token）");
}

console.log("== 4. 工具块字符进入「工具及子智能体」==");
{
  const categories = buildCategories({
    messages: [assistantMessage("a", "结论如下", "")],
    usedTokens: 500,
    windowTokens: 100_000,
    assembly: assembly({ segments: [] }),
  });
  const tools = byKey(categories, "tools");
  assert((tools.tokens ?? 0) > 0, `工具调用输出计入工具分类（实际 ${tools.tokens}）`);
  assert((byKey(categories, "dialog").tokens ?? 0) > 0, "同一消息的正文仍归对话消息");
}

console.log("== 5. 消息正文不在时：余额归「对话消息」，仍是 > 0%，不是 0% ==");
{
  // 旧 bug 现场：used 已经回报，但任务消息还没 hydrate 完 → messages = []
  const categories = buildCategories({
    messages: [],
    usedTokens: 22_597,
    windowTokens: 1_048_000,
    assembly: realAssembly,
    skills: realSkills,
  });
  const dialog = byKey(categories, "dialog");
  assert((dialog.tokens ?? 0) > 0, `空消息时对话消息仍是余额（实际 ${dialog.tokens}）`);
  assert(formatCategoryPercent(dialog) !== "0%", `空消息时不显示 0%（实际「${formatCategoryPercent(dialog)}」）`);
  assert(Math.abs(sumTokens(categories) - 22_597) < 1e-6, `分类之和 === used（实际 ${sumTokens(categories)}）`);
}

console.log("== 6. 无装配数据：技能/连接器显示「—」，系统提示词走启发式 ==");
{
  const categories = buildCategories({
    messages: realMessages,
    usedTokens: 1000,
    windowTokens: 100_000,
    assembly: null,
    skills: realSkills,
  });
  eq(formatCategoryPercent(byKey(categories, "skills")), "—", "技能没有装配字符 → 「—」");
  eq(formatCategoryPercent(byKey(categories, "connectors")), "—", "连接器没有装配字符 → 「—」");
  assert((byKey(categories, "system").tokens ?? 0) > 0, "系统提示词走启发式兜底（>0）");
  assert((byKey(categories, "dialog").tokens ?? 0) > 0, "对话消息不受装配缺失影响");
  assert(Math.abs(sumTokens(categories) - 1000) < 1e-6, `分类之和 === used（实际 ${sumTokens(categories)}）`);
}

console.log("== 7. 未知总量 / 未知窗口：全部「—」，不出现 NaN 或负数 ==");
{
  const noUsed = buildCategories({ messages: realMessages, usedTokens: null, windowTokens: 1_048_000, assembly: realAssembly, skills: realSkills });
  assert(noUsed.every((c) => c.tokens === null && c.percent === null), "used 未知 → 所有分类 tokens/percent 为 null");
  assert(noUsed.every((c) => formatCategoryPercent(c) === "—"), "used 未知 → 所有分类显示「—」");

  const zeroUsed = buildCategories({ messages: realMessages, usedTokens: 0, windowTokens: 128_000 });
  assert(zeroUsed.every((c) => formatCategoryPercent(c) === "—"), "used=0（尚未回报）→ 全部「—」，不冒充 0%");

  const zeroWindow = buildCategories({ messages: realMessages, usedTokens: 5000, windowTokens: 0 });
  assert(zeroWindow.every((c) => c.percent === null), "窗口未知 → percent 为 null，不出现 NaN/Infinity");

  for (const categories of [noUsed, zeroUsed, zeroWindow]) {
    for (const c of categories) {
      assert(c.tokens === null || (Number.isFinite(c.tokens) && c.tokens >= 0), `${c.key} tokens 非负有限`);
      assert(c.percent === null || (Number.isFinite(c.percent) && c.percent >= 0), `${c.key} percent 非负有限`);
    }
  }
}

console.log("== 8. 小额真实用量不能被四舍五入成 0% ==");
{
  // 1.048M 窗口下，300 token 的对话只占 0.029% → 一位小数会变 0.0
  const categories = buildCategories({
    messages: [userMessage("u", "b".repeat(1200))],
    usedTokens: 300,
    windowTokens: 1_048_000,
    assembly: assembly({ segments: [] }),
  });
  const dialog = byKey(categories, "dialog");
  eq(dialog.percent, 0, "percent 数值仍是 0（口径不变，一位小数）");
  eq(formatCategoryPercent(dialog), "<0.1%", "但文案显示「<0.1%」，不显示 0%");
}

console.log("== 9. 技能目录字符拆分：技能 / 连接器的边界 ==");
{
  eq(splitSkillCatalogChars(360, [], realSkills), { skills: 360, connectors: 0 }, "目录为空 → 连接器确定 0");
  eq(splitSkillCatalogChars(360, ["未知技能"], realSkills), { skills: 360, connectors: null }, "可见技能无法解析 → 连接器未知");
  const allConnector = splitSkillCatalogChars(360, ["slack-send"], realSkills);
  assert(allConnector.connectors !== null && Math.abs((allConnector.connectors ?? 0) - 360) < 1e-6, "只有连接器技能 → 目录字符全给连接器");
  const mixed = splitSkillCatalogChars(360, ["pdf-extract", "slack-send", "docx"], realSkills);
  assert((mixed.connectors ?? 0) > 0 && (mixed.connectors ?? 0) < 360, `混合目录 → 连接器按字符占比拆分（实际 ${mixed.connectors}）`);
  assert(Math.abs((mixed.skills + (mixed.connectors ?? 0)) - 360) < 1e-6, "拆分后总数守恒");
}

console.log("== 10. 装配段测量：source=skill 单独归技能目录 ==");
{
  const measured = measureAssemblyChars(realAssembly);
  eq(measured?.skillChars, REAL_SKILL_CHARS, "技能目录段字符 356");
  eq(measured?.systemChars, REAL_SYSTEM_CHARS, "其余段落归系统提示词");
  eq(measured?.visibleSkills, ["pdf-extract", "slack-send", "docx"], "透传可见技能名");
  eq(measureAssemblyChars(null), null, "无装配数据 → null");
}

console.log("== 11. 消息正文的多种真实形态都要计入对话消息 ==");
{
  const durableShape = buildCategories({
    messages: [userMessage("u", "x".repeat(400)), assistantMessage("a", "y".repeat(400))],
    usedTokens: 500,
    windowTokens: 100_000,
    assembly: assembly({ segments: [] }),
  });
  assert((byKey(durableShape, "dialog").tokens ?? 0) > 0, "durable 投影（finalBlocks 正文）计入对话消息");

  const withAttachments = buildCategories({
    messages: [
      {
        ...userMessage("u2", "看附件"),
        attachments: [{ name: "合同.pdf", path: "/tmp/合同.pdf" }],
        terminalContext: { source: "recent-output", charCount: 4000, preview: "…" },
        taskReferences: [{ title: "上一个任务", files: [{ id: "f1", name: "a.ts", source: "artifact" }] }],
        selectionLabels: ["div#app.hero"],
      },
    ],
    usedTokens: 2000,
    windowTokens: 100_000,
    assembly: assembly({ segments: [] }),
  });
  assert((byKey(withAttachments, "dialog").tokens ?? 0) > 0, "附件/终端上下文/任务引用进入对话消息");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
