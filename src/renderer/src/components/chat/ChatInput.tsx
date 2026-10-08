import { useConsultSelection } from "./useConsultSelection";
import { requestConsultForMessage } from "@shared/multi-model-consult";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { selectActiveTaskArtifacts, useAppStore, type StreamingSendMode } from "@/store/appStore";
import type {
  Attachment,
  ModelConfig,
  Skill,
  TaskReference,
  ThinkingLevel,
} from "@/types";
import type { LocalConnectorDto, ModeSkillPolicy } from "@shared/agent-ipc";
import type { ExternalAgentDescriptorDto } from "@shared/external-agent";
import { isSkillVisibleForMode, sortSkillsByModePolicy } from "@shared/mode-access-filter";
import { emptyModePolicy } from "@shared/mode-profile";
import {
  hasReasoningOption,
  reasoningEffortLabel,
  reasoningEffortValues,
  reasoningPreferenceSummary,
} from "@shared/model-metadata";
import { activeConnectorChips } from "@/lib/connectorChips";
import { activeExecutionLabel, taskHasActiveExecution } from "@/utils/taskFilters";
import { canTriggerEnhance } from "@/features/prompt-enhance/policy";
import { PromptEnhanceControl } from "@/features/prompt-enhance/PromptEnhanceControl";
import type { PromptEnhanceContext } from "@/features/prompt-enhance/types";
import { usePromptEnhance } from "@/features/prompt-enhance/usePromptEnhance";
import { resolveStreamingSendPlan } from "@/utils/streamingSend";
import { heroPlaceholder } from "./heroCopy";
import { isHeroSuggestion } from "./heroSuggest";
import InputAddMenu, { type RefFileItem, type RefTaskItem } from "./InputAddMenu";
import BtwPanel from "./BtwPanel";
import { btwComposerSendInput, useBtwStore } from "@/store/btwStore";
import WorkspacePicker from "./WorkspacePicker";
import ProjectPicker from "./ProjectPicker";
import ModePicker from "./ModePicker";
import TagPicker from "./TagPicker";
import HomePermissionPicker from "./HomePermissionPicker";
import FullAccessConfirmModal from "./FullAccessConfirmModal";
import ContextUsageControl from "./ContextUsageControl";
import PiCodeModeChip from "./PiCodeModeChip";
import { isManualCompactionRunning } from "@shared/compaction";
import GenerationSpeed from "./GenerationSpeed";
import { FileBadge } from "@/components/common/FileBadge";
import { fileNameFromPath, isFileLikeDrag, isTaskDrag, pathsFromWorkspaceDrop } from "@/lib/workspaceFileDrag";
import {
  IconArrowUp,
  IconAt,
  IconBlocks,
  IconBot,
  IconBtw,
  IconCheck,
  IconChevronDown,
  IconCode,
  IconLink,
  IconList,
  IconPencil,
  IconPin,
  IconPlus,
  IconSparkles,
  IconStop,
  IconTarget,
  IconUsers,
  IconX,
} from "@/components/common/icons";
import ModelBrandIcon from "@/components/common/ModelBrandIcon";
import {
  REFERENCE_CONTEXT_END,
  REFERENCE_CONTEXT_START,
  buildTaskReferenceBlock,
} from "@/lib/taskReference";
import {
  layoutRect,
  layoutViewportSize,
  placeFixedSideFlyout,
  placeStackOrSide,
} from "@/lib/placeFixedMenu";
import {
  clearTaskComposerDraft,
  composerDraftScope,
  emptyTaskComposerDraft,
  loadTaskComposerDraft,
  saveTaskComposerDraft,
  type ComposerAttachedMcp,
  type ComposerAttachedSkill,
  type TaskComposerDraft,
} from "@/lib/taskComposerDraft";

const STREAMING_SEND_MODE_LABELS: Record<StreamingSendMode, string> = {
  continue: "继续",
  steer: "引导",
  interrupt: "打断执行",
};

const STREAMING_SEND_MODE_DESCRIPTIONS: Record<StreamingSendMode, string> = {
  continue: "当前执行完成后继续处理这条消息",
  steer: "当前步骤结束后按最新指令调整方向",
  interrupt: "停止当前生成，再执行这条消息",
};

type ExternalAgentSelection = Pick<ExternalAgentDescriptorDto, "id" | "name" | "protocol"> & {
  commandLabel?: string;
  continueFromRunId?: string;
};

interface Props {
  variant?: "home" | "chat" | "project";
  /** 用户显式提交成功前通知聊天视图恢复跟随；区别于后台消息追加。 */
  onBeforeSend?: () => void;
  onSend?: (
    text: string,
    attachments?: Attachment[],
    taskReferences?: TaskReference[],
    streamingBehavior?: "steer" | "followUp",
    connectorIds?: string[],
    externalAgent?: ExternalAgentSelection,
  ) => void;
  /** 外部填入草稿（如 HomeHero 场景 chip） */
  externalDraft?: string | null;
  onExternalDraftConsumed?: () => void;
  /** 首页与标题/建议共用的当前预设，避免和全局 modePresetId 各走各的 */
  scenePresetId?: string | null;
}

/** 输入框中展示的已加载技能（参考 MyBuddy skill tag） */
type AttachedSkill = ComposerAttachedSkill;
type AttachedMcp = ComposerAttachedMcp;

interface AttachedConnector {
  id: string;
  name: string;
  /** 安装时落盘的配套技能名，发送时尽量挂 /command */
  skillNames: string[];
}

function toAttachedSkill(skill: Skill): AttachedSkill {
  const command = (skill.command || skill.name).trim();
  return {
    id: skill.id,
    name: skill.name,
    command: command || skill.name,
    icon: skill.icon,
  };
}

/** 把引用任务的上下文拼进 prompt；任务正文只给 Agent，UI 只显示引用摘要。 */
function mergeAttachments(...lists: Attachment[][]): Attachment[] {
  const merged: Attachment[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const attachment of list) {
      const key = (attachment.path || attachment.name).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(attachment);
    }
  }
  return merged;
}

function toTaskReference(task: RefTaskItem): TaskReference {
  return {
    taskId: task.id,
    title: task.title,
    spaceName: task.spaceName,
    files: (task.files ?? []).map((file) => ({
      id: file.id,
      name: file.name,
      path: file.path,
      source: file.source,
    })),
  };
}

function buildFileContentBlock(file: RefFileItem): string {
  const body = (file.content ?? "").trim();
  if (!body) return `## 引用文件：${file.name}\n（无可用内容，请在对话中查看产物）`;
  const clipped = body.length > 12_000 ? `${body.slice(0, 12_000)}\n…（已截断）` : body;
  return `## 引用文件：${file.name}\n\`\`\`\n${clipped}\n\`\`\``;
}

/** 芯片/气泡用短文件名，完整路径只放 title，避免盖住输入正文 */
function shortFileLabel(name: string, path?: string): string {
  const base = name?.trim();
  if (base && !/[\\/]/.test(base)) return base;
  const src = (path || name || "").trim();
  if (!src) return "文件";
  const parts = src.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || src;
}

export default function ChatInput({
  variant = "chat",
  onBeforeSend,
  onSend,
  externalDraft,
  onExternalDraftConsumed,
  scenePresetId,
}: Props): React.JSX.Element {
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const draftScope = composerDraftScope(variant, activeTaskId);
  const [text, setText] = useState("");
  /** BTW 激活时的独立输入草稿：与主 composer text 完全隔离，退出 BTW 即丢弃 */
  const [btwText, setBtwText] = useState("");
  /** text 的同步镜像：异步回调里判断“用户是否已在途中编辑”（Prompt Enhance stale 防护用） */
  const textRef = useRef(text);
  const interruptSendRef = useRef(false);
  textRef.current = text;
  // BTW（临时上下文分支）：与主任务 executing / streamingSendMode 完全独立；
  // 声明前置：composerDraft 暂停消费等 effect 依赖它
  const btwActive = useBtwStore((s) => s.active);
  const btwStreaming = useBtwStore((s) => s.streaming);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** 从「+ → 技能」或 `/` 菜单选中的技能，显示为输入框顶芯片 */
  const [attachedSkills, setAttachedSkills] = useState<AttachedSkill[]>([]);
  /** 从「+ → MCP」选中/导入的服务器，显示为输入框顶芯片 */
  const [attachedMcps, setAttachedMcps] = useState<AttachedMcp[]>([]);
  /** 引用对话中的文件（芯片 + 发送时注入） */
  const [refFiles, setRefFiles] = useState<RefFileItem[]>([]);
  /** 引用其它任务 */
  const [refTasks, setRefTasks] = useState<RefTaskItem[]>([]);
  /** One-turn ACP External Agent selection; cleared after send or task switch. */
  const [externalAgent, setExternalAgent] = useState<ExternalAgentSelection | null>(null);
  /** 任务级 ACP pin（持久）：存在时每轮自动路由该 Agent 并续接最近可恢复 run。 */
  const pinnedAgent = useAppStore((s) => {
    const taskId = s.activeTaskId;
    return (taskId ? s.tasks.find((t) => t.id === taskId)?.externalAgentPin : s.draft?.externalAgentPin) ?? null;
  });
  const setExternalAgentPin = useAppStore((s) => s.setExternalAgentPin);
  /** pin 态 chip 菜单（本轮新会话 / 解除固定）；瞬态选择时隐藏 pin chip。 */
  const [pinMenuOpen, setPinMenuOpen] = useState(false);
  const pinChipRef = useRef<HTMLSpanElement>(null);
  /** 生效的 ACP 路由（瞬态优先，pin 兜底）；仅用于提示抑制/chip 展示，发送解析在 store。 */
  const effectiveExternalAgent: ExternalAgentSelection | null = externalAgent
    ?? (pinnedAgent
      ? { id: pinnedAgent.id, name: pinnedAgent.name, protocol: "acp" as const, commandLabel: "已固定 · 逐轮续聊" }
      : null);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const droppedTextCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const caret = droppedTextCaret.current;
    const el = textareaRef.current;
    if (caret === null || !el) return;
    droppedTextCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
    autoResize(el);
  }, [text, btwText]);

  useEffect(() => {
    if (externalDraft == null || externalDraft === "") return;
    setText(externalDraft);
    onExternalDraftConsumed?.();
    textareaRef.current?.focus();
  }, [externalDraft, onExternalDraftConsumed]);

  /** 消息「导入到输入框」草稿（消费后清空） */
  const composerDraft = useAppStore((s) => s.composerDraft);
  const clearComposerDraft = useAppStore((s) => s.clearComposerDraft);
  const composerInsertion = useAppStore((s) => s.composerInsertion);
  const clearComposerInsertion = useAppStore((s) => s.clearComposerInsertion);

  // 消息操作「导入到输入框」：写入正文并聚焦。
  // BTW 激活期间暂停消费（保留在 store）：退出 BTW 后自动注入主草稿，内容不丢；
  // 期间 BtwPanel 显示「主线草稿待同步」提示，避免用户误以为导入内容消失。
  useEffect(() => {
    if (btwActive) return;
    if (composerDraft == null || composerDraft === "") return;
    setText(composerDraft);
    clearComposerDraft();
    textareaRef.current?.focus();
  }, [composerDraft, clearComposerDraft, btwActive]);

  // 浏览器控制台等其它 Surface 使用“追加”语义，绝不覆盖用户已输入的草稿。
  useEffect(() => {
    if (btwActive) return;
    if (composerInsertion == null || composerInsertion === "") return;
    setText((prev) => {
      const current = prev.replace(/\s+$/, "");
      return current ? `${current}\n\n${composerInsertion}` : composerInsertion;
    });
    clearComposerInsertion();
    textareaRef.current?.focus();
  }, [composerInsertion, clearComposerInsertion, btwActive]);
  const skills = useAppStore((s) => s.skills);
  const models = useAppStore((s) => s.models);
  const activeModelId = useAppStore((s) => s.activeModelId);
  const modelPreferences = useAppStore((s) => s.modelPreferences);
  const permissionMode = useAppStore((s) => s.permissionMode);
  const welcomeMode = useAppStore((s) => s.welcomeMode);
  const modePresetId = useAppStore((s) => s.modePresetId);
  const resolvedPresetId = scenePresetId ?? modePresetId;
  const sceneKey = `${welcomeMode}:${resolvedPresetId ?? ""}`;
  const sceneKeyRef = useRef(sceneKey);
  useEffect(() => {
    if (variant !== "home") return;
    if (sceneKeyRef.current === sceneKey) return;
    sceneKeyRef.current = sceneKey;
    setText((prev) => (isHeroSuggestion(prev) ? "" : prev));
  }, [variant, sceneKey]);
  const setActiveModel = useAppStore((s) => s.setActiveModel);
  // F2：显式模型标记 + 复位「跟随场景建议」
  const modelExplicit = useAppStore((s) => s.modelExplicit);
  const followSuggestedModel = useAppStore((s) => s.followSuggestedModel);
  // Active 连接器为任务级 store 状态（随任务切换/持久到 task.connectorIds），
  // 不再使用发送即清空的本地临时态。
  const connectors = useAppStore((s) => s.connectors);
  const activeConnectorIds = useAppStore((s) => s.activeConnectorIds);
  const setActiveConnectors = useAppStore((s) => s.setActiveConnectors);
  /** 当前任务 Active 连接器（任务级；随 setActiveTask/newTask 同步；停用连接器不显示为 active） */
  const attachedConnectors: AttachedConnector[] = useMemo(
    () =>
      activeConnectorChips(connectors, activeConnectorIds).map((c) => ({
        id: c.id,
        name: c.name,
        skillNames: c.installedSkillNames ?? [],
      })),
    [connectors, activeConnectorIds],
  );
  const setModelReasoningPreference = useAppStore((s) => s.setModelReasoningPreference);
  const setPermissionMode = useAppStore((s) => s.setPermissionMode);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const {
    requested: consultRequested, notice: consultNotice,
    needsConfiguration: consultNeedsConfiguration, select: selectConsult,
    clear: clearConsult, setNotice: setConsultNotice, openConfiguration: openConsultConfiguration,
  } = useConsultSelection({
    taskId: activeTaskId, externalAgentId: effectiveExternalAgent?.id, settingsOpen,
    openSettings: () => setSettingsOpen(true, "extensions"),
    focusComposer: () => focusComposerAfterPopupClose(),
  });
  const sendMessage = useAppStore((s) => s.sendMessage);
  const abortActiveTask = useAppStore((s) => s.abortActiveTask);
  const streamingSendMode = useAppStore((s) => s.streamingSendMode);
  const setStreamingSendMode = useAppStore((s) => s.setStreamingSendMode);
  /** 「加入聊天」的抓取元素（composer chips；发送时由 sendMessage 一次性消费） */
  const chatSelections = useAppStore((s) => s.chatSelections);
  const clearChatSelection = useAppStore((s) => s.clearChatSelection);
  const terminalContext = useAppStore((s) => s.terminalContext);
  const clearTerminalContext = useAppStore((s) => s.clearTerminalContext);
  /** 产物面板「发送到对话」挂起项（消费后清空） */
  const pendingRefFile = useAppStore((s) => s.pendingRefFile);
  const clearPendingRefFile = useAppStore((s) => s.clearPendingRefFile);
  /** 侧栏「分享任务」挂起项（消费后清空） */
  const pendingRefTask = useAppStore((s) => s.pendingRefTask);
  const clearPendingRefTask = useAppStore((s) => s.clearPendingRefTask);
  const pendingExternalAgentContinuation = useAppStore((s) => s.pendingExternalAgentContinuation);
  const clearPendingExternalAgentContinuation = useAppStore((s) => s.clearPendingExternalAgentContinuation);
  /** 递增信号：抓取元素加入聊天后聚焦输入框 */
  const chatFocusTick = useAppStore((s) => s.chatFocusTick);
  /** slash / 技能菜单：按场景 skillPolicy 过滤 */
  const [skillPolicy, setSkillPolicy] = useState<ModeSkillPolicy>(() => emptyModePolicy().skillPolicy);
  const [skillFilterOn, setSkillFilterOn] = useState(true);

  useEffect(() => {
    void window.api?.agent?.getModeProfile?.(welcomeMode).then((p) => {
      setSkillPolicy(p?.policy?.skillPolicy ?? emptyModePolicy().skillPolicy);
    });
  }, [welcomeMode]);

  useEffect(() => {
    void window.api?.agent?.getAppSettings?.().then((s) => {
      if (s && typeof s.skillModeFilterEnabled === "boolean") {
        setSkillFilterOn(s.skillModeFilterEnabled);
      }
    });
  }, []);
  const taskCompacting = useAppStore(s => isManualCompactionRunning(s.activeTaskId ? s.compactionByTask[s.activeTaskId] : undefined));
  const executing = useAppStore((s) => {
    if (variant === "home") return false;
    const activeTask = s.tasks.find((candidate) => candidate.id === s.activeTaskId) ?? null;
    return taskHasActiveExecution(activeTask);
  });
  // 父任务切换（或回首页）→ 销毁 BTW（不漂移、不恢复）
  useEffect(() => {
    useBtwStore.getState().destroyIfParentChanged(activeTaskId);
  }, [activeTaskId]);
  useEffect(() => {
    setExternalAgent(null);
  }, [activeTaskId]);
  const execLabel = useAppStore((s) => {
    if (variant === "home") return null;
    const activeTask = s.tasks.find((candidate) => candidate.id === s.activeTaskId) ?? null;
    return activeExecutionLabel(activeTask);
  });
  const hasStreamingDraft =
    Boolean(text.trim()) ||
    attachments.length > 0 ||
    attachedSkills.length > 0 ||
    attachedMcps.length > 0 ||
    attachedConnectors.length > 0 ||
    refFiles.length > 0 ||
    refTasks.length > 0;
  const hasAttachChips =
    consultRequested ||
    chatSelections.length > 0 ||
    terminalContext !== null ||
    attachedSkills.length > 0 ||
    attachedMcps.length > 0 ||
    attachedConnectors.length > 0 ||
    attachments.length > 0 ||
    refFiles.length > 0 ||
    refTasks.length > 0 ||
    effectiveExternalAgent !== null;
  const showStreamingMode = executing && hasStreamingDraft && !btwActive;

  const [addOpen, setAddOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [maxMode, setMaxMode] = useState(false);
  /** 模型列表悬停项 id，用于自动弹出思考等级菜单 */
  const [hoverModelId, setHoverModelId] = useState<string | null>(null);
  /** 预览卡：顶边对齐当前模型行，落在列表左侧 */
  const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number } | null>(null);
  /** 思考强度子菜单：挂在「思考强度」行下方，不改预览卡 */
  const [detailPos, setDetailPos] = useState<{ top: number; left: number } | null>(null);
  const [thinkingDetailOpen, setThinkingDetailOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [homePermOpen, setHomePermOpen] = useState(false);
  const [streamingModeOpen, setStreamingModeOpen] = useState(false);
  /** 本轮执行中用户已选过权限后收起条，避免持续占位 */
  const [execPermDismissed, setExecPermDismissed] = useState(false);
  const [fullAccessConfirmOpen, setFullAccessConfirmOpen] = useState(false);

  // 抓取元素「加入聊天」后：切回聊天输入框（attachSelectionToChat 递增 tick）
  useEffect(() => {
    if (chatFocusTick > 0) textareaRef.current?.focus();
  }, [chatFocusTick]);

  const modelAnchorRef = useRef<HTMLDivElement>(null);
  const modelPopupRef = useRef<HTMLDivElement>(null);
  const modelOptionsRef = useRef<HTMLDivElement>(null);
  const thinkingFlyoutRef = useRef<HTMLDivElement>(null);
  const thinkingEntryRef = useRef<HTMLButtonElement>(null);
  const thinkingDetailRef = useRef<HTMLDivElement>(null);
  const flyoutRowRef = useRef<HTMLElement | null>(null);
  const addAnchorRef = useRef<HTMLDivElement>(null);
  const streamingModeAnchorRef = useRef<HTMLDivElement>(null);
  /** portal 到 body 的添加菜单根节点（含子菜单），需纳入 click-outside */
  const addMenuRootRef = useRef<HTMLDivElement>(null);
  const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useDismissOnClickOutside(
    modelOpen,
    () => {
      setModelOpen(false);
      setHoverModelId(null);
      setFlyoutPos(null);
      setDetailPos(null);
      setThinkingDetailOpen(false);
    },
    modelAnchorRef,
    [thinkingFlyoutRef, thinkingDetailRef],
  );
  useDismissOnClickOutside(addOpen, () => setAddOpen(false), addAnchorRef, [addMenuRootRef]);
  useDismissOnClickOutside(streamingModeOpen, () => setStreamingModeOpen(false), streamingModeAnchorRef);
  useDismissOnClickOutside(pinMenuOpen, () => setPinMenuOpen(false), pinChipRef);

  const experts = useAppStore((s) => s.experts);
  const switchExpert = useAppStore((s) => s.switchExpert);
  /** 当前激活任务（home 空草稿也可能带 expertId，如从专家中心召唤） */
  const activeTask = useAppStore((s) =>
    s.tasks.find((candidate) => candidate.id === s.activeTaskId) ?? null,
  );
  /** 有主对话上下文（消息或会话文件）时才能基于当前对话发起 BTW */
  const canBtw =
    variant === "chat" &&
    activeTask !== null &&
    (activeTask.messages.length > 0 || Boolean(activeTask.sessionFile));
  /** 首页/草稿态：召唤专家选中的专家，materialize 前暂存于此 */
  const draft = useAppStore((s) => s.draft);
  /** Prompt Enhance 上下文：双 surface 映射。
   *  chat（有 activeTaskId）：任务内增强，主进程从 taskId 解析受控环境；
   *  new-task（草稿态）：projectId/spaceId 取自 appStore draft（无 id 时主进程回退
   *  全局默认，纯只读无副作用），mode 传当前 welcomeMode，expertId 传当前草稿显式
   *  选中的 Expert（仅 id；随 IPC 发送，主进程校验存在/可用后注入，绝不拼文本），
   *  expertIds 是同一选中的指纹投影（仅参与 stale 指纹，不随 IPC 发送）。 */
  const enhanceContext = useMemo<PromptEnhanceContext>(
    () => {
      if (activeTaskId) {
        return { surface: "chat", taskId: activeTaskId };
      }
      return {
        surface: "new-task",
        ...(draft?.projectId ? { projectId: draft.projectId } : {}),
        ...(draft?.spaceId ? { spaceId: draft.spaceId } : {}),
        mode: welcomeMode,
        ...(draft?.expertId ? { expertId: draft.expertId, expertIds: [draft.expertId] } : {}),
      };
    },
    [activeTaskId, draft, welcomeMode],
  );
  const enhance = usePromptEnhance(enhanceContext, {
    onApply: (t) => {
      setText(t);
      textareaRef.current?.focus();
    },
    getCurrentText: () => textRef.current,
    // hook 内部防御性门控需要真实 BTW 态（不只依赖 UI disabled）
    isBtwActive: () => btwActive,
  });
  /** 通过 + → 专家 选择；与 task.expertId / draft.expertId 同步，可 × 取消 */
  const [pendingExpertId, setPendingExpertId] = useState<string | null>(
    () => activeTask?.expertId ?? draft?.expertId ?? null,
  );

  useEffect(() => {
    setPendingExpertId(activeTask?.expertId ?? draft?.expertId ?? null);
  }, [activeTask?.id, activeTask?.expertId, draft?.expertId]);

  const selectedExpert =
    (pendingExpertId && experts.find((e) => e.id === pendingExpertId)) || null;

  const attachExpert = (expertId: string): void => {
    setPendingExpertId(expertId);
    // 有任务写 task.expertId；无任务写 draft.expertId（发送 materialize 时带上）
    switchExpert(expertId);
    textareaRef.current?.focus();
  };

  const clearExpert = (): void => {
    setPendingExpertId(null);
    // 已有任务写入任务；首页/草稿态清 draft.expertId
    switchExpert(null);
    textareaRef.current?.focus();
  };

  const closeAllPopups = (): void => {
    setPermOpen(false);
    setModelOpen(false);
    setHoverModelId(null);
    setFlyoutPos(null);
    setDetailPos(null);
    setThinkingDetailOpen(false);
    setAddOpen(false);
    setWorkspaceOpen(false);
    setProjectOpen(false);
    setModeOpen(false);
    setTagOpen(false);
    setHomePermOpen(false);
  };

  const samePos = (
    prev: { top: number; left: number } | null,
    next: { top: number; left: number },
  ): boolean => Boolean(prev && prev.top === next.top && prev.left === next.left);

  const positionThinkingFlyout = (
    rowEl: HTMLElement | null,
    detailOpen = thinkingDetailOpen,
  ): void => {
    const popup = modelPopupRef.current;
    if (!rowEl || !popup) return;
    const viewport = layoutViewportSize();
    const flyout = thinkingFlyoutRef.current;
    const next = placeFixedSideFlyout({
      row: layoutRect(rowEl),
      avoid: layoutRect(popup),
      flyoutWidth: flyout?.offsetWidth ?? 220,
      flyoutHeight: flyout?.offsetHeight ?? 72,
      viewport,
    });
    setFlyoutPos((prev) => (samePos(prev, next) ? prev : next));

    if (!detailOpen) {
      setDetailPos((prev) => (prev == null ? prev : null));
      return;
    }
    const detail = thinkingDetailRef.current;
    const dnext = placeStackOrSide({
      preview: {
        top: next.top,
        left: next.left,
        width: flyout?.offsetWidth ?? 220,
        height: flyout?.offsetHeight ?? 72,
      },
      menuWidth: detail?.offsetWidth ?? 200,
      menuHeight: detail?.offsetHeight ?? 52,
      viewport,
    });
    setDetailPos((prev) => (samePos(prev, dnext) ? prev : dnext));
  };

  const openThinkingFlyout = (modelId: string, rowEl: HTMLElement | null): void => {
    if (hoverLeaveTimer.current) {
      clearTimeout(hoverLeaveTimer.current);
      hoverLeaveTimer.current = null;
    }
    flyoutRowRef.current = rowEl;
    const keepDetail = hoverModelId === modelId && thinkingDetailOpen;
    if (!keepDetail) setThinkingDetailOpen(false);
    setHoverModelId(modelId);
    positionThinkingFlyout(rowEl, keepDetail);
  };

  const scheduleCloseThinkingFlyout = (): void => {
    if (hoverLeaveTimer.current) clearTimeout(hoverLeaveTimer.current);
    hoverLeaveTimer.current = setTimeout(() => {
      setHoverModelId(null);
      setFlyoutPos(null);
      setDetailPos(null);
      setThinkingDetailOpen(false);
      flyoutRowRef.current = null;
    }, 200);
  };

  /** Product capability truth comes from model metadata, not Pi transport levels. */
  const reasoningOptionsForModel = (m: ModelConfig) => m.metadata?.reasoningOptions ?? [];
  const canThinkOn = (m: ModelConfig): boolean =>
    Boolean(m.supportsReasoning && reasoningOptionsForModel(m).length > 0);

  const availableModels = useMemo(() => {
    const seen = new Set<string>();
    return models.filter((model) => {
      if (model.enabled === false) return false;
      const id = model.id.trim();
      const name = model.name.trim();
      if (!id || !name || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [models]);

  useLayoutEffect(() => {
    if (!modelOpen || !hoverModelId) return;
    positionThinkingFlyout(flyoutRowRef.current);
  }, [modelOpen, hoverModelId, thinkingDetailOpen]);

  useEffect(() => {
    if (!modelOpen || !hoverModelId) return;
    const onMove = (): void => positionThinkingFlyout(flyoutRowRef.current);
    const scroller = modelOptionsRef.current;
    scroller?.addEventListener("scroll", onMove, { passive: true });
    window.addEventListener("resize", onMove);
    return () => {
      scroller?.removeEventListener("scroll", onMove);
      window.removeEventListener("resize", onMove);
    };
  }, [modelOpen, hoverModelId]);
  const activeModel = availableModels.find((m) => m.id === activeModelId);
  const fullAccess = permissionMode === "auto";
  // 已允许完全访问时，无需在执行过程中重复显示开关条
  const showExecPermBar =
    welcomeMode !== "bot" && executing && Boolean(execLabel) && !fullAccess && !execPermDismissed;

  useEffect(() => {
    if (!executing) setExecPermDismissed(false);
  }, [executing, activeTaskId]);

  const slashQuery =
    btwActive || !text.startsWith("/") || text.includes(" ") ? null : text.slice(1);
  const slashMatches = useMemo(() => {
    if (slashQuery === null) return [];
    const matched = skills.filter(
      (s) =>
        s.installed &&
        s.enabled &&
        s.command &&
        isSkillVisibleForMode(s, welcomeMode, skillPolicy, {
          disableFilter: welcomeMode === "bot" || !skillFilterOn,
        }) &&
        (slashQuery === "" || s.command.startsWith(slashQuery) || s.name.includes(slashQuery)),
    );
    return sortSkillsByModePolicy(matched, skillPolicy);
  }, [skills, slashQuery, welcomeMode, skillPolicy, skillFilterOn]);

  const attachSkill = (skill: Skill): void => {
    const next = toAttachedSkill(skill);
    setAttachedSkills((prev) => {
      if (prev.some((s) => s.id === next.id || s.command === next.command)) return prev;
      return [...prev, next];
    });
    // 若输入框还在用 / 选技能，清掉未完成的 slash 片段，保留后续说明文字
    setText((prev) => {
      if (!prev.startsWith("/")) return prev;
      const rest = prev.replace(/^\/\S*\s*/, "");
      return rest;
    });
    textareaRef.current?.focus();
  };

  const attachMcp = (server: AttachedMcp): void => {
    setAttachedMcps((prev) => {
      if (prev.some((m) => m.name === server.name)) return prev;
      return [...prev, server];
    });
    // 选中后尝试连接，便于本轮对话直接用工具
    void window.api?.mcp?.connect?.(server.name).catch(() => {
      /* 连接失败仍保留芯片，工具可在调用时再连 */
    });
  };

  /** 弹层状态提交并从 DOM 卸载后再恢复输入焦点，避免透明遮罩抢回本轮点击。 */
  const focusComposerAfterPopupClose = (): void => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
  };

  const attachConnector = (connector: LocalConnectorDto): void => {
    // 任务级 Active 连接器：加入当前任务集合（私有技能随下一条消息装配进会话）
    if (!activeConnectorIds.includes(connector.id)) {
      setActiveConnectors([...activeConnectorIds, connector.id]);
    }
    // 配套技能若已在 store，一并挂上输入芯片（私有技能不在全局 store，天然不会重复挂）
    const skillNames = new Set(
      (connector.installedSkillNames ?? []).map((n) => n.toLowerCase()),
    );
    if (skillNames.size > 0) {
      for (const skill of skills) {
        if (!skill.installed) continue;
        const hit =
          skillNames.has(skill.id.toLowerCase()) ||
          skillNames.has(skill.name.toLowerCase()) ||
          (skill.command ? skillNames.has(skill.command.toLowerCase()) : false);
        if (hit) attachSkill(skill);
      }
    }
    textareaRef.current?.focus();
  };

  const attachRefFile = (file: RefFileItem): void => {
    // 发送前再从 store 取最新产物内容/路径，避免列表快照过期
    // 3E：产物直读 projection 派生视图（不再读 task.artifacts）
    const live = selectActiveTaskArtifacts(useAppStore.getState()).find(
      (a) => a.id === file.id || a.name === file.name,
    );
    const path = (live?.path || file.path)?.trim() || undefined;
    // 有 path 走附件读盘；二进制 data URI 绝不塞进 prompt（用调用方给的短说明或兜底文案）
    const liveContent = live?.content;
    const looksBinary =
      Boolean(liveContent?.startsWith("data:")) ||
      Boolean(file.content?.startsWith("data:")) ||
      /\.(png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|pptx?|fcstd|stl|step)$/i.test(
        live?.name || file.name,
      );
    let content: string | undefined;
    if (!path) {
      if (looksBinary) {
        content =
          file.content && !file.content.startsWith("data:")
            ? file.content
            : `（二进制产物 ${live?.name || file.name}；已在产物面板打开，请结合工作区路径读取）`;
      } else {
        content = liveContent || file.content;
      }
    }
    const merged: RefFileItem = {
      ...file,
      name: live?.name || file.name,
      path,
      content,
    };

    setRefFiles((prev) => {
      if (
        prev.some(
          (f) =>
            f.id === merged.id ||
            (merged.path && f.path === merged.path) ||
            f.name === merged.name,
        )
      ) {
        return prev;
      }
      return [...prev, merged];
    });
    // 有磁盘路径的一并作为附件，主进程会提示 Agent 用工具读取
    if (merged.path?.trim()) {
      setAttachments((prev) => {
        if (prev.some((a) => a.path === merged.path || a.name === merged.name)) return prev;
        return [...prev, { name: merged.name, path: merged.path }];
      });
    }
    textareaRef.current?.focus();
  };

  const attachRefTask = (task: RefTaskItem): void => {
    setRefTasks((prev) => {
      if (prev.some((t) => t.id === task.id)) return prev;
      return [...prev, task];
    });
    textareaRef.current?.focus();
  };

  const composerSnapshotRef = useRef<TaskComposerDraft>(emptyTaskComposerDraft());
  composerSnapshotRef.current = {
    text,
    attachments,
    attachedSkills,
    attachedMcps,
    refFiles,
    refTasks,
  };
  const mountedDraftScopeRef = useRef<string | null>(null);

  // 每个 Task 保留自己的未发送正文、文件与引用。切换只换作用域，不再销毁草稿。
  // Prompt Enhance 仍由 hook 按 context.taskId 清理在途结果，避免 A 的异步结果落入 B。
  useLayoutEffect(() => {
    const previousScope = mountedDraftScopeRef.current;
    if (previousScope && previousScope !== draftScope) {
      saveTaskComposerDraft(previousScope, composerSnapshotRef.current);
    }

    const next = loadTaskComposerDraft(draftScope);
    setText(next.text);
    setAttachments(next.attachments);
    setAttachedSkills(next.attachedSkills);
    setAttachedMcps(next.attachedMcps);
    setRefFiles(next.refFiles);
    setRefTasks(next.refTasks);
    setBtwText("");
    composerSnapshotRef.current = next;
    mountedDraftScopeRef.current = draftScope;
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [draftScope]);

  useEffect(() => {
    return () => {
      const scope = mountedDraftScopeRef.current;
      if (scope) saveTaskComposerDraft(scope, composerSnapshotRef.current);
    };
  }, []);

  // 正文变化后收敛高度，避免清空/切任务后残留大块空白
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const maxH = variant === "home" ? 220 : 180;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  }, [text, btwText, variant]);

  // 退出 BTW 时丢弃 BTW 输入草稿（不写回主 composer text）
  useEffect(() => {
    if (!btwActive && btwText) setBtwText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [btwActive]);

  // 产物面板「发送到对话」：挂到 refFile 芯片（有 path 时同步附件），再清空挂起项
  useEffect(() => {
    if (!pendingRefFile) return;
    attachRefFile(pendingRefFile);
    clearPendingRefFile();
    // attachRefFile 每次 render 新引用；只响应 pending 信号
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRefFile, clearPendingRefFile]);

  // 侧栏「分享任务」：挂到 refTask 芯片，再清空挂起项（须在 activeTaskId 清理 effect 之后）
  useEffect(() => {
    if (!pendingRefTask) return;
    attachRefTask(pendingRefTask);
    clearPendingRefTask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRefTask, clearPendingRefTask]);

  useEffect(() => {
    if (!pendingExternalAgentContinuation) return;
    if (pendingExternalAgentContinuation.taskId !== activeTaskId) {
      clearPendingExternalAgentContinuation();
      return;
    }
    setExternalAgent({
      id: pendingExternalAgentContinuation.agentId,
      name: pendingExternalAgentContinuation.agentName,
      protocol: "acp",
      commandLabel: "ACP session",
      continueFromRunId: pendingExternalAgentContinuation.runId,
    });
    setAttachedMcps([]);
    clearPendingExternalAgentContinuation();
  }, [pendingExternalAgentContinuation, activeTaskId, clearPendingExternalAgentContinuation]);

  const send = async (): Promise<void> => {
    if (interruptSendRef.current || (!btwActive && taskCompacting)) return;
    // BTW 激活时：Enter/发送只消费独立草稿 btwText（经纯函数路由，绝不读取主 text）；
    // 主 composer 的 text/附件/引用原样保留，只清空 btwText
    if (btwActive) {
      const payload = btwComposerSendInput(btwActive, btwText);
      if (payload !== null) useBtwStore.getState().send(payload);
      setBtwText("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      return;
    }
    const trimmed = text.trim();
    // 增强进行中禁止发送（Enter 外还有流式 continue 按钮等直调 send() 的入口）：
    // 防止原文与增强结果竞争
    if (enhance.status === "enhancing") return;
    if (
      !trimmed &&
      attachments.length === 0 &&
      attachedSkills.length === 0 &&
      attachedMcps.length === 0 &&
      attachedConnectors.length === 0 &&
      refFiles.length === 0 &&
      refTasks.length === 0 &&
      terminalContext === null &&
      chatSelections.length === 0
    ) {
      return;
    }

    if (variant === "home") {
      // P0 冻结：独立任务不因首页 WorkspacePicker 的 homeSpaceId 被静默绑定。
      // 空间归属仅由 draft.spaceId / 任务自身 spaceId 决定。
      if (pendingExpertId) {
        switchExpert(pendingExpertId);
      }
    }

    // 技能以 /command 前缀发给 Agent（与 slash 调用一致）
    const skillPrefix = attachedSkills.map((s) => `/${s.command}`).join(" ");
    // MCP 以可读提示挂在消息前，工具本身由运行时挂载
    const mcpHint =
      !effectiveExternalAgent && attachedMcps.length > 0
        ? `【使用 MCP：${attachedMcps.map((m) => m.name).join("、")}】`
        : "";
    // 连接器：提示本轮可用的 CLI 通道 + 配套技能名
    const connectorHint =
      !effectiveExternalAgent && attachedConnectors.length > 0
        ? `【使用连接器：${attachedConnectors
            .map((c) =>
              c.skillNames.length > 0
                ? `${c.name}（技能：${c.skillNames.join("、")}）`
                : c.name,
            )
            .join("；")}】`
        : "";
    // 无 path 的引用文件：把内容写入 prompt（有 path 的走附件读盘）
    const fileBlocks = refFiles.filter((f) => !f.path?.trim()).map((f) => buildFileContentBlock(f));
    // 引用任务：对话/空间/文件清单和产出物内容都只作为 Agent 上下文注入，用户气泡只显示摘要。
    const taskBlocks = refTasks.map((ref) => buildTaskReferenceBlock(ref));
    const contextBlocks = [...fileBlocks, ...taskBlocks].filter(Boolean).join("\n\n");
    const referencedAttachments = refTasks.flatMap((task) =>
      (task.files ?? [])
        .filter((file) => file.path?.trim())
        .map((file) => ({ name: file.name, path: file.path! })),
    );
    const allAttachments = mergeAttachments(attachments, referencedAttachments);
    const taskReferences = refTasks.map(toTaskReference);

    let body = trimmed;
    const prefixes = [skillPrefix, mcpHint, connectorHint]
      .filter(Boolean)
      .join(trimmed.includes("\n") ? "\n" : " ");
    if (prefixes) {
      const alreadyHasSkills =
        attachedSkills.length === 0 ||
        attachedSkills.every((s) => {
          const re = new RegExp(
            `(^|\\s)/${s.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`,
          );
          return re.test(trimmed);
        });
      const alreadyHasMcp =
        attachedMcps.length === 0 || trimmed.includes("【使用 MCP：");
      const alreadyHasConnector =
        attachedConnectors.length === 0 || trimmed.includes("【使用连接器：");
      if (alreadyHasSkills && alreadyHasMcp && alreadyHasConnector) {
        body = trimmed;
      } else {
        body = [prefixes, trimmed].filter(Boolean).join(trimmed.includes("\n") ? "\n" : " ");
      }
    }
    if (contextBlocks) {
      const hiddenContext = [
        REFERENCE_CONTEXT_START,
        contextBlocks,
        REFERENCE_CONTEXT_END,
      ].join("\n");
      body = [body, hiddenContext].filter(Boolean).join("\n\n");
    }
    const basePayload =
      body ||
      (allAttachments.length || refFiles.length
        ? "请查看附带/引用的文件"
        : refTasks.length
          ? "请结合引用任务的上下文继续"
          : terminalContext
            ? "请查看附带的终端上下文"
            : chatSelections.length > 0
              ? "请查看附带的页面元素"
              : prefixes) ||
      "";

    if (consultRequested && effectiveExternalAgent) {
      setConsultNotice("当前选择的是外部 Agent，请切回 MyBuddy 主模型或移除多模型会诊标签。");
      return;
    }
    const payload = consultRequested ? requestConsultForMessage(basePayload) : basePayload;

    // 投递计划在任意 await 前一次性算出，防止 intent/Task/executing 在异步间隙漂移
    const plan = resolveStreamingSendPlan(executing, streamingSendMode);

    if (plan.abortBeforeSend) {
      interruptSendRef.current = true;
      try {
        await abortActiveTask();
      } finally {
        interruptSendRef.current = false;
      }
      // 停止期间可能切换 Task 或编辑草稿；不得向新任务发送旧内容或清掉新草稿。
      if (useAppStore.getState().activeTaskId !== activeTaskId || textRef.current !== text) return;
    }

    const streamingBehavior = plan.behavior;

    // sendMessage 可能同步 materialize 新任务并卸载 Home composer；先清缓存与同步镜像，
    // 避免卸载 cleanup 把刚发送的正文/附件重新写回草稿。
    const clearedDraft = emptyTaskComposerDraft();
    clearTaskComposerDraft(draftScope);
    composerSnapshotRef.current = clearedDraft;

    onBeforeSend?.();
    if (onSend) {
      onSend(
        payload,
        allAttachments.length ? allAttachments : undefined,
        taskReferences.length ? taskReferences : undefined,
        streamingBehavior,
        // 任务级 Active 连接器（发送后不清理：连接器随任务持续 active）
        activeConnectorIds,
        externalAgent
          ? { id: externalAgent.id, name: externalAgent.name, protocol: externalAgent.protocol, continueFromRunId: externalAgent.continueFromRunId }
          : undefined,
      );
    } else {
      sendMessage(
        payload,
        allAttachments.length ? allAttachments : undefined,
        taskReferences.length ? taskReferences : undefined,
        streamingBehavior,
        activeConnectorIds,
        undefined,
        externalAgent
          ? { id: externalAgent.id, name: externalAgent.name, protocol: externalAgent.protocol, continueFromRunId: externalAgent.continueFromRunId }
          : undefined,
      );
    }
    setText("");
    setAttachments([]);
    setAttachedSkills([]);
    setAttachedMcps([]);
    setRefFiles([]);
    setRefTasks([]);
    setExternalAgent(null);
    clearConsult();
    // 已发送：显式 reset 增强状态（undo/notice/在途结果不残留到下一轮；
    // activeTaskId 变化时 hook 内部 effect 也会兜底清理）
    enhance.reset();
    // 专家已写入任务，chip 由 task.expertId 在 chat 视图继续展示；首页发送后会离开 home
    if (variant === "home") setPendingExpertId(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const mergeAttachmentList = (incoming: Attachment[]): void => {
    if (!incoming.length) return;
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path ?? a.name));
      const merged = [...prev];
      for (const a of incoming) {
        const key = a.path ?? a.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(a);
      }
      return merged;
    });
  };

  /** 无磁盘 path 的 File（截图粘贴常见）→ 主进程落盘后返回真实路径 */
  const persistBlobFile = async (file: File): Promise<Attachment | null> => {
    if (!window.api?.saveTempFile) return null;
    try {
      const buffer = await file.arrayBuffer();
      if (!buffer.byteLength) return null;
      // 大文件转 base64 用分块，避免 apply 爆栈
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const base64 = btoa(binary);
      const saved = await window.api.saveTempFile({
        name: file.name || (file.type.startsWith("image/") ? "screenshot.png" : "paste.bin"),
        base64,
        mimeType: file.type || undefined,
      });
      if (!saved?.path) return null;
      return { name: saved.name || file.name || "paste.bin", path: saved.path };
    } catch (err) {
      console.warn("[ChatInput] saveTempFile failed", err);
      return null;
    }
  };

  const addFilesFromDrop = (files: FileList | File[]): void => {
    void (async () => {
      const next: Attachment[] = [];
      for (const file of Array.from(files)) {
        const path =
          window.api?.getPathForFile?.(file) ||
          (file as File & { path?: string }).path ||
          "";
        if (path) {
          next.push({ name: file.name || path.split(/[/\\]/).pop() || "file", path });
          continue;
        }
        // 剪贴板截图等：无 path，必须落盘，否则发送时会被 filter 掉，LLM 看不到
        if (file.size > 0 || file.type.startsWith("image/")) {
          const saved = await persistBlobFile(file);
          if (saved) {
            next.push(saved);
            continue;
          }
        }
        // 兜底：仍无 path 时只保留 name（会在气泡显示，但 agent 读不到——尽量避免走到这）
        if (file.name) next.push({ name: file.name });
      }
      mergeAttachmentList(next);
    })();
  };

  const pickAttachment = async (): Promise<void> => {
    const file = await window.api?.pickLocalFile?.();
    if (!file?.name && !file?.path) return;
    const name = file.name || file.path.split(/[/\\]/).pop() || "未命名文件";
    const path = file.path || undefined;
    setAttachments((prev) => {
      if (prev.some((a) => (path && a.path === path) || a.name === name)) return prev;
      return [...prev, { name, path }];
    });
    textareaRef.current?.focus();
  };

  /** 是否有更高层弹层打开：BTW 的 Esc 不得与这些弹层抢（统一 dismiss 语义） */
  const btwOverlayOpen =
    addOpen ||
    permOpen ||
    modelOpen ||
    workspaceOpen ||
    projectOpen ||
    modeOpen ||
    tagOpen ||
    homePermOpen ||
    streamingModeOpen ||
    fullAccessConfirmOpen ||
    slashMatches.length > 0;

  /** Prompt Enhance 触发门控（与公共核心 policy 共用同一纯函数） */
  const gateOk = canTriggerEnhance({
    text,
    context: enhanceContext,
    enhancing: enhance.status === "enhancing",
    btwActive,
  });

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // 仅在 BTW 输入语境下 Esc 关闭，且其它弹层打开时不抢 Esc
    // （useDismissOnClickOutside 在 window 监听 Esc，弹层优先自行关闭）
    if (e.key === "Escape" && btwActive && !btwOverlayOpen) {
      e.preventDefault();
      e.stopPropagation();
      useBtwStore.getState().close();
      return;
    }
    // Prompt Enhance 进行中：Esc 取消/忽略当前请求（结果经 requestId 代际防落地）；
    // 中文 IME 组合输入期间按 Esc 是取消拼音候选，不得误触
    if (e.key === "Escape" && enhance.status === "enhancing" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      enhance.cancelEnhance();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && slashMatches.length === 0) {
      // 增强进行中禁止发送：防止原文与增强结果竞争
      if (enhance.status === "enhancing") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      void send();
    }
    if (e.key === "Tab" && slashMatches.length > 0) {
      e.preventDefault();
      attachSkill(slashMatches[0]!);
    }
  };

  const autoResize = (el: HTMLTextAreaElement): void => {
    const maxH = variant === "home" ? 220 : 180;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  };

  return (
    <div
      className={`input-area ${variant === "home" ? "hero-input" : ""} ${dragOver ? "drag-over" : ""}`}
      onDragEnter={(e) => {
        const fileLike = isFileLikeDrag(e.dataTransfer.types);
        if (!fileLike
          && (!e.dataTransfer.types.includes("text/plain") || isTaskDrag(e.dataTransfer.types))) return;
        setDragOver(true);
        if (!fileLike && e.target === textareaRef.current) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragOver={(e) => {
        const fileLike = isFileLikeDrag(e.dataTransfer.types);
        if (!fileLike
          && (!e.dataTransfer.types.includes("text/plain") || isTaskDrag(e.dataTransfer.types))) return;
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
        // Native dragover positions the textarea caret for the subsequent drop.
        if (!fileLike && e.target === textareaRef.current) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.stopPropagation();
        setDragOver(false);
        if (!isFileLikeDrag(e.dataTransfer.types)
          && e.dataTransfer.types.includes("text/plain") && !isTaskDrag(e.dataTransfer.types)) {
          // Textarea native drop inserts at the mouse caret and fires onChange.
          if (e.target === textareaRef.current) return;
          e.preventDefault();
          const dropped = e.dataTransfer.getData("text/plain");
          const el = textareaRef.current;
          if (!dropped || !el) return;
          const { value, selectionStart, selectionEnd } = el;
          const next = value.slice(0, selectionStart) + dropped + value.slice(selectionEnd);
          if (next === value) {
            el.focus();
            el.setSelectionRange(selectionStart + dropped.length, selectionStart + dropped.length);
            return;
          }
          droppedTextCaret.current = selectionStart + dropped.length;
          if (btwActive) setBtwText(next);
          else setText(next);
          return;
        }
        e.preventDefault();
        // BTW 临时对话仅文本：拖入文件不挂载到主 composer（避免静默忽略）
        if (btwActive) return;
        const workspacePaths = pathsFromWorkspaceDrop(e);
        if (workspacePaths.length) {
          mergeAttachmentList(
            workspacePaths.map((path) => ({ name: fileNameFromPath(path), path })),
          );
          return;
        }
        if (e.dataTransfer.files?.length) addFilesFromDrop(e.dataTransfer.files);
      }}
    >
      {showExecPermBar && (
        <div className="exec-perm-bar">
          <div className="exec-perm-title">{execLabel}</div>
          <div className="exec-perm-row">
            <span>允许完全访问</span>
            <button
              type="button"
              className={`switch ${fullAccess ? "on danger" : ""}`}
              onClick={() => {
                if (fullAccess) {
                  setPermissionMode("default");
                  setExecPermDismissed(true);
                } else {
                  setFullAccessConfirmOpen(true);
                }
              }}
              title={fullAccess ? "关闭后恢复默认权限" : "开启允许完全访问"}
              role="switch"
              aria-checked={fullAccess}
              aria-label="允许完全访问"
            />
          </div>
        </div>
      )}

      {slashMatches.length > 0 && (
        <div className="slash-menu">
          <div className="slash-menu-title">技能命令（Tab 补全）</div>
          {slashMatches.map((skill) => (
            <button
              key={skill.id}
              className="slash-item"
              onClick={() => attachSkill(skill)}
            >
              <span>{skill.icon}</span>
              <span className="slash-item-cmd">/{skill.command}</span>
              <span className="slash-item-desc">
                {skill.name} — {skill.description}
              </span>
            </button>
          ))}
        </div>
      )}

      {btwActive && (
        <BtwPanel
          overlayOpen={btwOverlayOpen}
          pendingMainItems={
            attachments.length > 0 ||
            attachedSkills.length > 0 ||
            attachedMcps.length > 0 ||
            attachedConnectors.length > 0 ||
            refFiles.length > 0 ||
            refTasks.length > 0 ||
            terminalContext !== null ||
            chatSelections.length > 0
          }
        />
      )}
      {consultNotice && <div className="consult-composer-notice" role="status">
        <span>{consultNotice}</span>{" "}
        {consultNeedsConfiguration
          ? <button type="button" className="btn btn--small" data-testid="consult-configure" onClick={openConsultConfiguration}>配置会诊</button>
          : <button type="button" className="btn btn--small" data-testid="consult-retry" onClick={() => void selectConsult()}>重试</button>}
      </div>}
      <div className="input-box">
        {(hasAttachChips || showStreamingMode) && (
          <div className="input-top-row">
        {hasAttachChips && (
          <div className="input-attach-chips">
            {consultRequested && <span className="attach-chip" data-testid="consult-chip" title="仅当前消息；由主模型显式调用会诊工具">
              <IconUsers size={13} /><span className="attach-chip-name">多模型会诊 · 本条</span>
              <button type="button" className="attach-chip-x" aria-label="移除多模型会诊" onClick={() => { clearConsult(); }}><IconX size={12} /></button>
            </span>}
            {chatSelections.map((selection) => (
              <span
                key={`${selection.artifactId}:${selection.artifactVersion}:${selection.surfaceGeneration}:${selection.backendNodeId ?? "none"}`}
                className={`attach-chip file-chip selection-chip${selection.status === "stale" ? " stale" : ""}`}
                title={`抓取元素：${selection.label}${selection.comment ? `\n备注：${selection.comment}\n` : ""}${selection.status === "stale" ? "（已失效：页面已更新，发送时不会携带）" : "（发送时作为元素上下文随消息交给 Agent）"}`}
              >
                <span className="skill-chip-icon" aria-hidden>
                  <IconTarget size={13} />
                </span>
                <span className="attach-chip-name">{selection.label}{selection.comment ? `：${selection.comment}` : ""}</span>
                {selection.status === "stale" && (
                  <span className="selection-chip-state">已失效</span>
                )}
                <button
                  type="button"
                  className="attach-chip-x"
                  aria-label={`移除元素选择 ${selection.label}`}
                  onClick={() => clearChatSelection(selection)}
                >
                  <IconX size={12} />
                </button>
              </span>
            ))}
            {terminalContext && (
              <span
                key="chat-terminal-context"
                className="attach-chip file-chip terminal-chip"
                title={`终端上下文（${terminalContext.source === "selection" ? "选中文本" : "最近输出"}）：发送时作为显式参考上下文随消息交给 Agent，不自动收集终端输出`}
              >
                <span className="skill-chip-icon" aria-hidden>
                  <IconCode size={13} />
                </span>
                <span className="attach-chip-name">
                  终端 · {terminalContext.text.length} 字符
                </span>
                <button
                  type="button"
                  className="attach-chip-x"
                  aria-label="移除终端上下文"
                  onClick={() => clearTerminalContext()}
                >
                  <IconX size={12} />
                </button>
              </span>
            )}
            {attachedSkills.map((s) => (
              <span key={s.id} className="skill-chip" title={s.name !== s.command ? s.name : s.command}>
                <span className="skill-chip-icon" aria-hidden>
                  {s.icon && s.icon.length <= 2 ? s.icon : <IconSparkles size={13} />}
                </span>
                <span className="skill-chip-name">{s.command || s.name}</span>
                <button
                  type="button"
                  className="attach-chip-x"
                  aria-label={`移除技能 ${s.name}`}
                  onClick={() => setAttachedSkills((prev) => prev.filter((x) => x.id !== s.id))}
                >
                  <IconX size={12} />
                </button>
              </span>
            ))}
            {attachedMcps.map((m) => (
              <span
                key={m.name}
                className="mcp-chip"
                title={m.endpoint ? `${m.name} · ${m.endpoint}` : m.name}
              >
                <span className="skill-chip-icon" aria-hidden>
                  <IconBlocks size={13} />
                </span>
                <span className="skill-chip-name">{m.name}</span>
                <button
                  type="button"
                  className="attach-chip-x"
                  aria-label={`移除 MCP ${m.name}`}
                  onClick={() => setAttachedMcps((prev) => prev.filter((x) => x.name !== m.name))}
                >
                  <IconX size={12} />
                </button>
              </span>
            ))}
            {attachedConnectors.map((c) => (
              <span
                key={c.id}
                className="mcp-chip"
                title={
                  c.skillNames.length > 0
                    ? `连接器 ${c.name} · 技能 ${c.skillNames.join("、")}`
                    : `连接器 ${c.name}`
                }
              >
                <span className="skill-chip-icon" aria-hidden>
                  <IconLink size={13} />
                </span>
                <span className="skill-chip-name">{c.name}</span>
                <button
                  type="button"
                  className="attach-chip-x"
                  aria-label={`移除连接器 ${c.name}`}
                  onClick={() =>
                    setActiveConnectors(activeConnectorIds.filter((x) => x !== c.id))
                  }
                >
                  <IconX size={12} />
                </button>
              </span>
            ))}
            {externalAgent && (
              <span
                className="skill-chip"
                title={`${externalAgent.name} · ACP · ${externalAgent.commandLabel}`}
              >
                <span className="skill-chip-icon" aria-hidden><IconBot size={13} /></span>
                <span className="skill-chip-name">{externalAgent.name} · ACP</span>
                <button
                  type="button"
                  className="attach-chip-x"
                  aria-label={`Remove external agent ${externalAgent.name}`}
                  onClick={() => setExternalAgent(null)}
                >
                  <IconX size={12} />
                </button>
              </span>
            )}
            {!externalAgent && pinnedAgent && (
              <span className="skill-chip acp-pin-chip" ref={pinChipRef}>
                <button
                  type="button"
                  className="acp-pin-trigger"
                  title={`${pinnedAgent.name} · ACP · 已固定：本任务每轮自动续接最近会话`}
                  aria-expanded={pinMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setPinMenuOpen((v) => !v)}
                >
                  <span className="skill-chip-icon" aria-hidden><IconPin size={11} /></span>
                  <span className="skill-chip-name">{pinnedAgent.name} · ACP</span>
                </button>
                {pinMenuOpen && (
                  <div className="streaming-mode-menu acp-pin-menu" role="menu">
                    <button
                      type="button"
                      className="streaming-mode-item"
                      role="menuitem"
                      onClick={() => {
                        // 本轮新会话 = 同 agent 的瞬态选择（不带续链）；发完自动回 pin。
                        setExternalAgent({
                          id: pinnedAgent.id,
                          name: pinnedAgent.name,
                          protocol: "acp",
                          commandLabel: "本轮新会话",
                        });
                        setPinMenuOpen(false);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span>本轮新会话</span>
                      <small>仅此一轮开启新 ACP 会话；固定保留，后续轮次自动续接新会话</small>
                    </button>
                    <button
                      type="button"
                      className="streaming-mode-item danger"
                      role="menuitem"
                      onClick={() => {
                        setExternalAgentPin(null);
                        setPinMenuOpen(false);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span>解除固定</span>
                      <small>恢复 MyBuddy 主 Agent；仍可在「+」菜单单轮选用外部 Agent</small>
                    </button>
                  </div>
                )}
              </span>
            )}
            {refTasks.map((t) => {
              const fileCount = t.files?.length ?? 0;
              const sourceLabel = [
                t.spaceName ? `来源：${t.spaceName}` : "任务",
                fileCount > 0 ? `${fileCount} 个文件` : "无文件",
              ].join(" · ");
              return (
                <span
                  key={t.id}
                  className="task-ref-chip"
                  title={`引用任务：${t.title}${t.spaceName ? ` · 来源空间：${t.spaceName}` : ""}${fileCount > 0 ? ` · ${fileCount} 个文件` : ""}`}
                >
                  <span className="skill-chip-icon" aria-hidden>
                    <IconList size={13} />
                  </span>
                  <span className="task-ref-chip-body">
                    <span className="task-ref-chip-name">{t.title}</span>
                    <span className="task-ref-chip-meta">{sourceLabel}</span>
                  </span>
                  <button
                    type="button"
                    className="attach-chip-x"
                    aria-label={`移除任务引用 ${t.title}`}
                    onClick={() => setRefTasks((prev) => prev.filter((x) => x.id !== t.id))}
                  >
                    <IconX size={12} />
                  </button>
                </span>
              );
            })}
            {refFiles.map((f) => {
              const label = shortFileLabel(f.name, f.path);
              return (
              <span key={f.id} className="attach-chip file-chip ref-file-chip" title={f.path ?? f.name}>
                <span className="skill-chip-icon" aria-hidden>
                  <IconAt size={12} />
                </span>
                <FileBadge name={label} size={16} />
                <span className="attach-chip-name">{label}</span>
                <button
                  type="button"
                  className="attach-chip-x"
                  aria-label={`移除引用 ${label}`}
                  onClick={() => {
                    setRefFiles((prev) => prev.filter((x) => x.id !== f.id));
                    // 同步去掉因引用而挂上的同名 path 附件
                    if (f.path) {
                      setAttachments((prev) => prev.filter((a) => a.path !== f.path));
                    }
                  }}
                >
                  <IconX size={12} />
                </button>
              </span>
              );
            })}
            {attachments
              .filter((a) => !refFiles.some((f) => f.path && f.path === a.path))
              .map((a) => {
              const label = shortFileLabel(a.name, a.path);
              const dragPath = a.path?.trim() || "";
              const dragEnabled = Boolean(dragPath) && typeof window.api?.startNativeDrag === "function";
              return (
              <span
                key={a.path ?? a.name}
                className={`attach-chip file-chip${dragEnabled ? " is-draggable" : ""}`}
                title={
                  dragEnabled
                    ? `${a.path}\n可拖到桌面或其它应用`
                    : (a.path ?? a.name)
                }
                draggable={dragEnabled}
                onDragStart={(e) => {
                  if (!dragEnabled) {
                    e.preventDefault();
                    return;
                  }
                  e.preventDefault();
                  window.api?.startNativeDrag?.(dragPath);
                }}
              >
                <FileBadge name={label} size={16} />
                <span className="attach-chip-name">{label}</span>
                <button
                  type="button"
                  className="attach-chip-x"
                  aria-label={`移除文件 ${label}`}
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                  onClick={() =>
                    setAttachments((prev) =>
                      prev.filter((x) => (x.path ?? x.name) !== (a.path ?? a.name)),
                    )
                  }
                >
                  <IconX size={12} />
                </button>
              </span>
              );
            })}
          </div>
        )}
        {showStreamingMode && (
          <div className="streaming-composer-bar">
            <div className="streaming-composer-actions" ref={streamingModeAnchorRef}>
              <button
                type="button"
                className="streaming-mode-trigger"
                aria-expanded={streamingModeOpen}
                aria-haspopup="menu"
                onClick={() => {
                  setPermOpen(false);
                  setModelOpen(false);
                  setAddOpen(false);
                  setWorkspaceOpen(false);
                  setHomePermOpen(false);
                  setStreamingModeOpen((v) => !v);
                }}
                title={STREAMING_SEND_MODE_DESCRIPTIONS[streamingSendMode]}
              >
                <IconLink size={13} />
                <span>{STREAMING_SEND_MODE_LABELS[streamingSendMode]}</span>
                <IconChevronDown size={12} />
              </button>
              {streamingModeOpen && (
                <div className="streaming-mode-menu" role="menu">
                  {(["continue", "steer", "interrupt"] as StreamingSendMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`streaming-mode-item${streamingSendMode === mode ? " active" : ""}`}
                      role="menuitem"
                      onClick={() => {
                        setStreamingSendMode(mode);
                        setStreamingModeOpen(false);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span>{STREAMING_SEND_MODE_LABELS[mode]}</span>
                      <small>{STREAMING_SEND_MODE_DESCRIPTIONS[mode]}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="input-textarea"
          rows={variant === "home" ? 3 : 2}
          placeholder={
            btwActive
              ? "临时问一句…"
              : attachedSkills.length > 0 ||
                  attachedMcps.length > 0 ||
                  attachedConnectors.length > 0 ||
                  attachments.length > 0 ||
                  refFiles.length > 0 ||
                  refTasks.length > 0 ||
                  terminalContext !== null ||
                  chatSelections.length > 0
                ? "补充说明（可选），或直接发送"
                : variant === "home"
                  ? heroPlaceholder(welcomeMode, resolvedPresetId)
                  : "继续，或 @ / 拖入文件"
          }
          value={btwActive ? btwText : text}
          onChange={(e) => {
            // BTW 激活时写入独立 btwText，绝不触碰主 composer 草稿
            if (btwActive) {
              setBtwText(e.target.value);
            } else {
              setText(e.target.value);
            }
            autoResize(e.target);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const dt = e.clipboardData;
            if (!dt) return;
            // BTW 临时对话仅文本：粘贴图片/文件不挂载到主 composer（文本粘贴不受影响）
            if (btwActive) return;
            // 优先 files；部分环境截图只在 items 里
            const fromFiles = dt.files && dt.files.length > 0 ? Array.from(dt.files) : [];
            const fromItems: File[] = [];
            if (dt.items?.length) {
              for (const item of Array.from(dt.items)) {
                if (item.kind !== "file") continue;
                const f = item.getAsFile();
                if (f) fromItems.push(f);
              }
            }
            const files = fromFiles.length ? fromFiles : fromItems;
            if (files.length > 0) {
              e.preventDefault();
              addFilesFromDrop(files);
            }
          }}
        />
        <div className="input-toolbar">
          <div className="input-popup-anchor add-menu-anchor" ref={addAnchorRef}>
            <button
              className={`input-tool-btn ${addOpen ? "active" : ""}`}
              title={btwActive ? "BTW 临时对话仅支持文本" : "添加"}
              disabled={btwActive}
              aria-expanded={addOpen}
              aria-haspopup="menu"
              onClick={() => {
                setPermOpen(false);
                setModelOpen(false);
                setWorkspaceOpen(false);
                setHomePermOpen(false);
                setStreamingModeOpen(false);
                setAddOpen(!addOpen);
              }}
            >
              <IconPlus size={16} />
            </button>
            {addOpen && (
              <InputAddMenu
                anchorRef={addAnchorRef}
                rootRef={addMenuRootRef}
                onClose={() => setAddOpen(false)}
                selectedExpertId={pendingExpertId}
                onAttachFile={() => {
                  setAddOpen(false);
                  void pickAttachment();
                }}
                onSelectSkill={(skill) => {
                  attachSkill(skill);
                  setAddOpen(false);
                }}
                onSelectMcp={(server) => {
                  setAddOpen(false);
                  attachMcp(server);
                  focusComposerAfterPopupClose();
                }}
                onSelectRefFile={(file) => {
                  attachRefFile(file);
                  setAddOpen(false);
                }}
                onSelectRefTask={(task) => {
                  attachRefTask(task);
                  setAddOpen(false);
                }}
                onSelectExpert={(expertId) => {
                  attachExpert(expertId);
                  setAddOpen(false);
                }}
                onSelectConnector={(connector) => {
                  attachConnector(connector);
                  setAddOpen(false);
                }}
                onSelectConsult={() => { setAddOpen(false); void selectConsult(); }}
                consultDisabled={Boolean(effectiveExternalAgent)}
                onSelectExternalAgent={(agent) => {
                  clearConsult();
                  setExternalAgent({ id: agent.id, name: agent.name, protocol: agent.protocol, commandLabel: agent.commandLabel });
                  // MyBuddy MCP chips currently belong to Pi runtime; do not imply they are mounted in ACP.
                  setAttachedMcps([]);
                  setAddOpen(false);
                  focusComposerAfterPopupClose();
                }}
                onPinExternalAgent={(agent) => {
                  clearConsult();
                  // 任务级持久 pin：草稿态写入 draft，随首条消息落库；有任务时直接写 tasks 表
                  setExternalAgentPin({ id: agent.id, name: agent.name, pinnedAt: Date.now() });
                  setExternalAgent(null);
                  setAttachedMcps([]);
                  setAddOpen(false);
                  focusComposerAfterPopupClose();
                }}
              />
            )}
          </div>
          {canBtw && (
            <button
              type="button"
              className={`input-tool-btn btw-trigger${btwActive ? " active" : ""}`}
              title={
                btwActive
                  ? "退出 BTW 临时对话（关闭即销毁）"
                  : "BTW：基于当前对话临时问一句，不进入主线"
              }
              aria-label={
                btwActive
                  ? "退出 BTW 临时对话"
                  : "BTW 临时对话（不进入主线）"
              }
              aria-pressed={btwActive}
              onClick={() => {
                if (btwActive) {
                  useBtwStore.getState().close();
                } else {
                  // 进入 BTW 前收起其它弹层，避免与 BTW 状态条叠加；
                  // 并清增强态（reset：在途结果失效 + 清 undo/notice）——增强结果
                  // 不得写入 BTW 模式下被隐藏的主草稿
                  setAddOpen(false);
                  setPermOpen(false);
                  setModelOpen(false);
                  setStreamingModeOpen(false);
                  enhance.reset();
                  useBtwStore.getState().start();
                }
              }}
            >
              <IconBtw size={16} />
            </button>
          )}
          {selectedExpert && (
            <span
              className="input-expert-chip"
              title={`专家：${selectedExpert.name}（点击 × 取消）`}
            >
              <span className="input-expert-chip-emoji" aria-hidden>
                {selectedExpert.emoji || "🧙"}
              </span>
              <span className="input-expert-chip-name">{selectedExpert.name}</span>
              <button
                type="button"
                className="attach-chip-x"
                aria-label={`取消专家 ${selectedExpert.name}`}
                onClick={clearExpert}
              >
                <IconX size={12} />
              </button>
            </span>
          )}
          {variant !== "home" && welcomeMode !== "bot" && (
            <HomePermissionPicker
              compact
              quiet
              open={permOpen}
              onToggle={() => {
                setModelOpen(false);
                setAddOpen(false);
                setWorkspaceOpen(false);
                setHomePermOpen(false);
                setStreamingModeOpen(false);
                setPermOpen(!permOpen);
              }}
              onClose={() => setPermOpen(false)}
              onAfterChange={() => {
                if (executing) setExecPermDismissed(true);
              }}
            />
          )}
          <div className="input-spacer" />
          {variant !== "home" && activeTaskId && (
            <GenerationSpeed taskId={activeTaskId} btw={btwActive} />
          )}
          {welcomeMode === "bot" && variant === "chat" && <TagPicker open={tagOpen} onToggle={() => setTagOpen(!tagOpen)} onClose={() => setTagOpen(false)} />}
          {welcomeMode === "bot" ? <PiCodeModeChip taskId={activeTaskId ?? undefined} welcomeMode="bot" /> : variant !== "home" && <ContextUsageControl executing={executing} />}
          <div className="input-popup-anchor" ref={modelAnchorRef}>

            <button
              type="button"
              className="pill-select ghost as-btn model-trigger"
              title={activeModel?.name ?? "选择模型"}
              aria-label={activeModel?.name ?? "选择模型"}
              aria-expanded={modelOpen}
              aria-haspopup="listbox"
              onClick={() => {
                void useAppStore.getState().refreshModelConfiguration();
                setPermOpen(false);
                setAddOpen(false);
                setWorkspaceOpen(false);
                setHomePermOpen(false);
                setStreamingModeOpen(false);
                setModelOpen(!modelOpen);
              }}
            >
              {activeModel && (
                <ModelBrandIcon modelName={activeModel.name} vendor={activeModel.vendor} size={16} />
              )}
              <span className="model-trigger-label">
                {activeModel?.name ?? "选择模型"}
              </span>
              <IconChevronDown size={12} className="model-trigger-chevron" />
            </button>
            {modelOpen && (
              <div
                className="input-popup model-popup"
                ref={modelPopupRef}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="model-max-row">
                  <span className="model-max-label">
                    <span className="model-max-icon">M</span>
                    Max 模式
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={maxMode}
                    aria-label="Max 模式"
                    className={`switch model-max-switch ${maxMode ? "on" : ""}`}
                    onClick={() => setMaxMode((value) => !value)}
                  />
                </div>
                <div className="model-options" ref={modelOptionsRef}>
                  {/* F2：显式模型标记的复位路径 —— 跟随 Tag/Mode 建议（不写全局默认） */}
                  <button
                    type="button"
                    className={`model-option follow-suggestion ${!modelExplicit ? "active" : ""}`}
                    title={
                      modelExplicit
                        ? "清除本任务显式模型选择，改由 Tag/Mode 建议（可解析时）或默认链决定"
                        : "当前未显式选择：模型由 Tag/Mode 建议或默认链决定"
                    }
                    onClick={() => void followSuggestedModel()}
                  >
                    <IconSparkles size={15} className="model-option-icon" />
                    <span className="model-option-name">
                      {modelExplicit ? "跟随场景建议（Tag/Mode）" : "跟随场景建议 · 未显式选择"}
                    </span>
                    {!modelExplicit && <IconCheck size={14} className="model-option-check" />}
                  </button>
                  {availableModels.map((m) => {
                    const selected = m.id === activeModelId;
                    const canThink = canThinkOn(m);
                    const showFlyout = hoverModelId === m.id && canThink;
                    return (
                      <div
                        key={m.id}
                        className={`model-option-wrap ${showFlyout ? "flyout-open" : ""}`}
                        onMouseEnter={(e) => {
                          if (canThink) openThinkingFlyout(m.id, e.currentTarget);
                        }}
                        onMouseLeave={scheduleCloseThinkingFlyout}
                      >
                        <button
                          type="button"
                          className={`model-option ${selected ? "active" : ""}`}
                          onClick={() => {
                            setActiveModel(m.id);
                            // 有思考档：保持面板打开，便于接着调强度；无思考档：选完即收
                            if (!canThink) closeAllPopups();
                          }}
                        >
                          <ModelBrandIcon modelName={m.name} vendor={m.vendor} size={16} />
                          <span className="model-option-name">{m.name}</span>
                          {selected && <IconCheck size={14} className="model-option-check" />}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="input-popup-config"
                  onClick={() => {
                    setSettingsOpen(true, "models");
                    setModelOpen(false);
                    setHoverModelId(null);
                    setFlyoutPos(null);
                    setDetailPos(null);
                    setThinkingDetailOpen(false);
                  }}
                >
                  <IconPencil size={14} /> 配置自定义模型
                </button>
              </div>
            )}
            {modelOpen &&
              (() => {
                const hoverModel = availableModels.find((m) => m.id === hoverModelId);
                if (!hoverModel || !flyoutPos || typeof document === "undefined") return null;
                const options = reasoningOptionsForModel(hoverModel);
                if (!hoverModel.supportsReasoning || options.length === 0) return null;
                const selected = hoverModel.id === activeModelId;
                const preference = modelPreferences[hoverModel.id]?.reasoning;
                const effortValues = reasoningEffortValues(options);
                const hasToggle = hasReasoningOption(options, "toggle");
                const budgetOption = options.find((option) => option.type === "budget_tokens");
                const summary = reasoningPreferenceSummary(preference, hoverModel.metadata);
                const thinkingOn =
                  preference?.enabled === false || preference?.effort === "none"
                    ? false
                    : true;
                const keepFlyout = (): void => {
                  if (hoverLeaveTimer.current) {
                    clearTimeout(hoverLeaveTimer.current);
                    hoverLeaveTimer.current = null;
                  }
                };
                const applyPreference = (next: typeof preference, close = false): void => {
                  if (!selected) setActiveModel(hoverModel.id);
                  setModelReasoningPreference(hoverModel.id, next);
                  if (close) closeAllPopups();
                };
                return (
                  <>
                    {createPortal(
                      <div
                        ref={thinkingFlyoutRef}
                        className="model-thinking-flyout"
                        style={{ top: flyoutPos.top, left: flyoutPos.left }}
                        onMouseEnter={keepFlyout}
                        onMouseLeave={scheduleCloseThinkingFlyout}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="model-thinking-title" title={hoverModel.name}>
                          {hoverModel.name}
                        </div>
                        <div className="model-thinking-divider" />
                        <button
                          ref={thinkingEntryRef}
                          type="button"
                          className={`model-thinking-entry ${thinkingDetailOpen ? "open" : ""}`}
                          onMouseEnter={() => setThinkingDetailOpen(true)}
                          onClick={() => setThinkingDetailOpen(true)}
                        >
                          <span>思考偏好</span>
                          <span className="model-thinking-entry-val">
                            <span className="model-thinking-entry-key">{summary}</span>
                            <IconChevronDown
                              size={12}
                              style={{ transform: "rotate(-90deg)" }}
                            />
                          </span>
                        </button>
                      </div>,
                      document.body,
                    )}
                    {thinkingDetailOpen &&
                      createPortal(
                        <div
                          ref={thinkingDetailRef}
                          className="model-thinking-flyout model-thinking-detail"
                          style={{
                            top: detailPos?.top ?? 0,
                            left: detailPos?.left ?? 0,
                            visibility: detailPos ? "visible" : "hidden",
                          }}
                          onMouseEnter={keepFlyout}
                          onMouseLeave={scheduleCloseThinkingFlyout}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="model-thinking-level"
                            onClick={() => applyPreference(undefined, true)}
                          >
                            <span className="model-thinking-level-key">模型默认</span>
                            {!preference && <IconCheck size={14} />}
                          </button>

                          {hasToggle && (
                            <div className="model-thinking-row">
                              <span>Reasoning</span>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={thinkingOn}
                                aria-label="Reasoning"
                                className={`switch model-max-switch ${thinkingOn ? "on" : ""}`}
                                onClick={() => applyPreference({
                                  ...(preference ?? {}),
                                  enabled: !thinkingOn,
                                })}
                              />
                            </div>
                          )}

                          {effortValues.length > 0 && (
                            <>
                              <div className="model-thinking-section-label">{hoverModel.metadata?.reasoningControl === "toggle" ? "思考开关" : "Effort"}</div>
                              <div className="model-thinking-levels">
                                {effortValues.map((effort) => (
                                  <button
                                    type="button"
                                    key={effort}
                                    className={`model-thinking-level ${preference?.effort === effort ? "active" : ""}`}
                                    onClick={() => applyPreference({
                                      ...(preference ?? {}),
                                      ...(hasToggle ? { enabled: effort === "none" ? false : true } : {}),
                                      effort,
                                    }, true)}
                                  >
                                    <span className="model-thinking-level-key">
                                      {reasoningEffortLabel(effort, hoverModel.metadata)}
                                    </span>
                                    {preference?.effort === effort && <IconCheck size={14} />}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}

                          {budgetOption && (
                            <>
                              <div className="model-thinking-section-label">Budget Tokens</div>
                              <div className="model-thinking-row">
                                <input
                                  type="number"
                                  min={budgetOption.min}
                                  max={budgetOption.max}
                                  value={preference?.budgetTokens ?? ""}
                                  placeholder="模型默认"
                                  onChange={(event) => {
                                    const raw = event.target.value;
                                    applyPreference({
                                      ...(preference ?? {}),
                                      ...(hasToggle ? { enabled: true } : {}),
                                      budgetTokens: raw ? Number(raw) : undefined,
                                    });
                                  }}
                                />
                              </div>
                              <div className="model-thinking-section-label">
                                {budgetOption.min != null || budgetOption.max != null
                                  ? `${budgetOption.min ?? "?"} – ${budgetOption.max ?? "?"}`
                                  : "模型未声明范围"}
                              </div>
                            </>
                          )}
                        </div>,
                        document.body,
                      )}
                  </>
                );
              })()}
          </div>
          {/* Prompt Enhance：工具栏内只放一个图标。
              无字默认隐藏；增强后 ✨ 换成恢复图标，hover 才出「恢复原文」。 */}
          <PromptEnhanceControl
            status={enhance.status}
            notice={enhance.notice}
            canUndo={enhance.undo != null && textRef.current === enhance.undo.applied}
            surface={enhanceContext.surface}
            disabled={!gateOk}
            empty={!text.trim()}
            onEnhance={() => enhance.requestEnhance(text, activeModelId)}
            onUndo={() => enhance.undoEnhance(text)}
          />
          {executing ? (
            <>
              {/* BTW 激活时隐藏主任务 continue/steer 按钮：Enter 一律走 BTW session，
                  避免按钮语义与实际路由不一致；主任务 stop 按钮保留（显式主任务控制）。
                  Enhance 进行中同样隐藏：continue 不得与增强并发（send() 内部另有防御） */}
              {hasStreamingDraft && !btwActive && !effectiveExternalAgent && enhance.status !== "enhancing" && (
                <button
                  type="button"
                  className="send-btn"
                  onClick={() => void send()}
                  title={`${STREAMING_SEND_MODE_LABELS[streamingSendMode]} (Enter)`}
                  aria-label={STREAMING_SEND_MODE_LABELS[streamingSendMode]}
                >
                  <IconArrowUp size={16} />
                </button>
              )}
              <button
                type="button"
                className="send-btn stop-btn"
                onClick={() => void abortActiveTask()}
                title="停止生成"
                aria-label="停止生成"
              >
                <IconStop size={14} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="send-btn"
              disabled={
                (!btwActive && taskCompacting) || enhance.status === "enhancing" ||
                (btwActive
                  ? btwStreaming || !btwText.trim()
                  : !text.trim() &&
                    attachments.length === 0 &&
                    attachedSkills.length === 0 &&
                    attachedMcps.length === 0 &&
                    attachedConnectors.length === 0 &&
                    refFiles.length === 0 &&
                    refTasks.length === 0 &&
                    terminalContext === null &&
                    chatSelections.length === 0)
              }
              onClick={() => void send()}
              title="发送 (Enter)"
            >
              <IconArrowUp size={16} />
            </button>
          )}
        </div>
        {variant === "home" && (
          <div className="input-context-bar">
            <WorkspacePicker
              mode="draft-workspace"
              open={workspaceOpen}
              onToggle={() => {
                setWorkspaceOpen(!workspaceOpen);
                setProjectOpen(false);
                setHomePermOpen(false);
              }}
              onClose={() => setWorkspaceOpen(false)}
            />
            <ProjectPicker
              open={projectOpen}
              onToggle={() => {
                setProjectOpen(!projectOpen);
                setWorkspaceOpen(false);
                setHomePermOpen(false);
              }}
              onClose={() => setProjectOpen(false)}
            />
            {welcomeMode !== "bot" && <HomePermissionPicker
              quiet
              open={homePermOpen}
              onToggle={() => {
                setHomePermOpen(!homePermOpen);
                setWorkspaceOpen(false);
                setProjectOpen(false);
              }}
              onClose={() => setHomePermOpen(false)}
            />}
          </div>
        )}
      </div>

      {variant === "project" ? (
        <div className="input-below-pills">
          <WorkspacePicker
            mode="draft-workspace"
            open={workspaceOpen}
            onToggle={() => {
              setWorkspaceOpen(!workspaceOpen);
              setModeOpen(false);
              setTagOpen(false);
            }}
            onClose={() => setWorkspaceOpen(false)}
          />
          <ModePicker
            open={modeOpen}
            onToggle={() => {
              setModeOpen(!modeOpen);
              setWorkspaceOpen(false);
              setTagOpen(false);
            }}
            onClose={() => setModeOpen(false)}
          />
          <TagPicker
            open={tagOpen}
            onToggle={() => {
              setTagOpen(!tagOpen);
              setWorkspaceOpen(false);
              setModeOpen(false);
            }}
            onClose={() => setTagOpen(false)}
          />
        </div>
      ) : null}

      {/* 添加菜单已有 window capture click-outside；不要再用全屏透明层阻断输入。 */}
      {(permOpen || modelOpen || workspaceOpen || projectOpen || modeOpen || tagOpen || homePermOpen) && (
        <div className="input-popup-backdrop" onClick={closeAllPopups} />
      )}

      <FullAccessConfirmModal
        open={fullAccessConfirmOpen}
        onCancel={() => setFullAccessConfirmOpen(false)}
        onConfirm={() => {
          setPermissionMode("auto");
          setFullAccessConfirmOpen(false);
          setExecPermDismissed(true);
        }}
      />
    </div>
  );
}
