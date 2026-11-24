import { SUBPROCESS_THINKING_LEVELS } from "../subagent-model-config";
import type { PstackRoleSettings, PstackSettings } from "./types";

export const PSTACK_EFFORTS = ["default", ...SUBPROCESS_THINKING_LEVELS];
export { MAX_PARALLEL_TASKS as PSTACK_ROLE_COUNT_MAX } from "../subagent-execution-policy";
export const pstackRoleMinimumCount = (id: string, model: string) => model === "diverse" && id !== "arena-cross-judge" ? 2 : 1;

function role(id: string, label: string, description: string, defaultModel: string, defaultCount = 1, defaultIsolation: PstackRoleSettings["isolation"] = "shared") {
  return { id, label, description, defaultModel, defaultCount, defaultIsolation };
}

export const PSTACK_ROLES = [
  role("feature", "功能与重构", "实现已选定的接口与行为契约。", "fast", 1, "auto"),
  role("bug-fix", "缺陷修复", "围绕可重现的失败修改责任边界。", "fast", 1, "auto"),
  role("perf-issue", "性能修复", "依据同一负载的前后测量实现修复。", "fast", 1, "auto"),
  role("hillclimb", "迭代实验", "一次尝试一个有证据的改动。", "fast", 1, "auto"),
  role("judgment", "判断与写作", "比较取舍，撰写受众能够使用的结论。", "strong"),
  role("hardest", "复杂实现", "处理跨层设计、并发和复杂算法。", "strong", 1, "auto"),
  role("how-explorer", "实现调查", "MyBuddy 扩展角色：定位生产入口、调用者和真实的数据流，供需要独立调查证据的开发剧本使用。", "fast"),
  role("how-explainer", "实现讲解", "亲自只读追踪入口、状态变化和消费者，给出有源码依据、可跟踪的解释。", "strong"),
  role("why-investigators", "原因调查", "MyBuddy 扩展角色：从独立线索找变化的原因及可证伪的替代解释。", "fast"),
  role("why-synthesizer", "原因综合", "MyBuddy 扩展角色：区分已证实的设计决定、推断和证据缺口。", "strong"),
  role("reflect-tooling", "复盘工具", "MyBuddy 扩展角色：寻找工具调用中的浪费、错误和可重现的教训。", "fast"),
  role("reflect-judgment", "复盘判断与综合", "MyBuddy 扩展角色：评估判断偏差、不同意见，归纳可执行的修改。", "strong"),
  role("arena-runners", "方案竞赛", "每位作者独立完成同一份简报。普通 Arena 使用所选工作区隔离策略，受控评估将每位作者的输入和产物放在各自的盲测文档空间。", "diverse", 2, "worktree"),
  role("arena-cross-judge", "候选交叉评审", "人数限定可选模型池的大小。只派一名评审者按同一标准匿名审阅全部成果。受控评估要求与所有作者家族不同；普通 Arena 要求与已观测主模型厂商不同，候选池无法满足时明确报告缺口。", "diverse", 2),
  role("swarm-workers", "并行分工", "对互不冲突的切片分别执行和回报。", "fast", 1, "auto"),
  role("architect-runners", "架构候选", "MyBuddy 扩展角色：按需独立提交接口、状态与失败边界供选择。", "diverse", 2),
  role("interrogate-reviewers", "独立评审", "按意图、行为与质量准则核实修改。", "diverse", 3),
];

const budgetEfforts: Record<string, string> = { small: "medium", medium: "high", large: "xhigh", unlimited: "max" };

export function pstackExcludedModels(settings: PstackSettings): Set<string> {
  const value = settings.skills["setup-pstack"]?.parameters.excludeModels;
  return new Set(typeof value === "string" ? value.split(/[,，\n]/).map(id => id.trim()).filter(Boolean) : []);
}

export function resolvePstackRole(settings: PstackSettings, id: string): PstackRoleSettings {
  const configured = Object.hasOwn(settings.roles, id) && settings.roles[id];
  if (!configured) throw new Error(`未知的 pstack 角色 ${id}`);
  const budget = settings.skills["setup-pstack"]?.parameters.budget;
  if (configured.effort === "default" && configured.model !== "auto" && configured.model !== "inherit-parent"
    && typeof budget === "string" && Object.hasOwn(budgetEfforts, budget)) {
    return { ...configured, effort: budgetEfforts[budget] };
  }
  return { ...configured };
}
