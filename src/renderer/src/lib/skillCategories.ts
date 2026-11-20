/**
 * Curated skill categories use known IDs; for imports, use unambiguous cues from
 * the title/description already displayed in the Hub. Never read instructions or
 * execute a skill to classify it. This has no effect on skill permissions.
 */
const CATALOG = {
  "开发调试": [
    "apk-reverse", "architect", "benchmark-checklist", "blast-radius", "code-view", "correct",
    "create-verification-skill", "dim-feature-add", "dimagent-debug", "git-worktree-flow", "how",
    "maintain-verification-skill", "make-bot-ui", "modern-web-guidance", "no-comments",
    "reverse-engineer-anything", "root-cause-debugging", "tdd", "thermo-nuclear-code-quality-review",
    "typescript-best-practices",
  ],
  "工程设计与仿真": [
    "ansys-simulation", "easyeda-agent", "epro2kicad", "freecad", "fusion-360", "kicad-design", "solidworks",
  ],
  "科学计算与数据": ["matlab-r2025b", "origin-analysis"],
  "办公与业务": [
    "ego-price-check", "kami", "lemonclaw", "open-kimi-ppt", "pdf",
    "projectlibre-gen", "weekly-report-fill", "weekly-summary",
  ],
  "知识与写作": [
    "academic-translation", "bro", "json-canvas", "knap", "npu-ocr", "obsidian-bases",
    "obsidian-cli", "obsidian-markdown", "teach", "technical-writing", "unslop", "why",
  ],
  "媒体创作": [
    "answer-me-with-html", "archify", "blender-animation", "blender-core", "blender-geometry-nodes",
    "blender-lookdev", "blender-material", "blender-modeling", "blender-render", "blender-validation",
    "cheaper-inference-image", "drawio", "meeting-transcribe",
  ],
  "联网与协作": ["chatgpt-ask", "defuddle", "ego-browser", "herdr-gpui-browser", "rss-agent", "wechat-public", "wx-cli"],
  "自动化与工作流": [
    "arena", "automate-me", "fastcopy-copy", "figure-it-out", "find-skills", "gemini-agent-platform",
    "herdr-automations", "loop-agent", "poteto-help", "poteto-mode", "recall", "reflect", "setup-pstack",
    "shared-memory", "show-me-your-work", "swarm",
    "principle-attack-the-premise", "principle-boundary-discipline", "principle-build-the-lever",
    "principle-encode-lessons-in-structure", "principle-exhaust-the-design-space",
    "principle-experience-first", "principle-explain-the-number", "principle-fix-root-causes",
    "principle-foundational-thinking", "principle-guard-the-context-window", "principle-laziness-protocol",
    "principle-make-operations-idempotent", "principle-migrate-callers-then-delete-legacy-apis",
    "principle-minimize-reader-load", "principle-model-the-domain", "principle-never-block-on-the-human",
    "principle-outcome-oriented-execution", "principle-prove-it-works", "principle-redesign-from-first-principles",
    "principle-separate-before-serializing-shared-state", "principle-sequence-verifiable-units",
    "principle-subtract-before-you-add", "principle-test-behavior-not-implementation", "principle-type-system-discipline",
    "interrogate",
  ],
  "入门示例": ["hello-buddy"],
} as const;

type Category = keyof typeof CATALOG;
export const UNCLASSIFIED_SKILL_CATEGORY = "待归类";

const categoryById = new Map<string, Category>();
for (const category of Object.keys(CATALOG) as Category[]) {
  for (const id of CATALOG[category]) categoryById.set(id, category);
}

// Specific deliverables or domains, not generic words such as "file", "tool" or "AI".
const semanticCues: Record<Category, RegExp> = {
  "开发调试": /(?:回归测试|单元测试|代码审查|代码重构|故障排查|堆栈跟踪|\bunit tests?\b|\bcode review\b|\bstack traces?\b|\bregression tests?\b)/i,
  "工程设计与仿真": /(?:原理图|PCB 布局|机械建模|有限元|\bcircuit schematic\b|\bPCB layout\b|\bfinite element\b|\bparametric CAD\b)/i,
  "科学计算与数据": /(?:统计分析|科学计算|数据拟合|电容计算|时间序列分析|\bstatistical analysis\b|\bcurve fitting\b|\btime-series analysis\b)/i,
  "办公与业务": /(?:账单流水|收支分析|用款审批|发票管理|周报草稿|办公文档|排班表|\bslide decks?\b|\bgantt charts?\b|\binvoice processing\b|\bexpense reports?\b)/i,
  "知识与写作": /(?:学术翻译|知识库检索|知识库整理|学术润色|拼写校对|文字识别|\bknowledge base\b|\bacademic translation\b|\bspell.?checking\b|\bOCR\b)/i,
  "媒体创作": /(?:视频剪辑|图像生成|动画渲染|音频转写|\bvideo editing\b|\bimage generation\b|\banimation rendering\b|\baudio transcription\b)/i,
  "联网与协作": /(?:网页剪藏|网页提取|消息通知|邮件收发|\bslack\b|\bRSS feeds?\b|\bweb clipping\b|\bemail management\b)/i,
  "自动化与工作流": /(?:定时调度|批量重命名|自动化流程|代理编排|\bscheduled jobs?\b|\bbatch renaming\b|\bagent orchestration\b)/i,
  "入门示例": /(?:入门示例|示例技能|\bstarter example\b|\bdemo skill\b)/i,
};

export function skillCategory(skill: { id: string; name: string; description?: string }): string {
  for (const raw of [skill.id, skill.name]) {
    const id = raw.trim().toLowerCase();
    const known = categoryById.get(id);
    if (known) return known;
    // Generated procedure IDs may retain their known source followed by the recipe and hash.
    if (id.startsWith("learned-") && /-[a-f0-9]{7,32}$/.test(id)) {
      for (const [stem, category] of categoryById) {
        if (id.startsWith(`learned-${stem}-`)) return category;
      }
    }
  }
  const metadata = `${skill.name} ${skill.description ?? ""}`;
  const candidates = (Object.keys(semanticCues) as Category[]).filter((category) => semanticCues[category].test(metadata));
  return candidates.length === 1 ? candidates[0] : UNCLASSIFIED_SKILL_CATEGORY;
}
