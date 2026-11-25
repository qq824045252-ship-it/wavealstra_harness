import { resolveDotsMemoryLimits, type DotsMemoryLimits } from "./dots-limits";
import { normalizeDotsGoogleRules, type DotsGoogleRules } from "./dots-google";
import { normalizeDreamSettings, normalizeRssSubscriptions, type DreamSettings, type RssSubscription } from "./dots-discovery";

/** Dots 提示词编辑器每个输入框的字符上限。 */
export const maxDotsPromptChars = 8000;
export const DOTS_DESKTOP_PREVIEW = "dots_desktop_preview";
export const DOTS_RESIDENT_READ = "dots_resident_read";
export const dotsResidentSources = ["gmail", "calendar", "rss", "dream"] as const;
export type DotsResidentSourceId = typeof dotsResidentSources[number];
export const dotsSummaryInterval = { defaultSeconds: 15, minSeconds: 1, maxSeconds: 86_400 } as const;

export const dotsPromptCategories = [
  { id: "role", label: "身份与办事范围", description: "Dots 是谁，什么时候直接答或交办。" },
  { id: "sources", label: "查资料与文件", description: "先查什么，什么时候继续找或移交。" },
  { id: "memory", label: "记忆与偏好", description: "怎么查旧事、用偏好和保存长期记忆。" },
  { id: "tasks", label: "交办与跟进", description: "怎么交办、接续原任务和定时跟进。" },
  { id: "delivery", label: "回复与交付", description: "什么时候汇报、在哪里交付成果。" },
] as const;

export type DotsPromptCategoryId = typeof dotsPromptCategories[number]["id"];
export type DotsPromptSections = Partial<Record<DotsPromptCategoryId, string>>;

export const dotsCapabilityOptions = [
  { id: "taskControl", label: "委派和接续任务", description: "新建或接续普通任务、转发答复和恢复执行。关闭后仍可暂停或停止任务。" },
  { id: "spaceManagement", label: "管理工作空间", description: "绑定目录、创建子空间和重命名空间。" },
  { id: "workspaceReading", label: "读取文件和资料", description: "浏览工作空间目录，搜索资料并读取内容。" },
  { id: "desktopPreview", label: "桌面预览", description: "根据本轮指令，在已授权工作空间启动已有的 MyBuddy 工作树预览，并核对版本和截图。" },
  { id: "residentReads", label: "常驻工具调用", description: "允许 Dots 在对话里直接使用已配置的常驻能力。后台推送按各自的设置运行。" },
  { id: "scheduling", label: "定时计划和文件订阅", description: "让 Dots 新建、修改或恢复定时计划与文件订阅。关闭后仍可查看、暂停或取消已有计划。" },
  { id: "answerRouting", label: "调度", description: "允许 Dots 按保存的流程和规则为本轮对话选择处理方式，并使用对话中的规则工具。" },
  { id: "memoryTools", label: "记忆工具", description: "允许 Dots 主动查询、保存、更正和遗忘统一记忆。" },
] as const;

export type DotsCapability = typeof dotsCapabilityOptions[number]["id"];
export const dotsOperations = {
  find_tasks: ["taskControl", "查找任务"], task: ["taskControl", "查看任务详情"], deliveries: ["taskControl", "查找任务成果"],
  execution_configs: ["taskControl", "查看可用执行配置"],
  delegate: ["taskControl", "委派普通任务"], steer: ["taskControl", "修改运行中的要求"],
  defer: ["taskControl", "记下待追加要求"],
  follow_up: ["taskControl", "追问原任务"],
  resume: ["taskControl", "恢复事项"], answer: ["taskControl", "转发对阻塞问题的回答"],
  spaces: ["spaceManagement", "列出空间"], bind: ["spaceManagement", "绑定文件夹"],
  create_space: ["spaceManagement", "创建子空间"], rename: ["spaceManagement", "重命名空间"],
  files: ["workspaceReading", "浏览目录"], read_file: ["workspaceReading", "读取文件内容"],
  materials: ["workspaceReading", "搜索资料库"], read_material: ["workspaceReading", "读取资料及历史版本"],
  [DOTS_DESKTOP_PREVIEW]: ["desktopPreview", "打开并核对桌面预览"],
  "resident.gmail": ["residentReads", "查询 Gmail 邮箱"], "resident.calendar": ["residentReads", "查询 Google 日历"],
  "resident.rss": ["residentReads", "读取 RSS 订阅"], "resident.dream": ["residentReads", "查看和运行 Dream 探索"],
  watch_file: ["scheduling", "订阅文件变化"], resume_proactive: ["scheduling", "恢复主动跟进"],
  "schedule.create": ["scheduling", "创建定时计划"], "schedule.update": ["scheduling", "修改定时计划"],
  "schedule.resume": ["scheduling", "恢复定时计划"],
  answer_rule_list: ["answerRouting", "查看回答规则"], answer_rule_test: ["answerRouting", "试用回答规则"],
  answer_rule_save: ["answerRouting", "保存回答规则"],
  memory_search: ["memoryTools", "查找记忆"], memory_get: ["memoryTools", "读取记忆"],
  memory_history: ["memoryTools", "查看记忆历史"], memory_create: ["memoryTools", "写入记忆"],
  memory_update: ["memoryTools", "更正记忆"], memory_promote: ["memoryTools", "提升记忆范围"], memory_forget: ["memoryTools", "遗忘记忆"],
} as const satisfies Record<string, readonly [DotsCapability, string]>;
export type DotsOperation = keyof typeof dotsOperations;
export interface DotsSettings extends Record<DotsCapability, boolean> {
  modelId: string | null;
  memoryMode: "readWrite" | "readOnly" | "off";
  memoryLimits: DotsMemoryLimits;
  followupMode: "continue" | "notify" | "paused";
  summaryIntervalSeconds: number;
  spaceIds: string[] | null;
  operations: Partial<Record<DotsOperation, boolean>>;
  google?: DotsGoogleRules;
  rss?: RssSubscription[];
  dream?: DreamSettings;
}

// The former task and space toggles only gated changes. Preserve read access for existing configurations.
const independentReads = new Set<string>(["find_tasks", "task", "deliveries", "spaces"]);

function dotsOperationFlag(operations: DotsSettings["operations"] | undefined, op: DotsOperation): boolean | undefined {
  const flag = operations?.[op];
  if (typeof flag === "boolean") return flag;
  if (op === "find_tasks" && operations && typeof operations === "object" && "board" in operations && typeof operations.board === "boolean")
    return operations.board;
}

export function dotsOperationEnabled(settings: Partial<DotsSettings> | undefined, key: string): boolean {
  if (!Object.hasOwn(dotsOperations, key)) return false;
  const op = key as DotsOperation;
  return (independentReads.has(key) || settings?.[dotsOperations[op][0]] !== false) && dotsOperationFlag(settings?.operations, op) !== false;
}

export function normalizeDotsSettings(value: unknown, fallback?: DotsSettings): DotsSettings & {
  google: DotsGoogleRules; rss: RssSubscription[]; dream: DreamSettings;
} {
  const input = value && typeof value === "object" ? value as Partial<DotsSettings> : {};
  const groups = Object.fromEntries(dotsCapabilityOptions.map(({ id }) =>
    [id, typeof input[id] === "boolean" ? input[id] : fallback?.[id] ?? true],
  )) as Record<DotsCapability, boolean>;
  const operations: DotsSettings["operations"] = {};
  for (const key of Object.keys(dotsOperations) as DotsOperation[]) {
    const flag = dotsOperationFlag(input.operations, key) ?? dotsOperationFlag(fallback?.operations, key);
    if (typeof flag === "boolean") operations[key] = flag;
  }
  const memoryMode = input.memoryMode ?? fallback?.memoryMode ?? "readWrite";
  const followupMode = input.followupMode ?? fallback?.followupMode ?? "continue";
  const interval = input.summaryIntervalSeconds;
  const spaces = input.spaceIds === undefined ? fallback?.spaceIds : input.spaceIds;
  return { ...groups, operations,
    google: normalizeDotsGoogleRules(input.google, fallback?.google),
    rss: normalizeRssSubscriptions(input.rss ?? fallback?.rss),
    dream: normalizeDreamSettings(input.dream ?? fallback?.dream),
    modelId: input.modelId === null ? null : typeof input.modelId === "string" ? input.modelId.trim() || null : fallback?.modelId ?? null,
    memoryMode: ["readWrite", "readOnly", "off"].includes(memoryMode) ? memoryMode : "readWrite",
    memoryLimits: resolveDotsMemoryLimits(input.memoryLimits, fallback?.memoryLimits),
    followupMode: ["continue", "notify", "paused"].includes(followupMode) ? followupMode : "continue",
    summaryIntervalSeconds: typeof interval === "number" && Number.isInteger(interval)
      && interval >= dotsSummaryInterval.minSeconds && interval <= dotsSummaryInterval.maxSeconds
      ? interval : fallback?.summaryIntervalSeconds ?? dotsSummaryInterval.defaultSeconds,
    spaceIds: spaces === undefined || spaces === null ? null : Array.isArray(spaces) ? [...new Set(spaces.filter(id => typeof id === "string" && id.trim()))] : [],
  };
}

export const resolveDotsPreferences = normalizeDotsSettings;
