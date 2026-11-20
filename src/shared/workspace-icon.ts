export const WORKSPACE_ICON_GROUPS = [
  {
    label: "常用",
    shapes: [
      ["folder", "文件夹"], ["board", "看板"], ["archive", "档案"], ["book", "书本"],
      ["star", "星标"], ["heart", "爱心"], ["flag", "旗帜"], ["pin", "图钉"],
      ["target", "目标"], ["bookmark", "书签"], ["tag", "标签"], ["sparkles", "星光"],
    ],
  },
  {
    label: "办公",
    shapes: [
      ["briefcase", "公文包"], ["clipboard", "剪贴板"], ["calendar", "日历"], ["clock", "时钟"],
      ["document", "文档"], ["spreadsheet", "表格"], ["presentation", "演示"], ["inbox", "收件箱"],
      ["mail", "邮件"], ["checklist", "任务清单"], ["package", "包裹"], ["building", "办公楼"],
    ],
  },
  {
    label: "开发与工程",
    shapes: [
      ["code", "代码"], ["terminal", "终端"], ["git-branch", "代码分支"], ["bug", "调试"],
      ["database", "数据库"], ["server", "服务器"], ["cloud", "云服务"], ["shield", "安全"],
      ["network", "网络"], ["chip", "芯片"], ["circuit-board", "电路板"], ["gauge", "仪表"],
      ["radio", "无线电"], ["zap", "闪电"], ["cable", "线缆"], ["battery", "电池"],
      ["wrench", "扳手"], ["settings", "齿轮"], ["layers", "图层"], ["blocks", "组件"],
      ["puzzle", "拼图"], ["brain", "智能"], ["flask", "实验"], ["atom", "原子"],
    ],
  },
  {
    label: "数据与运营",
    shapes: [
      ["chart", "柱状图"], ["line-chart", "折线图"], ["pie-chart", "饼图"], ["trending", "趋势"],
      ["calculator", "计算器"], ["wallet", "钱包"], ["coins", "货币"], ["receipt", "票据"],
      ["shopping-cart", "购物车"], ["boxes", "仓储"], ["truck", "物流"], ["factory", "工厂"],
    ],
  },
  {
    label: "设计与媒体",
    shapes: [
      ["palette", "调色板"], ["brush", "画笔"], ["pen-tool", "钢笔工具"], ["image", "图片"],
      ["camera", "相机"], ["film", "影片"], ["music", "音乐"], ["mic", "麦克风"],
      ["headphones", "耳机"], ["lightbulb", "灯泡"], ["pen", "笔"], ["ruler", "直尺"],
    ],
  },
  {
    label: "团队与地点",
    shapes: [
      ["team", "团队"], ["person", "个人"], ["messages", "对话"], ["handshake", "合作"],
      ["graduation", "学习"], ["globe", "地球"], ["map-pin", "定位"], ["compass", "指南针"],
      ["map", "地图"], ["home", "家"], ["rocket", "火箭"], ["landmark", "地标"],
    ],
  },
] as const;

type WorkspaceIconOption = (typeof WORKSPACE_ICON_GROUPS)[number]["shapes"][number];
type WorkspaceIconShape = WorkspaceIconOption[0];
export const WORKSPACE_ICON_SHAPES = WORKSPACE_ICON_GROUPS.flatMap<WorkspaceIconOption>((group) => group.shapes);

const workspaceIconShapes = new Set<string>(WORKSPACE_ICON_SHAPES.map(([id]) => id));

export const WORKSPACE_ICON_COLORS = [
  "default", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink",
] as const;

export interface WorkspaceIconAppearance {
  shape: WorkspaceIconShape;
  color: (typeof WORKSPACE_ICON_COLORS)[number];
}

export const DEFAULT_WORKSPACE_ICON: WorkspaceIconAppearance = {
  shape: "folder",
  color: "default",
};

export function isWorkspaceIconAppearance(value: unknown): value is WorkspaceIconAppearance {
  if (typeof value !== "object" || value === null) return false;
  const { shape, color } = value as Partial<WorkspaceIconAppearance>;
  return typeof shape === "string" && workspaceIconShapes.has(shape)
    && WORKSPACE_ICON_COLORS.some((option) => option === color);
}
