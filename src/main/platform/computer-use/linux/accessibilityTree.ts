import type { CulAccessibilityNode } from "./culProtocol";

/**
 * AT-SPI 语义树的完整收集（分页）。
 *
 * 为什么需要分页：CUL 的 `get_app_state` 只内联返回前 ~20 个节点，并把整棵树
 * 落盘（`accessibility_tree_spill`）；`max_nodes` 实测对**内联数量无效**
 * （1000/5000/10000 都只回 12–13 个）。剩下的节点只能靠 `get_tree_page`
 * 用 `next_offset` 逐页取。实测 MyBuddy 自己的 Electron 窗口：内联 21 个节点
 * 全是匿名 Section，翻到第 2/3 页才出现 10 个 Button、1 个 Entry、1 个 ComboBox
 * —— 也就是说「不翻页」等于「看不见任何可交互控件」。
 *
 * 每页条数不是固定的（实测 20/33/31/22），按字节预算切，所以必须用服务端给的
 * `next_offset` 推进，不能拿 `offset + nodes.length` 猜。
 */

/** 一页语义树节点。 */
export interface AccessibilityPage {
  nodes: CulAccessibilityNode[];
  /** 下一页的 offset；`null`/缺失表示已经到末尾。 */
  nextOffset: number | null;
  /** 服务端报告的整棵树节点总数（可选，只用于诊断）。 */
  totalNodes?: number;
}

export interface CollectAccessibilityOptions {
  /** 额外翻页次数上限（默认 8；每页约 20–35 个节点）。 */
  maxPages?: number;
  /** 收集节点总数上限（默认 3000）。 */
  maxNodes?: number;
  /**
   * 服务端报告的整棵树节点数（CUL 的 `accessibility_tree_spill.node_count`）。
   *
   * **必须传**：实测 `accessibility_tree_truncated === false` 并不意味着树是完整的。
   * CUL 会把树 compact 到内联上限（实测固定在 ~37 个），即便还有 34 个节点没内联，
   * 它仍然报 `truncated: false`，只在 spill 里写 `node_count: 71`。只看 truncated
   * 会漏掉整页的可交互控件（实测 Nautilus 的 10 个 grid cell 全在第 2 页）。
   */
  totalNodes?: number;
  /** 取一页（由调用方接到 CUL 的 get_tree_page）。 */
  fetchPage: (offset: number) => Promise<AccessibilityPage>;
}

export interface CollectedAccessibilityTree {
  nodes: CulAccessibilityNode[];
  /** 实际取了几页（含首屏）。 */
  pages: number;
  /** 是否因页数/节点数上限而提前停止（此时树仍不完整）。 */
  truncated: boolean;
  /** 首屏 CUL 报告的整棵树节点数（有就给）。 */
  totalNodes?: number;
}

export const ACCESSIBILITY_MAX_PAGES = 8;
export const ACCESSIBILITY_MAX_NODES = 3000;

/**
 * 把首屏节点 + 后续分页拼成完整（或到上限为止）的节点数组。
 *
 * 语义：
 * - `firstNodes` 已足够（`truncated === false`）时不翻页；
 * - 每页最多取 `maxPages` 次，节点数最多 `maxNodes`；任一上限触顶 → `truncated=true`
 *   （调用方必须把它透给模型，不能让模型以为看到的是全树）；
 * - 翻页过程中出错**不吞**：单个后续页失败时保留已收集的节点并把 `truncated` 置真，
 *   由调用方决定是否报错 —— 因为「拿到一部分可交互控件」远好于「整棵树都没有」。
 */
export async function collectAccessibilityTree(
  firstNodes: readonly CulAccessibilityNode[],
  firstTruncated: boolean,
  options: CollectAccessibilityOptions,
): Promise<CollectedAccessibilityTree> {
  const maxPages = Math.max(0, options.maxPages ?? ACCESSIBILITY_MAX_PAGES);
  const maxNodes = Math.max(1, options.maxNodes ?? ACCESSIBILITY_MAX_NODES);
  const nodes: CulAccessibilityNode[] = [...firstNodes];
  let pages = 1;
  let truncated = firstTruncated;
  let totalNodes = options.totalNodes;
  // 翻页条件：首屏被截断，**或者**服务端说整棵树比内联的多（compact 上限比 truncated
  // 更早生效，只看 truncated 会漏节点）。两者都没有才认为首屏就是全树。
  const needsMore = firstTruncated || (totalNodes !== undefined && nodes.length < totalNodes);
  if (!needsMore || nodes.length >= maxNodes) return { nodes, pages, truncated };

  let offset: number | null = nodes.length;
  for (let pageIndex = 0; pageIndex < maxPages && offset != null && nodes.length < maxNodes; pageIndex += 1) {
    let page: AccessibilityPage;
    try {
      page = await options.fetchPage(offset);
    } catch {
      // 后续页失败：保留已有节点，但明确标记不完整（不假装拿到了全树）。
      truncated = true;
      break;
    }
    pages += 1;
    if (typeof page.totalNodes === "number" && Number.isFinite(page.totalNodes)) totalNodes = page.totalNodes;
    if (page.nodes.length === 0) {
      truncated = false;
      break;
    }
    nodes.push(...page.nodes.slice(0, Math.max(0, maxNodes - nodes.length)));
    offset = page.nextOffset;
    if (offset == null) {
      truncated = false;
      break;
    }
  }
  // 走到这里 offset 还有值 = 服务端说后面还有节点（页数上限或节点数上限挡住的），
  // 无论最初 truncated 报的是什么，都必须让调用方知道树不完整。
  if (offset != null) truncated = true;
  return { nodes, pages, truncated, totalNodes };
}

/** `get_tree_page` 的返回体 → 分页结构（宽松解析，字段缺失不抛）。 */
export function toAccessibilityPage(data: Record<string, unknown>): AccessibilityPage {
  const raw = Array.isArray(data.nodes) ? (data.nodes as CulAccessibilityNode[]) : [];
  const next = Number(data.next_offset);
  const total = Number(data.node_count);
  return {
    nodes: raw,
    nextOffset: Number.isFinite(next) && next > 0 ? next : null,
    totalNodes: Number.isFinite(total) && total > 0 ? total : undefined,
  };
}
