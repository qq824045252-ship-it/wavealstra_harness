export const KIND_LABEL: Record<string, string> = {
  identity: "身份",
  preference: "偏好",
  fact: "事实",
  decision: "决策",
  constraint: "约束",
  risk: "风险",
  open_question: "待确认",
  progress: "进度",
  procedure: "流程",
};
export const SCOPE_LABEL: Record<string, string> = {
  global: "公共 / 全局",
  team: "团队", conversation: "本次对话", work: "事项",
  workspace: "工作空间",
  project: "项目",
  task: "任务",
  bot: "Bot 私人记忆",
};
export const STATUS_LABEL: Record<string, string> = {
  active: "有效",
  superseded: "已取代",
  resolved: "已解决",
  invalid: "无效",
};
export const OP_LABEL: Record<string, string> = {
  create: "新建",
  update: "更新",
  supersede: "取代",
  resolve: "解决",
  forget: "删除",
};
