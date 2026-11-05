import { DEFAULT_WELCOME_MODE } from "../../shared/mode-profile";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AssembleModePreviewRequest,
  EnhancePromptRequest,
  EnhancePromptResult,
  PermissionMode,
  WelcomeMode,
} from "../../shared/agent-ipc";
import type { ResolvedProjectContext } from "../../shared/project-domain";
import { normalizeSingleExpertId } from "../../shared/expert-id";
import {
  resolveProjectTaskDefaults,
  resolveProjectTemplateTaskSuggestion,
  type ProjectTaskDefaultCandidate,
} from "../../shared/project-task-defaults";
import { listProjectTemplates } from "../../shared/project-template";
import { sanitizeEnhancedPrompt } from "../../shared/prompt-enhance";
import type { AppDatabase } from "../db/AppDatabase";
import type { AppSettingsStore } from "../AppSettingsStore";
import type { TaskExecutionWorkspace } from "../task/TaskExecutionWorkspace";
import type { ExpertService } from "../experts/ExpertService";
import type { ProjectContextResolver } from "../project/ProjectContextResolver";
import type { RuntimeContextSnapshotRepository } from "./RuntimeContextSnapshotRepository";
import type { SessionRegistry } from "./SessionRegistry";
import type { ModeProfileStore } from "./ModeProfileStore";
import { resolveModePreset } from "../../shared/mode-profile";

const ENHANCE_SYSTEM_ROLE = `## Prompt Enhance（增强提示词）
你是 MyBuddy 的 Prompt Enhance 引擎。
你的唯一任务，是把用户「即将发送给正式 Agent 的指令」改写成更清晰、更明确、更可执行的 Prompt。
你不是任务执行者。

绝对禁止：
1. 回答用户的问题；
2. 完成用户请求的任务；
3. 提供最终解决方案；
4. 替用户进行产品设计；
5. 自行生成用户未提供的业务事实；
6. 自行生成用户未要求的功能清单；
7. 自行选择最终技术方案；
8. 自行给出分析结论；
9. 把你的知识答案伪装成用户 Prompt。

你只能使用以下信息：
- 用户原始输入；
- 下方「## 当前执行环境」段中列出的当前环境（当前 Mode、Tag / Preset、Expert、允许的 Skill、Project / Workspace 上下文）；
- 通用的 Prompt 工程原则。

本功能不提供对话历史或任务记忆：不得引用、暗示或编造此前讨论过的内容；
凡是用户原始输入与当前执行环境之外的信息，一律视为未知。
任何未知信息都必须保持未知。
不要为了让 Prompt 看起来更完整而猜测缺失信息。

你的工作：
1. 保留用户原始意图；
2. 消除明显歧义；
3. 补充执行目标；
4. 补充合理的范围与边界；
5. 补充执行过程约束；
6. 补充用户期望的输出形式；
7. 利用当前 Agent 环境，使 Prompt 更适合正式 Agent 执行；
8. 如果关键条件缺失，要求正式 Agent 在执行前检查或澄清，而不是你自己补答案。

允许：
- 结构化用户已有信息；
- 增加通用执行流程（如：先检查、再定位、再修改、再验证、最后汇报）；
- 增加「不修改无关内容」「先定位再修复」等执行约束；
- 根据明确的 Mode / Tag 补充已知执行规则。

禁止：
- 新增用户未提出的业务功能；
- 新增用户未提供的技术要求；
- 新增用户未提供的产品需求；
- 猜测问题答案；
- 猜测最终设计。

信息来源优先级：用户明确输入 > 当前执行环境（Mode / Tag / Expert / Skill / Project 已知规则）> 通用执行结构。禁止用模型常识覆盖用户输入。

输出风格：只输出「增强后的用户 Prompt」正文；不解释；不加标题；不加「增强后的提示词：」前缀；不用代码围栏；不回答 Prompt；保持用户原始语言；不要无限膨胀；输入已明确时只做最小改写。

最终只输出「增强后的用户 Prompt」。不要解释。不要加标题。不要加「增强后的提示词：」。不要使用代码围栏。不要回答 Prompt。`;

export interface PromptEnhancementServiceDependencies {
  db: AppDatabase;
  registry: SessionRegistry;
  settings: AppSettingsStore;
  taskWorkspace: TaskExecutionWorkspace;
  expertsService: ExpertService;
  projectContextResolver: ProjectContextResolver;
  runtimeSnapshots: RuntimeContextSnapshotRepository;
  modeProfiles: ModeProfileStore;
  assembleModePreview: (request: AssembleModePreviewRequest) => { skillFilter: { visible: string[] } };
  generate: (input: { requestId?: string; taskId?: string; cwd: string; segments: string[]; prompt: string; modelId?: string }) => Promise<string>;
}

/** Validates the enhancement request and assembles its frozen environment for Durable. */
export class PromptEnhancementService {
  private static readonly MAX_CONCURRENT = 2;
  private inflight = 0;

  constructor(private readonly deps: PromptEnhancementServiceDependencies) {}

  async enhance(req: EnhancePromptRequest): Promise<EnhancePromptResult> {
    const surface = req.surface ?? "chat";
    if (surface !== "chat" && surface !== "new-task") {
      throw new Error(`未知的 enhance surface：${surface}`);
    }
    const input = req.input?.trim() ?? "";
    if (!input) throw new Error("提示词增强需要非空输入");
    if (surface === "chat") {
      if (!req.taskId) throw new Error("chat surface 需要有效 taskId");
      if (!this.deps.db.getTask(req.taskId)) throw new Error(`任务不存在：${req.taskId}`);
    } else if (req.taskId) {
      throw new Error("new-task surface 不应携带 taskId");
    }
    if (this.inflight >= PromptEnhancementService.MAX_CONCURRENT) {
      throw new Error("提示词增强请求过多，请稍后重试");
    }

    this.inflight += 1;
    try {
      const cwd = surface === "chat"
        ? this.resolveWorkspaceCwd(req.taskId!)
        : this.resolveWorkspaceCwdForNewTask(req.spaceId);
      const environment = surface === "chat"
        ? this.buildEnvironmentContext(req.taskId!)
        : this.buildEnvironmentContextForNewTask({
            projectId: req.projectId,
            spaceId: req.spaceId,
            cwd,
            mode: req.mode,
            tag: req.tag,
            expertId: req.expertId,
          });
      const raw = await this.deps.generate({ requestId: req.requestId, taskId: req.taskId, cwd, segments: [...environment, ENHANCE_SYSTEM_ROLE],
        prompt: `## 用户原始输入\n${input}`, modelId: req.modelId });
      if (!raw.trim()) throw new Error("提示词增强未返回结果，请重试");
      return { text: sanitizeEnhancedPrompt(raw) };
    } finally {
      this.inflight -= 1;
    }
  }

  private resolveWorkspaceCwd(taskId: string): string {
    const task = this.deps.db.getTask(taskId);
    const fromTask = task?.cwd?.trim();
    if (fromTask) return fromTask;
    if (task?.spaceId) {
      const raw = this.deps.db.getSpace(task.spaceId)?.path?.trim();
      if (raw) {
        try {
          const abs = resolve(raw);
          if (!existsSync(abs) || statSync(abs).isDirectory()) return abs;
        } catch { /* ignore */ }
      }
    }
    return this.deps.taskWorkspace.resolveTaskExecutionWorkspaceDir(taskId);
  }

  private resolveWorkspaceCwdForNewTask(spaceId: string | undefined): string {
    const raw = spaceId ? this.deps.db.getSpace(spaceId)?.path?.trim() : undefined;
    if (raw) {
      try {
        const abs = resolve(raw);
        if (!existsSync(abs) || statSync(abs).isDirectory()) return abs;
      } catch { /* ignore */ }
    }
    return "";
  }

  private buildEnvironmentContext(taskId: string): string[] {
    const task = this.deps.db.getTask(taskId);
    if (!task) return [];
    const connectorIds =
      this.deps.registry.get(taskId)?.connectorIds ??
      this.deps.settings.read().taskConnectorIds?.[taskId] ??
      [];
    return this.buildEnvironmentLines({
      welcomeMode: task.welcomeMode ?? DEFAULT_WELCOME_MODE,
      modePresetId: task.modePresetId ?? null,
      expertId: normalizeSingleExpertId(task.expertId),
      connectorIds,
      permissionMode: task.permissionMode,
      projectId: task.projectId,
      spaceId: task.spaceId,
      tag: this.deps.runtimeSnapshots.list(taskId, 1)[0]?.tagId ?? null,
      cwd: this.resolveWorkspaceCwd(taskId),
      projectContext: task.projectId ? this.deps.projectContextResolver.resolveTask(taskId) : null,
    });
  }

  private buildEnvironmentContextForNewTask(input: {
    projectId?: string;
    spaceId?: string;
    cwd: string;
    mode?: string;
    tag?: string;
    expertId?: string;
  }): string[] {
    const { projectId, spaceId, cwd } = input;
    let explicitMode: WelcomeMode | null = null;
    if (input.mode) {
      try {
        this.deps.modeProfiles.getProfile(input.mode as WelcomeMode);
        explicitMode = input.mode as WelcomeMode;
      } catch { /* invalid mode falls back */ }
    }

    const explicitExpertId = input.expertId?.trim() || null;
    let expertId: string | null = null;
    if (explicitExpertId) {
      try {
        if (this.deps.expertsService.isRuntimeAvailable(explicitExpertId)) expertId = explicitExpertId;
      } catch { /* invalid expert falls back */ }
    }

    let welcomeMode: WelcomeMode = explicitMode ?? DEFAULT_WELCOME_MODE;
    let modePresetId: string | null = null;
    let permissionMode: PermissionMode | null = null;
    let projectContext: ResolvedProjectContext | null = null;
    if (projectId) {
      try {
        projectContext = this.deps.projectContextResolver.resolveProject(projectId);
        const projectTasks = this.deps.db.listTasks().filter((task) => task.projectId === projectId);
        const taskCandidates: ProjectTaskDefaultCandidate[] = projectTasks.map((task) => ({
          projectId: task.projectId ?? undefined,
          spaceId: task.spaceId ?? undefined,
          welcomeMode: task.welcomeMode,
          modePresetId: task.modePresetId ?? null,
          updatedAt: task.updatedAt,
        }));
        const defaults = resolveProjectTaskDefaults({
          tasks: taskCandidates,
          projectId,
          templateSuggestion: projectContext
            ? resolveProjectTemplateTaskSuggestion(projectContext.project, listProjectTemplates())
            : null,
        });
        if (!explicitMode) welcomeMode = defaults.welcomeMode;
        modePresetId = defaults.modePresetId ?? null;
        const recent = [...projectTasks].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (!expertId) expertId = normalizeSingleExpertId(recent?.expertId) ?? null;
        permissionMode = recent?.permissionMode ?? null;
      } catch { /* degrade to defaults */ }
    }

    return this.buildEnvironmentLines({
      welcomeMode,
      modePresetId,
      expertId,
      connectorIds: [],
      permissionMode,
      projectId,
      spaceId,
      tag: input.tag?.trim() || null,
      cwd,
      projectContext,
    });
  }

  private buildEnvironmentLines(args: {
    welcomeMode: WelcomeMode;
    modePresetId: string | null;
    expertId?: string | null;
    connectorIds: string[];
    permissionMode?: PermissionMode | null;
    projectId?: string | null;
    spaceId?: string | null;
    tag?: string | null;
    cwd: string;
    projectContext: ResolvedProjectContext | null;
  }): string[] {
    const lines: string[] = [];
    try {
      const profile = this.deps.modeProfiles.getProfile(args.welcomeMode);
      lines.push(`- 模式：${args.welcomeMode}（${profile.labelZh}）`);
    } catch {
      lines.push(`- 模式：${args.welcomeMode}`);
    }
    try {
      const preset = resolveModePreset(
        this.deps.modeProfiles.getProfile(args.welcomeMode).policy,
        args.modePresetId,
      );
      if (preset) lines.push(`- 场景预设：${preset.id}（${preset.label}）`);
    } catch { /* ignore */ }
    const tagId = args.tag?.trim();
    if (tagId) lines.push(`- Tag：${tagId}`);
    const expertId = normalizeSingleExpertId(args.expertId);
    if (expertId) {
      try {
        const expert = this.deps.expertsService.listInstalled().find((item) => item.id === expertId);
        if (expert) lines.push(`- 专家：${expert.name}${expert.emoji ? ` ${expert.emoji}` : ""}`);
      } catch { /* ignore */ }
    }
    try {
      const assembly = this.deps.assembleModePreview({
        welcomeMode: args.welcomeMode,
        projectId: args.projectId,
        modePresetId: args.modePresetId,
        expertId: expertId ?? null,
        connectorIds: args.connectorIds,
        permissionMode: args.permissionMode ?? undefined,
        spaceId: args.spaceId,
        cwd: args.cwd,
      });
      const visibleSkills = assembly.skillFilter.visible;
      if (visibleSkills.length > 0) lines.push(`- 可用技能：${visibleSkills.join("、")}`);
      if (args.projectContext) lines.push(`- 项目：${args.projectContext.project.name}`);
      lines.push(`- 工作目录：${args.cwd}`);
    } catch { /* ignore */ }
    return lines.length > 0 ? [`## 当前执行环境\n${lines.join("\n")}`] : [];
  }
}
