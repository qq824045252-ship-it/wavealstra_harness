import type { ModelConfig, Skill, Soul, Space, Task } from "@/types";

/** 欢迎页三模式标签（产品文案，非演示数据） */
export const heroCategories = ["代码开发", "日常办公", "通用模式"];

/** 场景 chip：空列表，不再塞演示场景 */
export const heroScenes: string[] = [];

export const mockModels: ModelConfig[] = [];
export const mockSkills: Skill[] = [];
export const mockSpaces: Space[] = [];
export const mockTasks: Task[] = [];

export const mockSoul: Soul = {
  name: "MyBuddy",
  alias: "用户",
  persona: "",
};

export interface MockExpert {
  id: string;
  name: string;
  description: string;
  author: string;
  emoji: string;
  tags: string[];
}

export interface MockConnector {
  id: string;
  name: string;
  description: string;
  emoji: string;
  connected: boolean;
}

export interface MockMcpServer {
  id: string;
  name: string;
  description: string;
  emoji: string;
  enabled: boolean;
  transport: string;
}

/** 自动化模板（UI 展示 + 创建表单预填） */
export interface AutomationTemplate {
  id: string;
  title: string;
  description: string;
  prompt: string;
  emoji: string;
  scheduleType: "at" | "every" | "cron";
  scheduleExpr: string;
  periodUnit?: "day" | "week" | "month";
  periodTime?: string;
  everyUnit?: "h" | "d";
  everyN?: number;
  /** 默认任务类型；缺省 working */
  welcomeMode?: "working" | "coding" | "general";
}

export const mockExperts: MockExpert[] = [];
export const mockConnectors: MockConnector[] = [];
export const mockMcpServers: MockMcpServer[] = [];

export const automationTemplates: AutomationTemplate[] = [
  {
    id: "daily-ai-news",
    title: "每日 AI 新闻推送",
    description: "关注当天 AI 领域的重要动态，侧重 AI 产品与研究突破。",
    prompt:
      "请汇总今天 AI 领域的重要新闻与动态，侧重产品发布、模型进展与研究突破。用简洁中文分点输出，并附上可进一步阅读的线索。",
    emoji: "📰",
    scheduleType: "cron",
    scheduleExpr: "0 0 9 * * *",
    periodUnit: "day",
    periodTime: "09:00",
    welcomeMode: "working",
  },
  {
    id: "daily-en-words",
    title: "每日 5 个英语单词",
    description: "每天推荐 5 个高频实用英语单词，包含释义与例句。",
    prompt:
      "请推荐 5 个高频实用英语单词。每个单词给出音标、中文释义、1 个地道例句，以及一个便于记忆的小提示。",
    emoji: "🔤",
    scheduleType: "cron",
    scheduleExpr: "0 0 8 * * *",
    periodUnit: "day",
    periodTime: "08:00",
    welcomeMode: "working",
  },
  {
    id: "bedtime-story",
    title: "每日儿童睡前故事",
    description: "生成 3-5 分钟可读的温和睡前故事。",
    prompt:
      "请创作一个适合 3–8 岁儿童的睡前故事，温和积极、约 3–5 分钟可读完，语言轻松，结尾给人安心感。",
    emoji: "🌙",
    scheduleType: "cron",
    scheduleExpr: "0 30 20 * * *",
    periodUnit: "day",
    periodTime: "20:30",
    welcomeMode: "working",
  },
  {
    id: "weekly-report",
    title: "每周工作周报",
    description: "每周五汇总仓库 PR 与 Issue 进展，输出周报草稿。",
    prompt:
      "请基于当前工作空间，汇总本周 PR、Issue 与主要进展，输出一份结构清晰的工作周报草稿（本周完成 / 进行中 / 风险与阻塞 / 下周计划）。",
    emoji: "📋",
    scheduleType: "cron",
    scheduleExpr: "0 0 17 * * 5",
    periodUnit: "week",
    periodTime: "17:00",
    welcomeMode: "coding",
  },
  {
    id: "classic-movie",
    title: "经典电影推荐",
    description: "推荐一部高分经典电影，简要介绍剧情与看点。",
    prompt:
      "请推荐一部高分经典电影（尽量避免最近已热议的片），简要介绍剧情（无剧透结局）、看点、适合什么心情观看，并给一句观影建议。",
    emoji: "🎬",
    scheduleType: "cron",
    scheduleExpr: "0 0 20 * * 6",
    periodUnit: "week",
    periodTime: "20:00",
    welcomeMode: "working",
  },
  {
    id: "history-today",
    title: "历史上的今天",
    description: "从科技、电影、音乐等领域挑选一件「历史上的今天」趣事。",
    prompt:
      "请讲述「历史上的今天」一件有趣的事，可从科技、电影、音乐、科学发现中挑选。说明年份、事件背景与为何值得记住，语气轻松。",
    emoji: "📅",
    scheduleType: "cron",
    scheduleExpr: "0 0 10 * * *",
    periodUnit: "day",
    periodTime: "10:00",
    welcomeMode: "working",
  },
  {
    id: "daily-why",
    title: "每日一个为什么",
    description: "每天抛出一个有趣问题，先提问再解答。",
    prompt:
      "请提出一个有趣的「为什么」问题（生活、科学或人文均可），先只抛问题吊起好奇心，再给出简洁准确、通俗易懂的解答。",
    emoji: "💡",
    scheduleType: "cron",
    scheduleExpr: "0 30 9 * * *",
    periodUnit: "day",
    periodTime: "09:30",
    welcomeMode: "working",
  },
  {
    id: "call-parents",
    title: "父母联系提醒",
    description: "每周日 10:00 提醒你给家人打电话或发消息。",
    prompt:
      "提醒用户：该给父母/家人打个电话或发条消息了。用温暖简短的语气，可附 2–3 个轻松的聊天话题建议。",
    emoji: "📞",
    scheduleType: "cron",
    scheduleExpr: "0 0 10 * * 0",
    periodUnit: "week",
    periodTime: "10:00",
    welcomeMode: "working",
  },
  {
    id: "checkup-reminder",
    title: "体检预约提醒",
    description: "在指定日期提醒你确认体检安排与注意事项。",
    prompt:
      "提醒用户确认体检预约：检查时间、地点、是否需要空腹、证件与注意事项。输出一份简短 checklist。",
    emoji: "🏥",
    scheduleType: "at",
    scheduleExpr: new Date(new Date().getFullYear(), 3, 8, 7, 0, 0).toISOString(),
    welcomeMode: "working",
  },
  {
    id: "interview-prep",
    title: "面试准备提醒",
    description: "工作日每 2 小时提醒你复习大模型面试要点。",
    prompt:
      "作为面试陪练，请给出 1 个大模型/AI 工程相关面试题，附参考思路与关键要点（不要直接给冗长标准答案全文）。",
    emoji: "💬",
    scheduleType: "every",
    scheduleExpr: "2h",
    everyN: 2,
    everyUnit: "h",
    welcomeMode: "coding",
  },
  {
    id: "meeting-prep",
    title: "会议前准备",
    description: "在会议开始前提醒你整理议题、目标与待确认事项。",
    prompt:
      "提醒用户做会议前准备：整理议题、目标、需要带的材料、待确认事项，以及会后 action 预留。输出简洁 checklist。",
    emoji: "📌",
    scheduleType: "cron",
    scheduleExpr: "0 0 9 * * 1-5",
    periodUnit: "day",
    periodTime: "09:00",
    welcomeMode: "working",
  },
  {
    id: "pet-wallpaper",
    title: "可爱萌宠手机壁纸",
    description: "随机从多种风格中挑选一种，生成萌宠壁纸创意描述。",
    prompt:
      "请随机从 7 种画风（水彩、扁平插画、像素、3D 粘土、线稿、赛博霓虹、日系清新）中选一种，生成一张可爱萌宠手机壁纸的详细画面描述（竖屏 9:16），包含主体、配色、光影与构图。",
    emoji: "🐾",
    scheduleType: "cron",
    scheduleExpr: "0 0 12 * * *",
    periodUnit: "day",
    periodTime: "12:00",
    welcomeMode: "general",
  },
];

export interface WorkspaceTreeNode {
  id: string;
  name: string;
  kind: "file" | "folder";
  children?: WorkspaceTreeNode[];
}

export const mockWorkspaceTree: WorkspaceTreeNode[] = [];
