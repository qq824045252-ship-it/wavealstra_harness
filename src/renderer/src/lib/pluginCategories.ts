/** Presentation-only grouping: exact catalog IDs, never endpoint/description guesses. */
import { UNCLASSIFIED_SKILL_CATEGORY } from "./skillCategories";

export const ALL_PLUGIN_CATEGORIES = "全部";
const OTHER = "其他";

const MCP_CATEGORIES = {
  "设计与制图": ["drawio-ai", "opendesign", "penpot"],
  "开发与代码": ["github"],
  "通信协作": ["slack"],
  "云服务": ["cloudflare", "tencent-lighthouse"],
  "企业业务": ["wavealstra-erp", "wavealstra-erp-remote"],
} as const;

const CONNECTOR_CATEGORIES = {
  "通信协作": ["feishu"],
  "邮箱日历": ["gws"],
} as const;

function categoryFor(groups: Readonly<Record<string, readonly string[]>>, ids: readonly string[]): string {
  for (const id of ids) {
    const key = id.trim().toLowerCase();
    for (const [label, keys] of Object.entries(groups)) {
      if (keys.includes(key)) return label;
    }
  }
  return OTHER;
}

export { skillCategory } from "./skillCategories";
export const mcpCategory = (server: { name: string }): string => categoryFor(MCP_CATEGORIES, [server.name]);
export const connectorCategory = (connector: { id: string }): string => categoryFor(CONNECTOR_CATEGORIES, [connector.id]);

/** Count the search/source result set before applying the category. */
export function filterPluginCategories<T>(items: readonly T[], categoryOf: (item: T) => string, selected: string) {
  const counts = new Map<string, number>();
  const visible: T[] = [];
  for (const item of items) {
    const category = categoryOf(item);
    counts.set(category, (counts.get(category) ?? 0) + 1);
    if (selected === ALL_PLUGIN_CATEGORIES || category === selected) visible.push(item);
  }
  // Keep an active category clearable even if a new search/source has no match.
  if (selected !== ALL_PLUGIN_CATEGORIES && !counts.has(selected)) counts.set(selected, 0);
  const fallback = (label: string) => label === OTHER || label === UNCLASSIFIED_SKILL_CATEGORY;
  const categories = [...counts].sort(([left], [right]) =>
    Number(fallback(left)) - Number(fallback(right)) || left.localeCompare(right, "zh-CN"));
  return {
    visible,
    pills: [
      { id: ALL_PLUGIN_CATEGORIES, label: ALL_PLUGIN_CATEGORIES, count: items.length },
      ...categories.map(([label, count]) => ({ id: label, label, count })),
    ],
  };
}
