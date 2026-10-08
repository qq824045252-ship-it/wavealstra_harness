import type { ModelMetadataDto, ModelPreferencesDto, ModelReasoningPreferenceDto } from "./model-metadata";

/** Main ↔ Renderer agent / cron / gateway IPC 契约 */

/**
 * BTW（临时上下文分支）IPC 契约。
 *
 * BTW 是独立于 Task Registry 的瞬时会话：
 * - 独立事件通道 btw:event，绝不经过 agent:event / applyAgentPatch 的任务 reducer；
 * - 主进程侧不入 SessionRegistry、不写 sessionFile / DB / memory；
 * - renderer 侧不落 Task.messages；重载/重启即消失。
 */
export const BtwIpc = {
  start: "btw:start",
  prompt: "btw:prompt",
  abort: "btw:abort",
  close: "btw:close",
  /** renderer 心跳：主进程据此回收重载后遗留的孤儿 BTW 会话 */
  keepalive: "btw:keepalive",
  event: "btw:event",
} as const;

export interface BtwStartRequest {
  /** renderer 生成的临时会话 id（btw-* 前缀；与任何 taskId 空间隔离） */
  btwId: string;
  /** 点击 BTW 时刻的主任务 id（上下文快照父级；快照后主任务变化与本会话无关） */
  parentTaskId: string;
  modelId?: string;
  reasoningPreference?: ModelReasoningPreferenceDto;
  reasoningPreferenceModelId?: string;
  welcomeMode?: WelcomeMode;
}

export interface BtwPromptRequest {
  btwId: string;
  text: string;
  /** renderer 本地生成的用户/助手消息 id（btw-u-* 与 btw-a-* 前缀，与主任务 id 空间隔离） */
  userMessageId: string;
  assistantMessageId: string;
}

export interface BtwAbortRequest {
  btwId: string;
}

export interface BtwCloseRequest {
  btwId: string;
}

export interface BtwKeepaliveRequest {
  btwIds: string[];
}

/**
 * BTW 流式补丁：与 AgentUiPatch 同构，但强制携带 btwId，且只经 btw:event 通道投递。
 * taskId 字段恒等于 btwId（隔离标识），renderer 只按 btwId 路由。
 */
export type BtwUiPatch = AgentUiPatch & { btwId: string };

/**
 * Prompt Enhance（Instruction Enhancement）IPC 契约。
 *
 * 定位：消息发送前的「指令增强器」——只增强用户即将发送给正式 Agent 的指令，
 * 绝不执行/回答/发明（Enhance，不是 Execute）。支持两个 surface：
 * - chat：任务内触发，taskId 必填；环境（Mode/Tag/Expert/Skill/workspace）
 *   由主进程从任务解析（trusted context）；
 * - new-task：草稿态触发，无 taskId；环境由主进程从 projectId/spaceId
 *   解析项目默认配置（最近项目任务 > 模板推荐 > 系统默认）。
 * 安全约束：renderer 只传 id 级信息（surface/input/taskId/projectId/spaceId/mode/tag/expertId/modelId），
 * 绝不传 Mode/Tag/Expert/Skill/workspace policy 文本——全部由主进程在 trusted context 解析。
 * - 与 BTW 完全独立：BTW 是临时岔题问答，Enhance 是就地改写未发送输入；
 * - 不产生正式消息、不入任务历史/记忆、不改变主 Agent 会话；
 * - 主进程构建受控 system instruction；renderer 不暴露任意 prompt 执行能力；
 * - 底层复用 transient in-memory 会话（createTransientSession），但业务接口独立。
 */
export const EnhanceIpc = {
  prompt: "enhance:prompt",
} as const;

/** Prompt Enhance 触发面：chat（任务内）| new-task（草稿态，无任务） */
export type EnhanceSurface = "chat" | "new-task";

export interface EnhancePromptRequest {
  /** 触发面：chat（任务内）| new-task（草稿态） */
  surface: EnhanceSurface;
  /** 用户原始输入（textarea 当前文本，未经发送） */
  input: string;
  /** chat 必填（主进程据此解析任务环境）；new-task 必须为空（草稿态无任务） */
  taskId?: string;
  /** new-task 可选：项目 id（主进程据此解析项目默认环境）；chat 由主进程从 task 解析，忽略此字段 */
  projectId?: string;
  /** new-task 可选：空间 id；chat 由主进程从 task 解析，忽略此字段 */
  spaceId?: string;
  /** new-task 可选：当前显式 Mode id（renderer 只传 id，不传政策文本；chat 忽略，以任务为准） */
  mode?: string;
  /** new-task 可选：当前显式 Tag id（同上；chat 忽略，以任务为准） */
  tag?: string;
  /** new-task 可选：当前草稿显式选中的 Expert id（renderer 只传 id；
   *  主进程校验存在/可用后注入环境，非法回退默认链；chat 忽略，以任务为准） */
  expertId?: string;
  /** 当前显式模型 id（可选；缺省走默认链） */
  modelId?: string;
}

export interface EnhancePromptResult {
  /** 增强后的提示词正文（仅正文，无解释/标题/markdown 包裹） */
  text: string;
}

export const AgentIpc = {
  prompt: "agent:prompt",
  /** 重新生成：回退到某轮用户消息并重新生成回复 */
  regenerate: "agent:regenerate",
  /** 删除用户消息：从该消息前建立新分支，确保其及后续内容不再进入上下文 */
  deleteUserMessage: "agent:deleteUserMessage",
  abort: "agent:abort",
  compact: "agent:compact",
  abortCompaction: "agent:abortCompaction",
  getCompactionStatus: "agent:getCompactionStatus",
  approveTool: "agent:approveTool",
  setPermissionMode: "agent:setPermissionMode",
  event: "agent:event",
  listModels: "agent:listModels",
  listSkills: "agent:listSkills",
  listMarketSkills: "agent:listMarketSkills",
  installSkill: "agent:installSkill",
  installSkillByPath: "agent:installSkillByPath",
  /** Authoring/Factory: create a structured Skill package, then install it disabled. */
  authorSkill: "agent:authorSkill",
  generateSkillAuthoringDraft: "agent:generateSkillAuthoringDraft",
  generateExpertAuthoringDraft: "agent:generateExpertAuthoringDraft",
  /** Trigger/Boundary semantic eval; result is a model judge, not a runtime trace. */
  runSkillEvals: "agent:runSkillEvals",
  getSkillDetail: "agent:getSkillDetail",
  /** Generate an improvement draft from current SKILL.md + eval failures; never writes files. */
  generateSkillImprovementDraft: "agent:generateSkillImprovementDraft",
  /** Apply a human-reviewed improvement draft while preserving the Skill identity. */
  applySkillImprovement: "agent:applySkillImprovement",
  /** Validate an on-disk Skill package without installing it. */
  validateSkillPackage: "agent:validateSkillPackage",
  uninstallSkill: "agent:uninstallSkill",
  /** 从市场删除技能条目（磁盘包或隐藏内置） */
  deleteMarketSkill: "agent:deleteMarketSkill",
  setSkillEnabled: "agent:setSkillEnabled",
  listExperts: "agent:listExperts",
  listMarketExperts: "agent:listMarketExperts",
  installExpert: "agent:installExpert",
  installExpertByPath: "agent:installExpertByPath",
  /** Authoring/Factory: create one Expert package with optional Private Skills. */
  authorExpert: "agent:authorExpert",
  getExpertDetail: "agent:getExpertDetail",
  updateExpert: "agent:updateExpert",
  getTaskExpertBinding: "agent:getTaskExpertBinding",
  saveTaskExpertBinding: "agent:saveTaskExpertBinding",
  cancelExpertAuthoring: "agent:cancelExpertAuthoring",
  importExpertZip: "agent:importExpertZip",
  exportExpert: "agent:exportExpert",
  uninstallExpert: "agent:uninstallExpert",
  /** Delete an expert market entry. */
  deleteMarketExpert: "agent:deleteMarketExpert",
  setExpertEnabled: "agent:setExpertEnabled",
  /** 会话中途切换/解除专家（人设热替换，下一轮生效） */
  switchExpert: "agent:switchExpert",
  /** 连接器：列表 / 安装（配套技能+注册）/ 卸载 / 删市场 */
  listConnectors: "agent:listConnectors",
  /** 只读枚举已安装专家的 Private Skills 详情（名称/描述，来自专家私有目录，不进入全局中心） */
  listExpertPrivateSkills: "agent:listExpertPrivateSkills",
  installConnector: "agent:installConnector",
  importConnectorByPath: "agent:importConnectorByPath",
  importConnectorZip: "agent:importConnectorZip",
  uninstallConnector: "agent:uninstallConnector",
  /** 启用/停用已安装连接器（停用 = 私有技能不再进入候选装配；安装不等于 active） */
  setConnectorEnabled: "agent:setConnectorEnabled",
  /** F3：任务级 Active Connector 持久化（settings.json 可扩展字段，无新 DB schema） */
  setTaskConnectorIds: "agent:setTaskConnectorIds",
  clearTaskConnectorIds: "agent:clearTaskConnectorIds",
  deleteMarketConnector: "agent:deleteMarketConnector",
  reloadModels: "agent:reloadModels",
  getModelsPath: "agent:getModelsPath",
  getModelsConfig: "agent:getModelsConfig",
  saveModelsConfig: "agent:saveModelsConfig",
  getAppSettings: "agent:getAppSettings",
  updateAppSettings: "agent:updateAppSettings",
  listBackups: "agent:listBackups",
  restoreBackup: "agent:restoreBackup",
  /** Tag/preset 被选择时通知主进程（立即触发 required-runtime prewarm，不等发送消息） */
  selectModePreset: "agent:selectModePreset",
  /** 运行时 requirement 状态（starting/ready/failed + detail；renderer 轻量展示） */
  getRuntimeRequirementStates: "agent:getRuntimeRequirementStates",
  /** 用户从运行上下文面板手动启动 / 重试某个 required runtime */
  startRuntimeRequirement: "agent:startRuntimeRequirement",
  /** 用户从运行上下文面板手动停止某个 required runtime */
  stopRuntimeRequirement: "agent:stopRuntimeRequirement",
  /** 用户从运行上下文面板手动重启某个 required runtime */
  restartRuntimeRequirement: "agent:restartRuntimeRequirement",
  /** 运行时 requirement 状态变更 push（主进程 → renderer；事件驱动替代轮询） */
  runtimeRequirementStateChanged: "agent:runtimeRequirementStateChanged",
  getContextUsage: "agent:getContextUsage",
  loadTaskHistory: "agent:loadTaskHistory",
  /** pi /login 等价：列出可登录 provider、凭证、登录/登出 */
  listLoginProviders: "agent:listLoginProviders",
  setProviderEnabled: "agent:setProviderEnabled",
  listCredentials: "agent:listCredentials",
  login: "agent:login",
  logout: "agent:logout",
  authRespond: "agent:authRespond",
  authCancel: "agent:authCancel",
  getAuthPath: "agent:getAuthPath",
  /** 登录过程事件 → renderer */
  authPrompt: "agent:authPrompt",
  authEvent: "agent:authEvent",
  /** 场景模式（日常办公/代码开发/设计创意）资料编辑 */
  listModeProfiles: "agent:listModeProfiles",
  getModeProfile: "agent:getModeProfile",
  saveModeBlock: "agent:saveModeBlock",
  saveModePolicy: "agent:saveModePolicy",
  resetModeBlock: "agent:resetModeBlock",
  resetModePolicy: "agent:resetModePolicy",
  resetModeProfile: "agent:resetModeProfile",
  openModesDir: "agent:openModesDir",
  /** 打开场景文案 md / policy.json 文件 */
  openModeFile: "agent:openModeFile",
  assembleModePreview: "agent:assembleModePreview",
  /** Read-only projection of the next authoritative Task runtime resolution. */
  inspectRuntimeContext: "agent:inspectRuntimeContext",
  listAgentLoadoutObservations: "agent:listAgentLoadoutObservations",
  listRuntimeContextSnapshots: "agent:listRuntimeContextSnapshots",
  clearRuntimeContextSnapshots: "agent:clearRuntimeContextSnapshots",
  clearRuntimeAudit: "agent:clearRuntimeAudit",
  getDiskSpace: "agent:getDiskSpace",
  /** 用户导入字体 ~/.mybuddy/fonts/ */
  listUserFonts: "agent:listUserFonts",
  /** 枚举操作系统已安装字体 family（Windows 使用 InstalledFontCollection）。 */
  listSystemFonts: "agent:listSystemFonts",
  importUserFont: "agent:importUserFont",
  removeUserFont: "agent:removeUserFont",
  readUserFont: "agent:readUserFont",
  openFontsDir: "agent:openFontsDir",
  /** 内建 WebAccess Capability 搜索配置 */
  getWebSearchConfig: "agent:getWebSearchConfig",
  saveWebSearchConfig: "agent:saveWebSearchConfig",
  /** 搜索 Provider 各 key 的用量（Tavily usage 接口） */
  getSearchProviderUsage: "agent:getSearchProviderUsage",
  /** MyBuddy 原生工具能力（非用户插件） */
  getBuiltinCapabilities: "agent:getBuiltinCapabilities",
  saveBuiltinCapabilities: "agent:saveBuiltinCapabilities",
  saveBuiltinCredential: "agent:saveBuiltinCredential",
  testBuiltinCapability: "agent:testBuiltinCapability",
  /** 内建 Subagent Capability 配置 */
  getSubagentConfig: "agent:getSubagentConfig",
  saveSubagentConfig: "agent:saveSubagentConfig",
} as const;

export type {
  BuiltinCapabilitiesConfigDto,
  BuiltinCapabilitiesSnapshotDto,
  BuiltinCapabilityId,
  BuiltinCapabilityStatusDto,
  SaveBuiltinCredentialRequest,
  TestBuiltinCapabilityResultDto,
} from "./builtin-capabilities";

export const CronIpc = {
  list: "cron:list",
  upsert: "cron:upsert",
  setEnabled: "cron:setEnabled",
  remove: "cron:remove",
  runNow: "cron:runNow",
  runs: "cron:runs",
  event: "cron:event",
} as const;

export const GatewayIpc = {
  status: "gateway:status",
  connect: "gateway:connect",
  disconnect: "gateway:disconnect",
  listChannels: "gateway:listChannels",
  getChannelConfig: "gateway:getChannelConfig",
  listMessages: "gateway:listMessages",
  event: "gateway:event",
} as const;

/** 浏览器 / HTML 产物预览共享控制台通道。target 仅允许 browser | artifact。 */
export const RuntimeConsoleIpc = {
  snapshot: "runtimeConsole:snapshot",
  clear: "runtimeConsole:clear",
  event: "runtimeConsole:event",
} as const;

/**
 * 扩展栏浏览器宿主（WebContentsView，可加载任意 http(s) URL）。
 * 与产物预览 ArtifactIpc 分离：产物走 mybuddy-artifact 协议；本通道用于 Penpot 等外链。
 */
export const BrowserIpc = {
  open: "browser:open",
  navigate: "browser:navigate",
  reload: "browser:reload",
  hardReload: "browser:hardReload",
  back: "browser:back",
  forward: "browser:forward",
  openExternal: "browser:openExternal",
  setRect: "browser:setRect",
  hide: "browser:hide",
  show: "browser:show",
  addBlocker: "browser:addBlocker",
  removeBlocker: "browser:removeBlocker",
  /** main → renderer：导航后当前 URL */
  urlChanged: "browser:urlChanged",
  /**
   * main → renderer：专业工具请求在扩展栏打开 URL（如 Penpot prepare/open）。
   * payload: { url: string }
   */
  openRequest: "browser:openRequest",
} as const;

/**
 * Subagent 面板通道。
 * 主进程启动即注册稳定 handler（扩展未加载时返回空列表 / ended）；
 * 扩展加载后经宿主 backend 槽接管实现，不再二次 ipcMain.handle。
 * DTO 形状由内建 Subagent Capability 实现；此处锁定 Main/Renderer 通道契约。
 */
export const SubagentIpc = {
  /** 当前父 Task 的 active 实例 */
  active: "subagent:active",
  /** 运行中实例的实时 transcript（scope 校验；已结束 → ended:true） */
  transcript: "subagent:transcript",
  steer: "subagent:steer",
  cancel: "subagent:cancel",
  /** main → renderer：active 实例变化（临时 Chat 订阅刷新） */
  event: "subagent:event",
} as const;

/** 渲染层 Subagent 列表项（与扩展 toSummaryDto 输出结构一致） */
export interface SubagentSummaryDto {
  subagentId: string;
  role: string;
  roleSource: "user" | "project" | "unknown";
  roleDescription: string;
  project: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastPromptAt?: number;
  lastResultAt?: number;
  runCount: number;
  steerCount: number;
  pendingSteers: Array<{ text: string; queuedAt: number }>;
  lastResult?: {
    status: string;
    errorMessage?: string;
    finalText?: string;
    stopReason?: string;
  };
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  };
  sessionId?: string;
  pid?: number;
  model?: string;
  lastTask?: string;
  depth: number;
  workerAlive: boolean;
  /** 最终生效模型/思考（三级优先级解析）+ 来源 + 子进程实证值 */
  resolvedModel?: string;
  resolvedThinking?: string;
  modelSource?: "role" | "default" | "global";
  thinkingSource?: "transport";
  actualModel?: string;
  actualThinking?: string;
}

/** transcript 条目（扩展写入的 JSONL 事件：message_end / steer / meta / tool_end） */
export interface SubagentTranscriptEntry {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export interface SubagentTranscriptDto {
  record: SubagentSummaryDto | null;
  entries: SubagentTranscriptEntry[];
  /** true = 实例已结束/不属于当前任务（临时 Chat 应关闭或提示） */
  ended: boolean;
}

export interface SubagentSteerResultDto {
  ok: boolean;
  delivered: "rpc-steer" | "prompt" | "queued" | "spawned";
  message: string;
}

/**
 * HTML 产物预览宿主（WebContentsView 承载，内容经 mybuddy-artifact:// 协议投递）。
 * renderer 的显示意图统一经 NativeSurfaceCoordinator（V3.5 §75）：
 * preview/close 走本通道（Coordinator 内部管理 generation/blocker），
 * setRect/hide/show 已删除，改走 ArtifactSurfaceIpc（Wave 4A 后业务组件直接调用归零）。
 */
export const ArtifactIpc = {
  /** renderer → main：加载 HTML 产物（内容由主进程按 artifactId 从 Artifact Domain 解析） */
  preview: "artifact:preview",
  /** renderer → main：重新加载当前产物（纯导航动作，§102 host 职责） */
  reload: "artifact:reload",
  /** renderer → main：硬刷新当前产物（忽略缓存，Ctrl+F5 等价） */
  hardReload: "artifact:hardReload",
  /** renderer → main：在系统默认浏览器打开当前 HTML 产物（按 artifact id 安全解析本地入口） */
  openInBrowser: "artifact:openInBrowser",
  /** renderer → main：关闭并隐藏（切换产物 / 关闭面板时调用） */
  close: "artifact:close",
} as const;

/**
 * Native Surface 显示决策通道（V3.5 Wave 4A §75-77）：
 * renderer 业务组件只允许通过这四个动作表达 intent；
 * setBounds/setVisible 仅 Coordinator → PreviewHost 一条链。
 */
export const ArtifactSurfaceIpc = {
  /** renderer → main：上报宿主区域（DIP），Coordinator 记录 bounds 并合成可见性 */
  requestBounds: "artifactSurface:requestBounds",
  /** renderer → main：显式显示意图（挂载/展开 true；面板关闭走 close） */
  requestVisible: "artifactSurface:requestVisible",
  /** renderer → main：登记隐藏 blocker（token 集合，幂等） */
  addBlocker: "artifactSurface:addBlocker",
  /** renderer → main：移除自己的 blocker token */
  removeBlocker: "artifactSurface:removeBlocker",
} as const;

export interface ArtifactSurfaceRequest {
  surfaceId: string;
}

export interface ArtifactSurfaceBoundsRequest extends ArtifactSurfaceRequest {
  rect: { x: number; y: number; width: number; height: number };
}

export interface ArtifactSurfaceVisibleRequest extends ArtifactSurfaceRequest {
  visible: boolean;
}

export interface ArtifactSurfaceBlockerRequest extends ArtifactSurfaceRequest {
  token: string;
}

export interface ArtifactPreviewRequest {
  /** artifact.id，编码后作为 mybuddy-artifact:// 协议 pathname 第一段 */
  id: string;
}

export const McpIpc = {
  discover: "mcp:discover",
  listServers: "mcp:listServers",
  install: "mcp:install",
  /** 安装 extensions/mcp 捆绑（serena / codegraph，含 modes:coding） */
  installBundled: "mcp:installBundled",
  remove: "mcp:remove",
  setServerEnabled: "mcp:setServerEnabled",
  readAppConfig: "mcp:readAppConfig",
  writeAppConfig: "mcp:writeAppConfig",
  readServerConfig: "mcp:readServerConfig",
  saveServerConfig: "mcp:saveServerConfig",
  serverTools: "mcp:serverTools",
  /* -------- 运行时（Pi 原生 MCP 集成） -------- */
  status: "mcp:status",
  connect: "mcp:connect",
  authStart: "mcp:authStart",
  authComplete: "mcp:authComplete",
  logout: "mcp:logout",
  hasCredentials: "mcp:hasCredentials",
  uiRespond: "mcp:uiRespond",
  uiCancel: "mcp:uiCancel",
  /* 主进程 → 渲染层推送 */
  statusEvent: "mcp:statusEvent",
  notify: "mcp:notify",
  uiPrompt: "mcp:uiPrompt",
} as const;

export const DbIpc = {
  listExecutionFailures: "db:listExecutionFailures",
  dismissExecutionFailure: "db:dismissExecutionFailure",
  previewProjectFolder: "db:previewProjectFolder",
  commitProjectFolder: "db:commitProjectFolder",
  listSpaces: "db:listSpaces",
  listTasks: "db:listTasks",
  listProjects: "db:listProjects",
  getProject: "db:getProject",
  createProject: "db:createProject",
  updateProject: "db:updateProject",
  duplicateProject: "db:duplicateProject",
  archiveProject: "db:archiveProject",
  deleteProject: "db:deleteProject",
  createProjectResource: "db:createProjectResource",
  updateProjectResource: "db:updateProjectResource",
  deleteProjectResource: "db:deleteProjectResource",
  inspectProjectResources: "db:inspectProjectResources",
  listProjectPosts: "db:listProjectPosts",
  createProjectPost: "db:createProjectPost",
  deleteProjectPost: "db:deleteProjectPost",
  listProjectTodos: "db:listProjectTodos",
  createProjectTodo: "db:createProjectTodo",
  updateProjectTodo: "db:updateProjectTodo",
  deleteProjectTodo: "db:deleteProjectTodo",
  listProjectMemory: "db:listProjectMemory",
  createProjectMemory: "db:createProjectMemory",
  updateProjectMemory: "db:updateProjectMemory",
  deleteProjectMemory: "db:deleteProjectMemory",
  pinProjectItem: "db:pinProjectItem",
  unpinProjectItem: "db:unpinProjectItem",
  listProjectPins: "db:listProjectPins",
  getProjectStatus: "db:getProjectStatus",
  recordProjectReview: "db:recordProjectReview",
  getProjectActions: "db:getProjectActions",
  projectTaskChanged: "db:projectTaskChanged",
  getProjectAttention: "db:getProjectAttention",
  acknowledgeProjectAttention: "db:acknowledgeProjectAttention",
  projectAttentionChanged: "db:projectAttentionChanged",
  listProjectEvents: "db:listProjectEvents",
  projectEventsChanged: "db:projectEventsChanged",
  promoteProjectEvent: "db:promoteProjectEvent",
  ingestProjectDocument: "db:ingestProjectDocument",
  importProjectFile: "db:importProjectFile",
  pickImportFile: "db:pickImportFile",
  dismissProjectEvent: "db:dismissProjectEvent",
  reopenProjectEvent: "db:reopenProjectEvent",
  upsertSpace: "db:upsertSpace",
  renameSpace: "db:renameSpace",
  upsertTask: "db:upsertTask",
  deleteTask: "db:deleteTask",
  deleteSpace: "db:deleteSpace",
  archiveSpace: "db:archiveSpace",
  archiveTask: "db:archiveTask",
  // Phase 2 Tree V2：同父混排重排与重挂（strict targetIndex 契约，不发明第二套排序）
  moveSpace: "db:moveSpace",
  moveTaskInWorkspaceTree: "db:moveTaskInWorkspaceTree",
  getSoul: "db:getSoul",
  updateSoul: "db:updateSoul",
  memoryChanged: "db:memoryChanged",
  listTaskWriteGrants: "db:listTaskWriteGrants",
  deleteTaskWriteGrant: "db:deleteTaskWriteGrant",
  getSemanticIndexStats: "db:getSemanticIndexStats",
  getSemanticModelStatus: "db:getSemanticModelStatus",
} as const;

export const WorkspaceIpc = {
  getView: "workspace:getSharedContextView",
  promote: "workspace:promoteSharedContextItem",
} as const;

export type WelcomeMode = import("./mode-profile").WelcomeMode;
export type PermissionMode = "default" | "readonly" | "auto";

export type {
  AssemblyTraceDto,
  ModeArtifactPolicy,
  ModeBlockId,
  ModeBlockDto,
  ModeMcpPolicy,
  ModePolicyDto,
  ModePresetDto,
  ModeProfileDto,
  ModeProfileSummaryDto,
  ModeSceneChip,
  ModeSkillPolicy,
  ModeToolPolicy,
} from "./mode-profile";
export type { ResolvedCapabilityDto } from "./runtime-policy";

/** Tag/preset 被选择时通知主进程（触发 required-runtime prewarm）。 */
export interface AgentSelectModePresetRequest {
  welcomeMode: WelcomeMode;
  modePresetId: string | null;
}

/** 运行时 requirement 状态（renderer 轻量展示：启动中 / 等待后端 / 已就绪 / 启动失败 + detail）。 */
export interface RuntimeRequirementStateDto {
  providerId: string;
  phase: "idle" | "starting" | "waiting-backend" | "ready" | "failed";
  /** 解析后的启动策略（gui/backend/none；UI 展示与语义提示） */
  launch: "gui" | "backend" | "none";
  detail: string | null;
  lastReadyAt: number | null;
  lastAttemptAt: number | null;
  /** 声明了该 runtime 的 preset/Tag id（供面板高亮「当前所需」） */
  requiredBy?: string[];
}

export interface AssembleModePreviewRequest {
  welcomeMode: WelcomeMode;
  expertId?: string | null;
  permissionMode?: PermissionMode;
  spaceId?: string | null;
  /** Optional Project to include in an assembly preview. */
  projectId?: string | null;
  /** 选中场景预设（Design Mode）；缺省 = base policy 预览 */
  modePresetId?: string | null;
  /** 预览当前激活的连接器 id（其 Private Skills 进入候选技能集，与真实 Session 一致） */
  connectorIds?: string[];
  /** 项目根 cwd（与 createSession 同源；缺省 = process.cwd()） */
  cwd?: string;
  /** 预览/重装配会话是否具备 library_* 工具（BTW 重装配传 false，文案不提示不存在的工具） */
  libraryToolsAvailable?: boolean;
  /** 预览对应任务（与 createSession taskId 同源；用于 Task + Space 联合分层，避免 taskId=null 导致预览与真实执行差异） */
  taskId?: string | null;
}

export type ArtifactKind =
  | "markdown"
  | "code"
  | "html"
  | "svg"
  | "image"
  | "video"
  | "audio"
  | "table"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "cad";

export interface WorkspaceFileNodeDto {
  name: string;
  path: string;
  kind: "file" | "folder";
  children?: WorkspaceFileNodeDto[];
}

export type WorkspaceMutationResult =
  | { ok: true; relativePath: string }
  | { ok: false; error: string };

/** 把文件/文件夹复制进目标任务工作区 */
export type WorkspaceCopyIntoTaskResult =
  | {
      ok: true;
      destRoot: string;
      items: Array<{ source: string; relativePath: string; alreadyThere: boolean }>;
    }
  | { ok: false; error: string };

export interface WorkspaceFilePreviewDto {
  path: string;
  name: string;
  kind: ArtifactKind;
  content: string;
  language?: string;
}

export interface AgentPromptRequest {
  taskId: string;
  text: string;
  modelId?: string;
  /** Native per-model reasoning preference shared by Settings and Chat. */
  reasoningPreference?: ModelReasoningPreferenceDto;
  /** Guard against applying a preference to a different model after policy/model resolution. */
  reasoningPreferenceModelId?: string;
  /**
   * 显式权限（用户/任务已选）。缺省时主进程按 Tag/Preset 建议 → Mode/base 建议 → 系统默认解析。
   * 显式值永远优先，不被建议覆盖。
   */
  permissionMode?: PermissionMode;
  welcomeMode?: WelcomeMode;
  spaceId?: string;
  /**
   * @deprecated P0 任务目录隔离：执行目录由主进程按 taskId 解析（canonical task root），
   * 主进程忽略本字段。保留仅为兼容旧调用方，确认清理后删除。
   */
  cwd?: string;
  assistantMessageId: string;
  userMessageId: string;
  /** 跨端消息同步用的用户可见正文；缺省回退到 text。 */
  displayText?: string;
  /**
   * 是否广播 user_message patch。默认 true；重新生成等“复用原用户消息”路径显式设 false。
   */
  announceUserMessage?: boolean;
  /**
   * 会话仍在生成时的投递语义。steer 会在当前工具批次结束后接受用户引导，
   * followUp 会等当前完整执行自然结束后才开始准备新请求（包括模型/权限变更）。
   * 无在途执行且会话空闲时按普通 prompt 处理。
   */
  streamingBehavior?: "steer" | "followUp";
  /** 用户拖入/选择的本地文件路径，主进程拼进 prompt 上下文 */
  attachments?: Array<{ name: string; path: string }>;
  /**
   * 用户明确「加入聊天」的抓取元素引用（Capture Mode Selection）：
   * 主进程发送时逐个经 PromptContextService 解析为结构化上下文；
   * 页面更新/删除导致引用失效时不注入。数组允许同一条消息引用多个元素。
   */
  selections?: import("./selection").ChatSelectionRef[];
  /** @deprecated 兼容旧 renderer；新调用方使用 selections。 */
  selection?: import("./selection").ChatSelectionRef;
  /**
   * 用户显式「终端 → 加入对话」的上下文（文本已在 renderer 限长；
   * 主进程以 untrusted 标注注入，不进入 Agent timeline / 不自动收集）。
   */
  terminalContext?: import("./terminal-ipc").TerminalContextDto;
  /** 已有会话文件，重启后继续同一 jsonl */
  sessionFile?: string;
  /** Expert selected for this session. */
  expertId?: string;
  /** 选中场景预设（Design Mode）；仅在新建会话时生效，已有会话不热切 */
  modePresetId?: string | null;
  /** 当前会话激活的连接器 id（其 Private Skills 进入候选技能集；新建会话时生效） */
  connectorIds?: string[];
}

export interface AgentPromptResult {
  /** true 表示消息只完成入队，Agent 仍在执行；不是 assistant 完成信号。 */
  queued: boolean;
  /**
   * 主进程拒绝/降级时的明确原因（正常完成或入队时缺省）。
   * 用于把「会话仍在生成但未指定 streamingBehavior」等意图性错误暴露给 renderer，
   * 避免静默吞掉或伪装成成功。
   */
  error?: { code: string; message: string };
}

export interface AgentApproveToolRequest {
  taskId: string;
  toolCallId: string;
  approved: boolean;
  /** 外部写授权决策（tool_start 带 approvalKind=external-write 时使用） */
  externalWrite?: import("./external-write").ExternalWriteApprovalChoice;
}

export interface AgentRegenerateRequest {
  taskId: string;
  /** 渲染层生成的去重/归属 id，贯穿 IPC 与 pending 生命周期（跨 Task 切换仍能定位）。 */
  requestId: string;
  /**
   * 要重新生成的用户消息在会话中的序号（0-based，按用户消息顺序）。
   * 未提供 sourceUserEntryId 时，主进程按当前 Pi 可见分支的 UI 序号定位。
   */
  userMessageIndex: number;
  /** 重新生成后新的助手消息 id（渲染层本地生成，streaming 事件回填） */
  assistantMessageId: string;
  /**
   * 目标用户消息的原文指纹（规范化 hash）。主进程定位到目标后比对，
   * 不一致说明目标已漂移（消息被删/被改），返回 TARGET_DRIFTED，绝不导航到错误位置。
   */
  expectedUserTextHash?: string;
  /** 被重新生成的源助手消息 id（渲染层 commit 时按此重新定位，不依赖跨异步的旧 index）。 */
  sourceAssistantMessageId: string;
  /** 被重新生成的源用户消息 id（drift 校验的稳定锚点之一）。 */
  sourceUserMessageId: string;
  /** Stable Pi entry ID; a supplied invalid ID must not fall back to an index. */
  sourceUserEntryId?: string;
  modelId?: string;
  reasoningPreference?: ModelReasoningPreferenceDto;
  reasoningPreferenceModelId?: string;
  /** 显式权限（用户/任务已选）；缺省时主进程保留既有解析（Tag/显式链） */
  permissionMode?: PermissionMode;
  welcomeMode?: WelcomeMode;
  spaceId?: string;
  /** 任务级 Active 连接器（重建会话时回传，其 Private Skills 重新进入候选装配） */
  connectorIds?: string[];
  /**
   * @deprecated P0 任务目录隔离：执行目录由主进程按 taskId 解析（canonical task root），
   * 主进程忽略本字段。保留仅为兼容旧调用方，确认清理后删除。
   */
  cwd?: string;
  expertId?: string;
  /** 选中场景预设（Design Mode）；仅新建会话时生效 */
  modePresetId?: string | null;
}

export type AgentRegenerateResult =
  | {
      ok: true;
      requestId: string;
      assistantMessageId: string;
      sessionFile?: string;
      /** Pi creates a new user node on regeneration; refresh the retained UI bubble. */
      userEntryId?: string;
    }
  | {
      ok: false;
      requestId: string;
      code:
        | "TASK_NOT_FOUND"
        | "SESSION_NOT_FOUND"
        | "TARGET_NOT_FOUND"
        | "TARGET_DRIFTED"
        | "SESSION_BUSY"
        | "NAVIGATION_CANCELLED"
        | "NO_EDITABLE_CONTENT"
        | "PROMPT_FAILED";
      message: string;
    };

export interface AgentDeleteUserMessageRequest {
  taskId: string;
  /** Visible current-path user index; never an index over hidden/abandoned history. */
  userMessageIndex: number;
  /** Stable Pi anchor when available; a stale ID must be rejected. */
  entryId?: string;
}

export interface AgentSetPermissionModeRequest {
  taskId: string;
  permissionMode: PermissionMode;
}

export interface CapabilityPolicyNoticeDto {
  /**
   * Lightweight chat feedback is intentionally limited to capabilities the
   * user or current Tag explicitly requested. Background Skill/MCP filtering
   * is explained by Runtime Context Inspector instead of producing banners.
   */
  kind: "expert" | "connector" | "mcp";
  id: string;
  reason: string;
  source?: import("./runtime-policy").CapabilityPolicySource;
  sourceId?: string;
}

export interface RuntimeContextInspectionDto {
  taskId: string;
  generatedAt: number;
  /** This is a live projection, not an immutable historical execution record. */
  basis: "current_configuration";
  effectiveAt: "next_resolution";
  mode: { id: WelcomeMode; label: string };
  project?: {
    id: string;
    name: string;
    updatedAt: number;
    archived: boolean;
  };
  tag?: { id: string; label: string };
  instructions: import("./mode-profile").AssemblySegmentDto[];
  capabilities: import("./runtime-policy").ResolvedCapabilityDto[];
  warnings: string[];
  assembly: import("./mode-profile").AssemblyTraceDto;
  assemblyHash: string;
  loadout: import("./agent-loadout").AgentLoadoutRecommendationDto;
  latestExecution?: {
    executionId: string;
    status: RuntimeContextSnapshotDto["status"];
    assemblyHash: string;
    differsFromCurrent: boolean;
    changes: string[];
  };
}

export interface RuntimeContextSnapshotDto {
  /** Absent on historical records created before tool material auditing. */
  materialUsage?: { items: RuntimeMaterialUseDto[]; omitted: number };
  /** Main-process execution cwd, absent for older audit records. */
  workingDirectory?: string;
  id: string;
  executionId: string;
  taskId: string;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: number;
  schemaVersion: number;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: number;
  completedAt?: number;
  error?: string;
  assemblyHash: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  mode: WelcomeMode;
  tagId?: string;
  projectId?: string;
  projectUpdatedAt?: number;
  resolvedInstructions: RuntimeAuditInstructionDto[];
  resolvedCapabilities: import("./runtime-policy").ResolvedCapabilityDto[];
  warnings: string[];
  storageBytes: number;
}

/** Evidence of tool output returned, not a claim that the model understood or used it. */
export interface RuntimeMaterialUseDto {
  toolCallId: string;
  toolName: string;
  at: number;
  kind: "file-content" | "knowledge-content" | "search-snippet" | "metadata";
  target: string;
  title: string;
  outputHash: string;
  returnedChars: number;
  images: number;
  partial: boolean;
  offset?: number;
  limit?: number;
}

export type RuntimeAuditInstructionDto = import("./mode-profile").AssemblySegmentDto & {
  contentHash: string;
  storage: "full" | "excerpt";
  storedChars: number;
};

export type AgentUiPatch =
  | { type: "durable_snapshot"; taskId: string; snapshot: import("./durable-bot").DurableBotSnapshot }
  | { type: "expert_binding"; taskId: string; binding: import("./expert-binding").TaskExpertBindingDto }
  | { type: "compaction_status"; taskId: string; state: import("./compaction").TaskCompactionStatusDto }
  | {
      type: "user_message";
      taskId: string;
      messageId: string;
      text: string;
      createdAt: number;
    }
  | {
      type: "generation_stats";
      taskId: string;
      messageId: string;
      stats: import("./generation-stats").GenerationStats;
    }
  | {
      type: "capability_notices";
      taskId: string;
      notices: CapabilityPolicyNoticeDto[];
    }
  | {
      type: "assistant_start";
      taskId: string;
      messageId: string;
      executionId?: string;
      modelName?: string;
    }
  | {
      /** A provider assistant message starts inside the same user turn (including retries). */
      type: "assistant_message_start";
      taskId: string;
      messageId: string;
    }
  | {
      type: "conversation_interaction_snapshot";
      taskId: string;
      executionId: string;
      messageId: string;
      interaction: import("./conversation-interaction").ConversationInteractionDto;
    }
  | {
      type: "conversation_goal_snapshot";
      taskId: string;
      goal?: import("./conversation-goal").ConversationGoalDto;
    }
  | {
      type: "text_delta";
      taskId: string;
      messageId: string;
      delta: string;
      /** true = 最终回复区；false = 时间线过程区 */
      final?: boolean;
    }
  | {
      type: "thinking_delta";
      taskId: string;
      messageId: string;
      delta: string;
    }
  | {
      type: "tool_start";
      taskId: string;
      messageId: string;
      toolCallId: string;
      parentToolCallId?: string;
      tool: string;
      summary: string;
      detail?: string;
      dangerous?: boolean;
      status: "pending_approval" | "running";
      /** 审批类型：外部写授权（展示三按钮：拒绝 / 允许一次 / 始终允许此文件夹） */
      approvalKind?: "external-write" | "acp";
      /** ACP permission request 所属 external run。 */
      externalRunId?: string;
      /** ACP Agent 返回的原生权限选项；Renderer 原样展示，绝不自动批准。 */
      acpPermissionOptions?: import("./external-agent").ExternalAgentPermissionOptionDto[];
      /** approvalKind=external-write：请求写入的目标绝对路径 */
      targetPath?: string;
      /** approvalKind=external-write：当前任务工作目录 */
      taskRoot?: string;
      /** approvalKind=external-write：建议持久授权的 canonical 目录 */
      canonicalDir?: string;
    }
  | {
      type: "tool_update";
      taskId: string;
      messageId: string;
      toolCallId: string;
      parentToolCallId?: string;
      status?: "pending_approval" | "running" | "success" | "error" | "denied";
      output?: string;
      consult?: import("./multi-model-consult").MultiModelConsultReport;
      webSearch?: import("./web-search").WebSearchReport;
      summary?: string;
    }
  | {
      type: "artifact_ref";
      taskId: string;
      messageId: string;
      /** Domain artifact id（Artifact 本体由 Domain created/updated 事件驱动，renderer 只做消息关联） */
      artifactId: string;
      name: string;
      kind: ArtifactKind;
      change?: { name: string; additions: number; deletions: number };
    }
  | {
      type: "assistant_end";
      taskId: string;
      messageId: string;
      durationMs?: number;
      error?: string;
    }
  | {
      type: "context_usage";
      taskId: string;
      usedTokens: number | null;
      estimated?: boolean;
      contextWindow: number;
      percent?: number | null;
      /** 实时缓存命中率 0..1（cacheRead/(input+cacheRead+cacheWrite)）；无调用数据为 null */
      cacheHitRate?: number | null;
      /** 会话累计输入 token（未命中侧，不含 cacheRead/cacheWrite） */
      inputTokens?: number | null;
      /** 会话累计缓存读取 token */
      cacheReadTokens?: number | null;
      /** 会话累计输出 token */
      outputTokens?: number | null;
    };

export interface ModelInfoDto {
  id: string;
  name: string;
  vendor: string;
  contextWindow: number;
  /** Undefined when the native model contract does not declare this capability. */
  supportsToolCall?: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  /** 非聊天模型只用于 Provider 能力展示，不进入普通模型选择器。 */
  kind?: "chat" | "image-generation";
  /** 设置页的独立启用状态；false 时从普通模型选择器隐藏。 */
  enabled?: boolean;
  /**
   * Provider 已认证且模型出现在运行时可用目录；false = 仅在 models.json 里声明
   * （key 未配好等），设置页仍列出便于配置，但不可作为可执行模型选择。
   */
  available?: boolean;
  /** 运行时 API 协议，如 openai-completions / anthropic-messages。 */
  api?: string;
  /** Native declarations; request byte limits are not universally enforced. */
  inputLimits?: import("@earendil-works/pi-ai").ModelInputLimits;
  /** Pi getSupportedThinkingLevels projection, including native provider defaults. */
  thinkingLevels?: string[];
  /** Model facts projected from Pi ModelRuntime. */
  metadata?: ModelMetadataDto;
}

/** 一次模型目录强制刷新结果。失败 Provider 继续使用刷新前的本地目录。 */
export interface ModelReloadResultDto {
  models: ModelInfoDto[];
  /** 本次确实具备认证并进入动态目录刷新流程的 Provider。 */
  requestedProviderIds: string[];
  errors: Array<{
    providerId: string;
    message: string;
  }>;
}

export interface SkillDto {
  id: string;
  name: string;
  description: string;
  author: string;
  icon: string;
  installed: boolean;
  enabled: boolean;
  builtin?: boolean;
  command?: string;
  filePath?: string;
  /** 来源标记：manual=本地导入 | builtin-market | local-market | connector:<id> | memory-learned */
  source?: string;
}

export interface SkillPackageValidationDto {
  valid: boolean;
  errors: string[];
  warnings: string[];
  hasReferences: boolean;
  hasScripts: boolean;
  hasTemplates: boolean;
  hasEvals: boolean;
  /** Number of concrete eval cases/files discovered; never a fabricated quality score. */
  evalCount: number;
}

export type SkillEvalExpectation = "trigger" | "no-trigger";
export type SkillEvalActual = SkillEvalExpectation | "unknown";

export interface SkillEvalDefinitionDto {
  prompt: string;
  expected: SkillEvalExpectation;
}

export interface SkillEvalDecision {
  index: number;
  actual: SkillEvalActual;
  reason: string;
}

export interface SkillEvalCaseResultDto extends SkillEvalDefinitionDto {
  actual: SkillEvalActual;
  pass: boolean;
  reason: string;
}

export interface SkillEvalRunRequest {
  skillId: string;
  modelId?: string;
}

export interface SkillEvalRunResultDto {
  skillId: string;
  skillName: string;
  /** Package version evaluated; lets the UI detect a stale report after improvement. */
  skillVersion?: string;
  /** SHA-256 of the evaluated SKILL.md; authoritative stale-report check. */
  skillContentHash?: string;
  evaluator: "model-judge-v1";
  /** Explicitly prevents UI/product copy from presenting semantic judge output as a runtime trace. */
  note: string;
  total: number;
  passed: number;
  failed: number;
  unknown: number;
  cases: SkillEvalCaseResultDto[];
  evaluatedAt: number;
}

export interface SkillImprovementGenerateRequest {
  skillId: string;
  modelId?: string;
}

export interface SkillImprovementDraftResult {
  draft: SkillAuthoringDraft;
  eval: SkillEvalRunResultDto;
  /** SHA-256 of the exact SKILL.md used to generate this draft. */
  baseContentHash: string;
}

export interface SkillImprovementApplyRequest {
  skillId: string;
  draft: SkillAuthoringDraft;
  baseContentHash: string;
}

export type SkillResourceCategory = "references" | "scripts" | "templates" | "evals" | "other";

export interface SkillResourceEntryDto {
  path: string;
  category: SkillResourceCategory;
  size: number;
}

export interface SkillRevisionSnapshotDto {
  id: string;
  createdAt: number;
  reason: "before-improve";
  version?: string;
  /** Read-only audit snapshot package path under ~/.mybuddy/authoring-state/history. */
  packagePath?: string;
}

export interface SkillQualityDto {
  packageValid: boolean;
  warnings: string[];
  triggerCaseCount: number;
  boundaryCaseCount: number;
  skillMdChars: number;
  resourceFileCount: number;
  latestEvalPassed?: number;
  latestEvalTotal?: number;
  latestEvalUnknown?: number;
}

export interface SkillDetailDto {
  skillId: string;
  skillName: string;
  description: string;
  enabled: boolean;
  source?: string;
  improvable: boolean;
  improveBlockedReason?: string;
  filePath: string;
  version?: string;
  contentHash: string;
  markdown: string;
  resources: SkillResourceEntryDto[];
  evalDefinitions: SkillEvalDefinitionDto[];
  latestEval: SkillEvalRunResultDto | null;
  revisions: SkillRevisionSnapshotDto[];
  validation: SkillPackageValidationDto;
  quality: SkillQualityDto;
}

export interface SkillAuthoringGenerateRequest {
  intent: string;
  modelId?: string;
}

export interface SkillAuthoringDraft {
  name: string;
  description: string;
  instructions: string;
  triggerExamples: string[];
  nonTriggerExamples: string[];
}

export interface ExpertAuthoringGenerateRequest {
  requestId?: string;
  intent: string;
  modelId?: string;
}

export interface ExpertAuthoringDraft {
  name: string;
  description: string;
  instructions: string;
  skillIds: string[];
}

export interface SkillAuthoringCreateRequest {
  name: string;
  description: string;
  instructions: string;
  triggerExamples?: string[];
  nonTriggerExamples?: string[];
}

export interface SkillAuthoringCreateResult {
  skill: SkillDto;
  packagePath: string;
  validation: SkillPackageValidationDto;
}

export interface ExpertAuthoringCreateRequest {
  name: string;
  description: string;
  instructions: string;
  /** Installed Skill ids copied into the Expert package as Private Skills. */
  skillIds?: string[];
  mcpIds?: string[];
  connectorIds?: string[];
}

export interface ExpertAuthoringCreateResult {
  expert: ExpertDto;
  packagePath: string;
}

export interface MarketSkillDto {
  id: string;
  name: string;
  description: string;
  author: string;
  icon: string;
  version?: string;
  sourcePath?: string;
  /** 市场来源分类：local=内置/MyBuddy；mybuddy=MyBuddy 归档 */
  source?: "local" | "mybuddy";
}

/** 已安装专家（~/.mybuddy/plugins/experts/<slug>/） */
export interface ExpertDto {
  id: string;
  name: string;
  description: string;
  author: string;
  emoji: string;
  tags: string[];
  category?: string;
  version?: string;
  /** 任务示例（官方专家卡片展示） */
  examples?: string[];
  enabled: boolean;
  installed: boolean;
  /** builtin-market | zip | folder | local-market */
  source?: string;
  installedAt?: number;
  filePath?: string;
  /** 专家包自带 Private Skills 目录名列表（~/.mybuddy/plugins/experts/<id>/skills/ 下，不进入全局 Skill Center） */
  skills?: string[];
  mcpIds?: string[];
  connectorIds?: string[];
}

/** 市场中的专家（只读源；安装=复制到 ~/.mybuddy/plugins/experts/） */
export interface MarketExpertDto extends Omit<ExpertDto, "installed" | "enabled"> {
  sourcePath?: string;
}


/** 连接器（本地市场：CLI 通道 + 配套技能） */
export interface LocalConnectorDto {
  id: string;
  name: string;
  description: string;
  type?: string;
  version?: string;
  examples?: string[];
  /** 当前平台的 CLI 安装命令 */
  initCommand?: string;
  versionCheckCommand?: string;
  iconPath?: string;
  skillCount: number;
  installedSkillNames: string[];
  installed: boolean;
  /** 用户启用状态（安装默认 true；停用 = 私有技能不进入候选装配，安装 ≠ active） */
  enabled?: boolean;
  /** cli.json 声明了 auth 能力（本应用不执行 CLI，仅信息展示；active 判定不依赖它） */
  requiresAuth?: boolean;
  installedAt?: number;
  sourcePath: string;
}

/** 专家 Private Skills 只读详情（~/.mybuddy/plugins/experts/<id>/skills/ 下，不进入全局 Skill Center） */
export interface PrivateSkillDto {
  /** 技能目录名（与 ExpertDto.skills 一致的小写 id） */
  id: string;
  /** SKILL.md frontmatter name（无则回退 id） */
  name: string;
  description: string;
  /** P3-2：被全局同名技能覆盖的诊断（first-wins 优先级不变，仅提示） */
  shadowed?: boolean;
}


/** 会话中途切换专家：expertId 传 null/空串 = 解除专家恢复默认人设 */
export interface AgentSwitchExpertRequest {
  taskId: string;
  expertId: string | null;
}

/** Editable Pi model fields. Credentials and request headers remain in Main. */
export interface ModelsModelConfigDto {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: Array<"text" | "image">;
  inputLimits?: import("@earendil-works/pi-ai").ModelInputLimits;
  contextWindow?: number;
  maxTokens?: number;
  cost?: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>["cost"];
  promptCache?: { short?: number; long?: number };
  samplingParams?: Record<string, unknown>;
  samplingParamsByThinkingLevel?: import("@earendil-works/pi-ai").SamplingParamsByThinkingLevel;
  compat?: Record<string, unknown>;
}

export type ModelsModelOverrideDto = Omit<ModelsModelConfigDto, "id" | "api" | "baseUrl" | "cost"> & {
  cost?: Partial<ModelsModelConfigDto["cost"]>;
};

export interface ModelsProviderConfigDto {
  /** 自定义显示名；省略时回退 provider id。 */
  name?: string;
  baseUrl: string;
  api: string;
  /** 透传给 provider 的固定请求头；User-Agent 也存放在这里。 */
  headers?: Record<string, string>;
  /** Native definitions; omitted fields stay omitted in models.json. */
  models: ModelsModelConfigDto[];
  modelOverrides?: Record<string, ModelsModelOverrideDto>;
}

export interface ModelsFileConfigDto {
  providers: Record<string, ModelsProviderConfigDto>;
}

export interface AppSettingsDto {
  language: string;
  permissionMode: PermissionMode;
  defaultModelId: string;
  /** Pi 原生 enabledModels；所有模型入口统一由该 scope 过滤。 */
  enabledModels?: string[];
  /** Provider 暂停前的模型选择；运行权限仍只由 Pi enabledModels 决定。 */
  pausedProviderModels?: Record<string, string[]>;
  proxyUrl: string;
  memoryEnabled: boolean;
  /** External Agent Memory Gateway，默认关闭、仅 loopback。 */
  memoryGatewayEnabled?: boolean;
  /** 外部写入总闸；授权本身还必须是 read-write。 */
  memoryGatewayWriteEnabled?: boolean;
  /** Gateway loopback 端口，1024–65535。 */
  memoryGatewayPort?: number;
  /** Android/Mobile Remote Access，默认关闭、仅 loopback。 */
  remoteAccessEnabled?: boolean;
  remoteAccessPort?: number;
  remoteAccessBaseUrl?: string;
  remoteAccessBindMode?: "loopback" | "lan";
  theme: "light" | "dark" | "system";
  /** Per-model reasoning preferences; the only persisted reasoning preference source. */
  modelPreferences?: ModelPreferencesDto;
  /** 技能是否按场景模式过滤（默认 true） */
  skillModeFilterEnabled?: boolean;
  /** 点击关闭窗口时最小化到系统托盘（默认 true） */
  closeToTray?: boolean;
  /** 统一通知中心 / 桌面通知策略。 */
  notificationPreferences?: import("./notification").NotificationPreferencesDto;
  /**
   * 界面缩放百分比 75–150（默认 100）。
   * 兼容旧版离散档 0–4。
   */
  fontSize?: number;
  /** 旧版界面字体族；保留用于迁移。 */
  fontFamily?: string;
  /** 界面真实字号（px），不再使用 CSS zoom。 */
  uiFontSize?: number;
  /** 代码/终端真实字号（px）。 */
  codeFontSize?: number;
  /** 界面字体族 CSS 值；空字符串 = 系统默认。 */
  uiFontFamily?: string;
  /** 代码字体族 CSS 值；空字符串 = 系统等宽字体。 */
  codeFontFamily?: string;
  /** 代码块语法高亮主题。 */
  codeTheme?: import("./code-theme").CodeThemeId;
  /**
   * Shell 执行隔离等级（P2）。
   * 默认 guarded；os-sandbox 为实验性、默认关闭，需用户显式选择。
   */
  shellIsolationLevel?: "cwd-only" | "guarded" | "os-sandbox";
  /** Interactive terminal preference, independent of Pi's Bash shellPath. */
  terminalShellPath?: string;
  /**
   * 任务级 Active Connector 持久化（无新 DB schema，复用 settings.json 可扩展字段）。
   * taskId → 激活连接器 id 列表；删除任务时由 clearTaskConnectorIds 清理。
   */
  taskConnectorIds?: Record<string, string[]>;
  /**
   * 上下文压缩触发比例（0.1–0.9，默认 0.8）：
   * 会话上下文达到「模型窗口 × 该比例」时自动压缩。按当前会话模型窗口动态计算。
   */
  compactionTriggerRatio?: number;
  /** 1K = 1000 tokens; null disables the absolute threshold. */
  compactionTriggerTokens?: number | null;
  /** 对话分支（Branch in new task）灰度开关（§15.1；默认关闭） */
  conversationBranchEnabled?: boolean;
  /** ACP 管理页显式停用的外部 Agent id；缺省/空数组 = 全部启用。 */
  disabledExternalAgentIds?: string[];
  /** ACP 会话选项偏好：agentId → configId → value（select valueId 或 boolean）。 */
  externalAgentConfigSelections?: Record<string, Record<string, string | boolean>>;
  /** 各 ACP Agent 最近探测到的会话选项快照（设置页下拉数据源）。 */
  externalAgentConfigOptions?: Record<string, import("./external-agent").ExternalAgentConfigOptionDto[]>;
}

/** 用户导入的本地字体（~/.mybuddy/fonts/） */
export interface UserFontDto {
  /** 文件名 id，如 MyFont.ttf */
  id: string;
  /** CSS font-family 名 */
  family: string;
  fileName: string;
  format: "truetype" | "opentype" | "woff" | "woff2";
}

/** 内建 WebAccess Capability 搜索路由条目 */
export interface WebSearchRoutingDto {
  /** 按顺序优先使用的 provider（如 ["tavily", "tinyfish"]） */
  providers: string[];
  /** 触发回退的错误类型（如 ["quota"]） */
  fallbackOn: string[];
}

/** subagent 扩展角色来源 */
export type SubagentScopeDto = "user" | "project" | "both";

/** ~/.mybuddy/subagent.json 内容（subagent 扩展配置） */
export interface SubagentConfigDto {
  /** 默认角色来源：仅用户级 / 仅项目级 / 两者（工具调用参数可覆盖） */
  agentScope?: SubagentScopeDto;
  /** 运行项目级角色前是否弹窗确认（仅交互模式） */
  confirmProjectAgents?: boolean;
  /** 禁用的角色名（user/project 同名一并禁用） */
  disabledAgents?: string[];
  /** 默认模型（provider/id 或裸名；三级优先级第 2 级，角色 frontmatter 可覆盖） */
  defaultModel?: string;
  /** Native Subagent reasoning override. Capability validation still comes from the target model. */
  defaultReasoning?: ModelReasoningPreferenceDto;
  /** MyBuddy 全局默认模型 id（provider/model；跟随全局时作为目标模型） */
  globalDefaultModelId?: string;
  /** 配置文件绝对路径（主进程返回时填充；保存时无需传入） */
  configPath?: string;
}

/**
 * 同一 Provider 多 API Key 池中单个 key 的运行时状态（UI 展示用）。
 * 主进程只读透传；实际由 web-access 扩展在搜索时更新并持久化到 web-search.json 的 apiKeyStates。
 * 冷却/禁用按「池内索引」对齐（池编辑后扩展会整体重置该 provider 状态）。
 */
export interface ApiKeyPoolStateDto {
  /** 池中下次优先尝试的索引 */
  activeIndex: number;
  /** 池内索引 -> 冷却截止 epoch ms（配额/限流用尽） */
  cooldownUntil: Record<string, number>;
  /** 鉴权失败被禁用的池内索引 */
  disabled: number[];
}

/** ~/.mybuddy/web-search.json 内容（pi-web-access 配置） */
export interface WebSearchConfigDto {
	searchPolicy?: import("./web-search").WebSearchPolicy;
	/** Configuration presence only, not a connectivity/quality check. */
	configuredProviders?: string[];
	searchProvider?: string | string[];
	provider?: string | string[];
  tavilyApiKey?: string;
  tinyfishApiKey?: string;
  braveApiKey?: string;
  serperApiKey?: string;
  /**
   * 同一 Provider 多 API Key 池（key 聚合）。键为 provider id（如 "tavily"），
   * 值为明文 key 数组。存在时优先于单 key 字段。
   */
  apiKeyPools?: Record<string, string[]>;
  /** 各 provider key 池的轮换/冷却/禁用运行时状态（由扩展写入，UI 只读） */
  apiKeyStates?: Record<string, ApiKeyPoolStateDto>;
  /** null = clear explicit routing and return to WebAccess auto-selection. */
  searchRouting?: WebSearchRoutingDto | null;
  workflow?: "none" | "summary-review" | "auto-summary";
  autoOpenBrowser?: boolean;
  /** Browser 已渲染页复用（收敛 B）：仅影响「用户已在 MyBuddy 浏览器打开同页」场景 */
  browserReuse?: { enabled?: boolean };
  /** 配置文件绝对路径（主进程返回时填充；保存时无需传入） */
  configPath?: string;
}

/**
 * 聚合页已支持「多 key 池」的 provider（当前：Tavily、Serper）。
 * 与 web-access 扩展 RESOLVED_SEARCH_PROVIDERS 对齐，后续可按同样机制扩展。
 */
export const API_KEY_POOL_PROVIDERS: Array<{
  id: string;
  label: string;
  legacyKeyField: string;
  envKey: string;
}> = [
  { id: "tavily", label: "Tavily", legacyKeyField: "tavilyApiKey", envKey: "TAVILY_API_KEY" },
  { id: "serper", label: "Serper", legacyKeyField: "serperApiKey", envKey: "SERPER_API_KEY" },
];

/** 单个 key 的用量查询结果（Tavily GET /usage） */
export interface SearchProviderKeyUsageDto {
  /** provider id（如 "tavily"） */
  provider: string;
  /** 池内索引（与 apiKeyStates 对齐） */
  keyIndex: number;
  /** 掩码后的 key（用于 UI 定位） */
  maskedKey: string;
  /** 查询是否成功 */
  ok: boolean;
  /** 失败原因（401=key 无效、429=限流、网络错误等） */
  error?: string;
  /** key 级：总额度已用（credit） */
  usage?: number;
  /** key 级：总额度上限（credit） */
  limit?: number;
  /** key 级：搜索次数（本 key 已执行多少次搜索） */
  searchUsage?: number;
  /** 账号级：当前套餐名 */
  plan?: string;
  /** 账号级：套餐内已用 */
  planUsage?: number;
  /** 账号级：套餐上限 */
  planLimit?: number;
}

/**
 * WebAccess 搜索 provider 展示列表（UI 用；与 web-access 扩展 RESOLVED_SEARCH_PROVIDERS 对齐）。
 * codex = Codex OAuth hosted search（复用 Pi/MyBuddy openai-codex OAuth，无独立 API key）。
 */
export const WEB_SEARCH_PROVIDER_OPTIONS: Array<{ id: string; label: string; needsKey?: boolean }> = [
  { id: "codex", label: "Codex OAuth（ChatGPT 订阅）", needsKey: false },
  { id: "openai", label: "OpenAI Responses", needsKey: true },
  { id: "brave", label: "Brave", needsKey: true },
  { id: "parallel", label: "Parallel", needsKey: true },
  { id: "tinyfish", label: "TinyFish", needsKey: true },
  { id: "search1api", label: "Search1API", needsKey: true },
  { id: "searchinfinity", label: "SearchInfinity", needsKey: true },
  { id: "querit", label: "Querit", needsKey: true },
  { id: "tavily", label: "Tavily", needsKey: true },
  { id: "serper", label: "Serper", needsKey: true },
  { id: "serpdive", label: "SerpDive", needsKey: true },
  { id: "kagi", label: "Kagi", needsKey: true },
  { id: "ollama", label: "Ollama", needsKey: true },
  { id: "perplexity", label: "Perplexity", needsKey: true },
  { id: "exa", label: "Exa", needsKey: true },
  { id: "gemini", label: "Gemini", needsKey: false },
  { id: "searxng", label: "SearXNG（自建）", needsKey: false },
  { id: "anysearch", label: "AnySearch", needsKey: true },
  { id: "xai", label: "xAI", needsKey: true },
  { id: "brightdata", label: "Bright Data", needsKey: true },
  { id: "serpbase", label: "SerpBase", needsKey: true },
];

export interface DiskSpaceDto {
  /** 已使用字节 */
  usedBytes: number;
  /** 总容量字节 */
  totalBytes: number;
  /** 可用字节 */
  freeBytes: number;
}

/** 文件修改前自动备份的记录（manifest 中的一条） */
export type BackupKind = "modified" | "deleted";

export interface FileBackupInfoDto {
  /** 备份唯一 ID（文件名去掉 .bak） */
  backupId: string;
  /** 原始文件绝对路径 */
  absPath: string;
  /** 相对工作空间路径（不在工作空间内则为 basename） */
  relPath: string;
  /** 备份文件绝对路径 */
  backupPath: string;
  createdAt: number;
  size: number;
  taskId: string;
  /** modified = 修改前备份；deleted = 删除前备份（还原会重新创建文件） */
  kind?: "modified" | "deleted";
  /** 备份的是目录（删除目录时保留整棵副本） */
  isDir?: boolean;
}

export interface AgentRestoreBackupRequest {
  taskId: string;
  backupId: string;
}

export interface ContextUsageDto {
  taskId: string;
  usedTokens: number | null;
  /** True for a Pi post-compaction estimate or a persisted last-known snapshot. */
  estimated?: boolean;
  contextWindow: number;
  percent: number | null;
  /** 缓存命中率 0..1（cacheRead/(input+cacheRead+cacheWrite)）；无调用数据为 null */
  cacheHitRate: number | null;
  /** 会话累计输入 token（未命中侧）；无数据为 null */
  inputTokens: number | null;
  /** 会话累计缓存读取 token；无数据为 null */
  cacheReadTokens: number | null;
  /** 会话累计输出 token；无数据为 null */
  outputTokens: number | null;
}

export type AuthTypeDto = "api_key" | "oauth";

/** 支持 pi /login 的 provider */
export interface LoginProviderDto {
  id: string;
  name: string;
  authTypes: AuthTypeDto[];
  /** 是否已配置鉴权（auth.json / 环境变量 / models.json） */
  loggedIn: boolean;
  credentialType?: AuthTypeDto;
  /** 配置来源：stored / environment / models.json / runtime */
  authSource?: string;
  authLabel?: string;
  /** Provider 自身声明的默认 base URL。 */
  baseUrl?: string;
  /** Provider 固定 User-Agent（若有）。 */
  userAgent?: string;
  /** 设置页展示的目录/元数据来源。 */
  catalogSource?: "pi";
  /** Provider 当前同步目录中的模型；未登录也可用于设置页预览。 */
  models?: ModelInfoDto[];
}

export interface CredentialInfoDto {
  providerId: string;
  type: AuthTypeDto;
}

/** 登录过程中发给 UI 的 prompt（对应 pi AuthPrompt） */
export type AuthPromptDto =
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: Array<{ id: string; label: string; description?: string }>;
    }
  | { type: "manual_code"; message: string; placeholder?: string };

export type AuthEventDto =
  | { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export interface AuthPromptRequestDto {
  requestId: string;
  prompt: AuthPromptDto;
}

export interface AuthLoginRequest {
  providerId: string;
  authType: AuthTypeDto;
}

/** pi /login 成功后返回可用模型 + 自动选用的默认模型（对齐 completeProviderAuthentication） */
export type AuthLoginResult =
  | { ok: true; models: ModelInfoDto[]; selectedModelId?: string }
  | { ok: false; error: string };

/** pi /logout：只清本地凭证并回本地模型快照，不扫上游目录 */
export interface AuthLogoutResult {
  models: ModelInfoDto[];
}

export interface CronJobDto {
  id: string;
  name: string;
  prompt: string;
  scheduleType: "at" | "every" | "cron";
  scheduleExpr: string;
  timezone: string;
  spaceId?: string;
  cwd?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  /** 执行权限；缺省按 auto（定时任务通常无人值守） */
  permissionMode?: PermissionMode;
  /**
   * 任务类型 / 场景模式：日常办公 working · 代码开发 coding · 设计创意 design。
   * 缺省 working（兼容旧数据）。
   */
  welcomeMode?: WelcomeMode;
  /** 指定模型；缺省走应用默认模型 */
  modelId?: string;
  /** Expert selected for this session. */
  expertId?: string;
  /** 优先使用的已安装技能 id 列表 */
  skillIds?: string[];
  /** 已授权连接器 id（免确认意图；执行时注入可用技能提示） */
  connectorIds?: string[];
  /** 生效起始（含当日 00:00，ms）；缺省 = 立即生效 */
  effectiveFrom?: number;
  /** 生效结束（含当日 23:59:59，ms）；缺省 = 始终有效 */
  effectiveTo?: number;
  /** 下次计划执行时间（ms）；由主进程 list 时计算，不入库 */
  nextRunAt?: number;
  /** 所属项目；缺省 = 全局自动化（不绑定项目） */
  projectId?: string;
}

export interface CronRunDto {
  id: string;
  jobId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "success" | "error" | "skipped";
  error?: string;
  taskId?: string;
}

export type GatewayChannelType = "feishu" | "wechat" | "wecom" | "telegram" | "slack";

export interface GatewayChannelDto {
  id: string;
  type: GatewayChannelType;
  name: string;
  connected: boolean;
  statusText?: string;
}

export interface GatewayStatusDto {
  running: boolean;
  channels: GatewayChannelDto[];
}

/** 已保存通道配置的脱敏视图（secret 类字段为 REDACTED 占位符，保持原样提交即复用旧值） */
export interface GatewayChannelConfigDto {
  hasConfig: boolean;
  config: Record<string, unknown>;
}

export interface GatewayEventDto {
  channelId: string;
  direction: "in" | "out" | "system";
  text: string;
  at: number;
  chatId?: string;
  senderId?: string;
  senderName?: string;
  messageId?: string;
}

export interface GatewayMessageDto {
  id: number;
  channelId: string;
  chatId: string;
  direction: "in" | "out" | "system";
  senderId?: string;
  senderName?: string;
  text: string;
  at: number;
}

export interface GatewayListMessagesRequest {
  channelId?: string;
  chatId?: string;
  /** 默认 200 */
  limit?: number;
}

export interface SpaceDto {
  id: string;
  name: string;
  path?: string;
  /** true = 已归档（从空间列表隐藏，数据保留，可在设置中恢复） */
  archived?: boolean;
  /** DB created_at 映射（可选，仅供排序 tie-break 与 selector 对齐；缺省回退 id），不改 schema */
  createdAt?: number;
  /** V2 Workspace Tree：直接父空间 id；null = 根空间。未提供（undefined）= 保留旧值（迁移兼容）。 */
  parentId?: string | null;
  /** V2 Workspace Tree：同父下显式排序键（1000 步进；0 = 未显式排序，回退 created_at/updated_at）。 */
  sortOrder?: number;
  /** listSpaces 计算字段：自身或任一祖先已归档（explicit archived 的传递有效态）。 */
  effectiveArchived?: boolean;
  /** listSpaces 计算字段：已绑路径但目录不存在（文件夹被挪走） */
  pathMissing?: boolean;
}

/** upsertSpace 的结果：成功时返回生效后的空间行（id 可能被主进程复用/合并） */
export type DbUpsertResult =
  | { ok: true; space: SpaceDto }
  | { ok: false; error: string };

export type DbRenameResult = { ok: true } | { ok: false; error: string };

export interface TaskDto {
  /** Read-only projection of the task-owned expert configuration. */
  expertBinding?: import("./expert-binding").TaskExpertBindingDto;
  executionBackend?: "pi" | "pi-durable";
  id: string;
  title: string;
  /** null 表示明确解除工作空间绑定；undefined 表示调用方未提供该字段。 */
  spaceId?: string | null;
  /** null 表示明确解除 Project 上下文；undefined 表示调用方未提供该字段。 */
  projectId?: string | null;
  status?: string;
  updatedAt: number;
  sessionFile?: string;
  cwd?: string;
  welcomeMode?: WelcomeMode;
  modelId?: string;
  permissionMode?: PermissionMode;
  /** true = 已归档（从侧栏任务列表隐藏，数据保留，可在设置中恢复） */
  archived?: boolean;
  /** Expert selected for this session. */
  expertId?: string;
  /** 选中场景预设 id（Design Mode 任务）；非 design 任务为 null；旧任务无字段 = 未设置 */
  modePresetId?: string | null;
  /** 计划开始日（当地 0 点 ms）；undefined = 调用方未改 */
  startAt?: number | null;
  /** 计划截止日（当地 0 点 ms，含当天）；undefined = 调用方未改 */
  dueAt?: number | null;
  /** V2 Workspace Tree：任务在所属空间（space_id）下的显式排序键（未提供 = 保留旧值；0 = 未显式排序，回退 updatedAt）。 */
  spaceSortOrder?: number;
  /** 固定/收藏（is_favorited 持久化列，Phase 2 presentation priority）；未提供 = 保留旧值。仅作展示层置顶（selector compareMixed 置顶），不改写 sortOrder/spaceSortOrder 持久排序键，不改变结构顺序值。 */
  isFavorited?: boolean;
  /** ACP 外部 Agent 任务级固定：undefined = 未提供（保留旧值），null = 明确解除固定。 */
  externalAgentPin?: import("./external-agent").ExternalAgentPinDto | null;
}

export interface SoulDto {
  name: string;
  alias: string;
  persona: string;
}


export interface MemoryChangedDto {
  scope: "global" | "space" | "settings";
  spaceId?: string;
}

/** 从 session jsonl 还原给 UI 的精简消息 */
export interface ChatArtifactDto {
  id: string;
  name: string;
  kind: ArtifactKind;
  content: string;
  language?: string;
  path?: string;
}

export type TaskReferenceFileSourceDto = "artifact" | "attachment" | "change";

export interface TaskReferenceFileDto {
  id?: string;
  name: string;
  path?: string;
  source: TaskReferenceFileSourceDto;
}

export interface TaskReferenceDto {
  taskId?: string;
  title: string;
  spaceName?: string;
  files: TaskReferenceFileDto[];
}

export interface ChatAttachmentDto {
  name: string;
  path?: string;
}

export interface ChatToolCallDto {
  id: string;
  parentToolCallId?: string;
  tool: string;
  summary: string;
  detail?: string;
  output?: string;
  consult?: import("./multi-model-consult").MultiModelConsultReport;
  webSearch?: import("./web-search").WebSearchReport;
  status: "success" | "error" | "running";
}

export interface ChatMessageDto {
  streaming?: boolean;
  /** Stable native generation identity across partial and committed snapshots; presentation only. */
  presentationKey?: string;
  generationStats?: import("./generation-stats").GenerationStats;
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  modelName?: string;
  /** 外部 Agent 来源；历史恢复后仍可区分 MyBuddy/Pi 与 ACP。 */
  externalAgent?: { id: string; name: string; protocol: "acp"; runId?: string; continuationMode?: "new" | "resume" | "load" | "fallback_new"; sessionReady?: boolean; resumeSupported?: boolean; recoveryState?: import("./external-agent").DelegatedRunRecoveryState; verificationStatus?: import("./external-agent").DelegatedRunVerificationStatus; outputCursor?: number };
  createdAt: number;
  /**
   * 真实 Pi session entry id（会话分支主锚点，实施规划 §7.1）。
   * user 消息 = 对应 user message entry；assistant 消息 = 该回合最后一个
   * message entry（after_reply 分支点正好指向它）。缺失 = 旧版本/合成消息。
   */
  entryId?: string;
  /** 当前用户回合到最后一条助手消息的耗时。 */
  durationMs?: number;
  artifacts?: ChatArtifactDto[];
  /** Trusted Artifact Domain ids already reconciled for this message. */
  artifactIds?: string[];
  attachments?: ChatAttachmentDto[];
  taskReferences?: TaskReferenceDto[];
  /** 从存储 prompt 恢复的抓取位置与用户备注。 */
  selectionLabels?: string[];
  tools?: ChatToolCallDto[];
}

export interface SessionHistoryRecoveryDto {
  kind: "corrupt-records" | "read-only-fallback";
  invalidRecords: number;
  firstInvalidLine?: number;
  tailOnly: boolean;
  message: string;
}

export interface TaskHistoryDto {
  durable?: import("./durable-bot").DurableBotSnapshot;
  messages: ChatMessageDto[];
  artifacts?: ChatArtifactDto[];
  sessionFile?: string;
  cwd?: string;
  /** Read-only recovery diagnostic. History loading never rewrites the source JSONL. */
  sessionRecovery?: SessionHistoryRecoveryDto;
}

/* ------------------------------ MCP 配置 ------------------------------ */

export type McpServerTransport = "url" | "command" | "socket" | "unknown";

export interface McpSourceDto {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  kind: "shared" | "pi" | "import";
  scope: "global" | "project";
  importKind?: string;
  serverCount: number;
}

export interface McpImportDto {
  kind: string;
  label: string;
  path: string;
  serverCount: number;
}

export interface McpDiscoveryDto {
  /** 配置来源（shared-global … pi-global） */
  sources: McpSourceDto[];
  /** 可发现的兼容来源（cursor / claude-code …） */
  imports: McpImportDto[];
  /** 各来源服务器总数（含重复） */
  totalServerCount: number;
  /** MyBuddy 应用全局配置路径 */
  appGlobalConfigPath: string;
}

export interface McpServerDto {
  exposure?: string;
  description?: string;
  name: string;
  /** 来源 id（pi-global / shared-project / import:cursor …） */
  sourceId: string;
  sourcePath: string;
  transport: McpServerTransport;
  /** url / command / socket 摘要 */
  endpoint: string;
  args: string[];
  env: string[];
  disabled: boolean;
  /** 定义在应用全局 ~/.mybuddy/plugins/mcp/mcp.json 中（已安装到 MyBuddy） */
  installed: boolean;
  /** 原始 entry 字段名（用于展示细节） */
  fields: string[];
}

export interface McpConfigPreviewDto {
  path: string;
  existed: boolean;
  changed: boolean;
  beforeText: string;
  afterText: string;
  diffText: string;
}

export interface McpInstallResultDto {
  ok: boolean;
  path?: string;
  names?: string[];
  added?: string[];
  removed?: string[];
  preview?: McpConfigPreviewDto;
  error?: string;
}

export interface McpProjectConfigDto {
  path: string;
  text: string;
}

export interface McpServerConfigDto {
  name: string;
  path: string;
  entryText: string;
}

export interface McpSaveServerRequest {
  name: string;
  entryText: string;
  /** null creates only; a string edits only the unchanged entry. */
  expectedEntryText: string | null;
}

export interface McpServerToolsDto {
  name: string;
  tools: { name: string; description: string; exposure: string; parameters: unknown }[];
}

/* ------------------------------ MCP 运行时 ------------------------------ */

export type McpServerRuntimeStatus =
  | "connected"
  | "cached"
  | "connecting"
  | "failed"
  | "needs-auth"
  | "not-connected"
  | "disabled";

export interface McpServerStatusSnapshotDto {
  oauth?: boolean;
  error?: string;
  exposure?: string;
  hasCredentials?: boolean;
  name: string;
  status: McpServerRuntimeStatus;
  toolCount: number;
  resourceCount?: number;
  failedAgoSeconds?: number;
  disabled: boolean;
}

export interface McpStatusSnapshotDto {
  codeMode?: import("./pi-code-mode").PiCodeModeState;
  sessionId?: string;
  runtime?: "pi-native";
  errors?: string[];
  version: number;
  servers: McpServerStatusSnapshotDto[];
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
}

export interface McpProxyResultDto {
  ok: boolean;
  text?: string;
  details?: Record<string, unknown>;
  error?: string;
}

export type McpUiPromptKind = "confirm" | "select" | "input" | "editor";

export interface McpUiPromptDto {
  requestId: string;
  kind: McpUiPromptKind;
  title?: string;
  message?: string;
  placeholder?: string;
  prefill?: string;
  options?: string[];
}

export interface McpNotifyDto {
  message: string;
  type: "info" | "warning" | "error";
  at: number;
}

// ---------- 用量统计（账户面板；事实表在主进程 usage_events） ----------

export const UsageIpc = {
  summary: "usage:summary",
  drilldown: "usage:drilldown",
  trend: "usage:trend",
  heatmap: "usage:heatmap",
  monthly: "usage:monthly",
  exportCsv: "usage:exportCsv",
  dashboard: "usage:dashboard",
} as const;

export interface UsageSummaryDto {
  rangeDays: number;
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number | null;
  reasoning: number | null;
  cost: number;
  calls: number;
  turns: number;
  sessions: number;
  providers: number;
  cacheHitRate: number | null;
  errorRate: number | null;
  avgTtftMs: number | null;
  avgTps: number | null;
  avgModelWallMs: number | null;
  errors: number;
}

export interface UsageDrilldownRowDto {
  provider: string;
  model: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
  totalTokens: number;
  cost: number;
  ttftMs: number | null;
  tps: number | null;
  wallMs: number | null;
  errors: number;
  cacheHitRate: number | null;
}

export interface UsageTrendPointDto {
  key: string;
  tokens: number;
  calls: number;
  cost: number;
}

export interface UsageHeatmapCellDto {
  week: number;
  tokens: number;
  calls: number;
}

export interface UsageMonthlyPointDto {
  key: string;
  tokens: number;
  calls: number;
  cost: number;
}

export interface UsageDailyCellDto {
  date: string;
  tokens: number;
  calls: number;
  cost: number;
}

export interface UsageSkillStatDto {
  name: string;
  count: number;
}

/** 用量面板一次拉取的视图（窗口汇总 + 近 53 周活跃度）。 */
export interface UsageDashboardDto {
  rangeDays: number;
  from: string;
  to: string;
  heatFrom: string;
  heatTo: string;
  totalTokens: number;
  dailyPeakTokens: number;
  longestTaskMs: number;
  currentStreakDays: number;
  longestStreakDays: number;
  sessions: number;
  runs: number;
  calls: number;
  avgTokensPerRun: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
  cost: number;
  cacheHitRate: number | null;
  avgTtftMs: number | null;
  avgTps: number | null;
  avgModelWallMs: number | null;
  errorRate: number | null;
  errors: number;
  days: UsageDailyCellDto[];
  models: UsageDrilldownRowDto[];
  skills: UsageSkillStatDto[];
}
