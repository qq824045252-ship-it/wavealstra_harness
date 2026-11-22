import { z } from "zod";

export const REPLY_TABLE_FENCE = "mybuddy-table";
export const REPLY_CHART_FENCE = "mybuddy-chart";
export const REPLY_CITATION_TITLE = "mybuddy-cite: ";

const label = z.string().trim().min(1).max(120);
const unit = z.string().trim().min(1).max(32);
const number = z.number().finite().min(-1e100).max(1e100);
const tableColumn = z.discriminatedUnion("type", [
  z.object({ label, type: z.literal("text") }),
  z.object({ label, type: z.literal("number"), unit: unit.optional() }),
]);
const table = z.object({
  title: label,
  columns: z.array(tableColumn).min(2).max(8),
  rows: z.array(z.array(z.union([z.string().max(500), number, z.null()])).max(8)).min(2).max(40),
}).refine(({ columns, rows }) => rows.every(row => row.length === columns.length && row.every((cell, index) =>
  cell === null || typeof cell === (columns[index].type === "number" ? "number" : "string"))));

const chart = z.object({
  title: label,
  type: z.enum(["line", "bar"]),
  unit,
  points: z.array(z.object({ label, value: number.nullable() })).min(2).max(60),
}).refine(({ points }) => points.filter(point => point.value !== null).length >= 2);

export type ReplyTable = z.infer<typeof table>;
export type ReplyChart = z.infer<typeof chart>;
const citation = z.object({
  url: z.string().max(2048), title: z.string().trim().min(1).max(600),
  excerpt: z.string().min(8).max(240), kind: z.enum(["page", "snippet", "provided"]),
});
export type ReplyCitation = z.infer<typeof citation>;

export function replySourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value)) return;
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return url.href;
  } catch { return; }
}

export function readReplyCitations(value: unknown): ReplyCitation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap(item => {
    const parsed = citation.safeParse(item);
    const url = parsed.success ? replySourceUrl(parsed.data.url) : undefined;
    return url && parsed.success ? [{ ...parsed.data, url }] : [];
  });
}

export function parseReplyBlock(language: string, text: string) {
  if (text.length > 48_000) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (language === REPLY_TABLE_FENCE) {
      const parsed = table.safeParse(value);
      return parsed.success ? { kind: "table" as const, data: parsed.data } : undefined;
    }
    if (language !== REPLY_CHART_FENCE) return undefined;
    const parsed = chart.safeParse(value);
    return parsed.success ? { kind: "chart" as const, data: parsed.data } : undefined;
  } catch {
    return undefined;
  }
}

export const CHAT_REPLY_INSTRUCTIONS = `## 对话回复展示
最终回复先用正文说清结论，然后在相应段落插入所需内容。长回复用有意义的小节标题，操作用编号列表，检查用复选框列表。具体限制可用 > [!WARNING]，补充说明可用 > [!NOTE]。确实有流程、交互顺序或状态变化时可用小型 mermaid 围栏，支持 flowchart、sequenceDiagram 和 stateDiagram。只使用真实数据。简单对比用 Markdown，大表或用户需要文件时走文件产物。适合下列格式的表和图直接内嵌在聊天正文。
- 多行比较确实需要排序时，单独用 \`\`\`${REPLY_TABLE_FENCE} 围栏，内放 JSON，如 {"title":"调拨明细","columns":[{"label":"货架","type":"text"},{"label":"数量","type":"number","unit":"件"}],"rows":[["甲",148],["乙",57]]}。表最多 8 列、40 行，数字用 JSON 数值，单位单列定义，缺失用 null。
- 比较差异用 bar，观察等间隔趋势用 line。单独用 \`\`\`${REPLY_CHART_FENCE} 围栏，内放 JSON，如 {"title":"日调拨量","type":"line","unit":"件","points":[{"label":"周一","value":148},{"label":"周二","value":57}]}。至少两个已知值，最多 60 个点。明确缺失用 null，保留折线缺口。
- 在具体结论旁标引用，格式为 [来源](<原始URL> "${REPLY_CITATION_TITLE}来源中的一小段连续原文")。URL 和摘录须来自同一条本轮已读取的材料（网页正文、已核验引文、搜索摘要或用户明确提供的带链接摘录）。摘录用来源的原话，避免换行，推荐 15–120 字。仅当摘录确实支撑该结论才标注。普通链接仍使用普通 Markdown。`;
