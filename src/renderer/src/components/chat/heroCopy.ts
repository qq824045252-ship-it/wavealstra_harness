import type { WelcomeMode } from "@shared/agent-ipc";

export const HERO_SUBTITLE: Record<WelcomeMode, string> = {
  working: "在知识的星空里翱翔",
  coding: "对着仓库问、改、查",
  general: "通用任务，按需执行并随时接续",
};

const HERO_HEADLINE: Record<string, string> = {
  "general-office": "先写成能发出去的东西",
  "drawio-ai": "先画成一张能扫读的图",
  "bugfix-test": "先把这个 bug 钉住",
  refactor: "先改结构，行为保持不变",
  "code-review": "先把风险看清楚",
  "plan-design": "先把方案想清楚再动手",
  "readonly-explain": "先讲清楚这段代码在干什么",
};

export function heroHeadline(mode: WelcomeMode, presetId: string | null | undefined): string {
  if (presetId && HERO_HEADLINE[presetId]) return HERO_HEADLINE[presetId];
  return HERO_SUBTITLE[mode] ?? HERO_SUBTITLE.working;
}

const HERO_SUBLINE: Record<string, string> = {
  "general-office": "结论先行，做成能直接转发的成品",
  "drawio-ai": "节点少、标签人话、能扫读",
  "bugfix-test": "复现、最小改动、用测试验证",
  refactor: "小步重构，对外行为不变",
  "code-review": "正确性、架构、安全、测试充分性",
  "plan-design": "对比方案、标风险，默认不改代码",
  "readonly-explain": "讲职责、调用链和数据流",
};

export function heroSubline(mode: WelcomeMode, presetId: string | null | undefined): string {
  if (presetId && HERO_SUBLINE[presetId]) return HERO_SUBLINE[presetId];
  if (mode === "general") return "读取资料、调用工具、验证结果，接着上次的工作继续";
  return HERO_SUBTITLE[mode] ?? HERO_SUBTITLE.working;
}

const HERO_SUGGESTIONS: Record<WelcomeMode, string[]> = {
  working: [
    "把下面材料收成一页总结",
    "根据本周工作整理周报",
    "把会议记录写成纪要",
    "帮我起草一封专业邮件",
  ],
  coding: [
    "帮我看这段代码的问题",
    "给当前仓库画结构说明",
    "写一个可运行的最小示例",
    "帮我排查这个报错",
  ],
  general: [
    "帮我查清这个问题，并给出依据",
    "整理项目资料，找出下一步要做的事",
    "处理这些文件，并检查结果",
    "接着上次的任务继续完成",
  ],
};

const HERO_SUGGESTIONS_BY_PRESET: Record<string, string[]> = {
  "general-office": [
    "帮我起草一封专业、简洁的邮件",
    "把这段改得同事不用再追问",
    "先写清结论、所以呢、下一步",
    "整理成一页能交差的简报",
  ],
  "drawio-ai": [
    "根据这段描述画流程图",
    "收成一张能扫读的架构图",
    "节点少、标签用人话",
    "把流程画成可给同事看的 UML",
  ],
  "bugfix-test": [
    "帮我排查这个报错",
    "先复现，再给最小改动",
    "定位根因并补一个验证",
    "解释这个失败从哪来",
  ],
  refactor: [
    "小步重构，行为保持不变",
    "把这块结构拆干净",
    "标出风险，保持测试绿色",
    "只改结构，不改对外行为",
  ],
  "code-review": [
    "审查正确性、架构和测试",
    "标出安全与性能风险",
    "给出能落地的修改意见",
    "只评问题，不直接大改",
  ],
  "plan-design": [
    "对比两个方案并标风险",
    "先设计落地步骤，默认不改代码",
    "写成可执行的技术方案",
    "标出我还没想清楚的点",
  ],
  "readonly-explain": [
    "解释这段代码在干什么",
    "画出调用链和数据流",
    "不要改仓库，只讲清楚",
    "说明职责边界和入口",
  ],
};

export function heroSuggestions(mode: WelcomeMode, presetId: string | null | undefined): string[] {
  if (presetId && HERO_SUGGESTIONS_BY_PRESET[presetId]) {
    return HERO_SUGGESTIONS_BY_PRESET[presetId];
  }
  return HERO_SUGGESTIONS[mode] ?? HERO_SUGGESTIONS.working;
}

const HERO_PLACEHOLDER_BY_PRESET: Record<string, string> = {
  "general-office": "拖入文件，或说你想写成什么",
  "drawio-ai": "描述你想画的流程或结构",
  "bugfix-test": "贴上报错，或说哪里坏了",
  refactor: "指出要整理的代码范围",
  "code-review": "拖入或指出要审查的改动",
  "plan-design": "说说方案和约束，先不改代码",
  "readonly-explain": "指出要讲清楚的代码",
};

const HERO_PLACEHOLDER_BY_MODE: Record<WelcomeMode, string> = {
  working: "拖入文件，或输入指令",
  coding: "贴代码、报错，或说你想改什么",
  general: "描述要完成的任务，或拖入文件",
};

export function heroPlaceholder(mode: WelcomeMode, presetId: string | null | undefined): string {
  if (presetId && HERO_PLACEHOLDER_BY_PRESET[presetId]) {
    return HERO_PLACEHOLDER_BY_PRESET[presetId];
  }
  return HERO_PLACEHOLDER_BY_MODE[mode] ?? HERO_PLACEHOLDER_BY_MODE.working;
}

export function isHeroSuggestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  for (const list of Object.values(HERO_SUGGESTIONS)) {
    if (list.includes(trimmed)) return true;
  }
  for (const list of Object.values(HERO_SUGGESTIONS_BY_PRESET)) {
    if (list.includes(trimmed)) return true;
  }
  return false;
}
