import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useActiveTaskArtifacts, useAppStore } from "@/store/appStore";
import {
  collectTaskDomainArtifacts,
  type RefFileItem,
} from "@/lib/refTaskArtifacts";
import type { RefTaskItem, RefTaskMessage } from "@/lib/taskReference";
import type { Artifact, Skill, Task } from "@/types";

export type { RefFileItem } from "@/lib/refTaskArtifacts";
export type { RefTaskItem, RefTaskMessage } from "@/lib/taskReference";
import type { LocalConnectorDto, McpServerDto, ModeMcpPolicy, ModeProfileDto, ModeSkillPolicy } from "@shared/agent-ipc";
import type { ExternalAgentDescriptorDto } from "@shared/external-agent";
import { loadExternalAgentCatalog, useExternalAgentCatalog } from "@/lib/externalAgentCatalog";
import {
  isMcpVisibleForMode,
  isSkillVisibleForMode,
  sortSkillsByModePolicy,
} from "@shared/mode-access-filter";
import { emptyModePolicy, resolveEffectiveModePolicy, resolveModePreset } from "@shared/mode-profile";
import { FileBadge } from "@/components/common/FileBadge";
import {
  IconAt,
  IconBlocks,
  IconBook,
  IconBot,
  IconChevronRight,
  IconFolder,
  IconLink,
  IconList,
  IconPin,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconUpload,
  IconUsers,
} from "@/components/common/icons";

type SubMenu =
  | "file"
  | "refTask"
  | "ref"
  | "expert"
  | "skill"
  | "mcp"
  | "connector"
  | "externalAgent"
  | null;

interface Props {
  contextMode?: "bot";
  onClose: () => void;
  onSelectConsult?: () => void;
  consultDisabled?: boolean;
  onAttachFile?: () => void;
  onSelectSkill?: (skill: Skill) => void;
  onSelectMcp?: (server: { name: string; endpoint?: string; transport?: string }) => void;
  onSelectRefFile?: (file: RefFileItem) => void;
  onSelectRefTask?: (task: RefTaskItem) => void;
  /** 选择专家 */
  onSelectExpert?: (expertId: string) => void;
  onManageExpert?: () => void;
  /** 当前已选中的专家 id，用于高亮 */
  selectedExpertId?: string | null;
  /** 选中已安装连接器（挂到输入芯片 / 注入配套技能） */
  onSelectConnector?: (connector: LocalConnectorDto) => void;
  /** 显式选择本轮 ACP 外部 Agent。 */
  onSelectExternalAgent?: (agent: ExternalAgentDescriptorDto) => void;
  /** 把 ACP 外部 Agent 固定到当前任务/草稿（任务级持久，每轮自动续聊）。 */
  onPinExternalAgent?: (agent: ExternalAgentDescriptorDto) => void;
  /**
   * 「+」按钮锚点：主菜单 portal 后按此元素视口坐标定位。
   * 必须挂在按钮外包一层，而不是整个 input-area（否则执行条会把菜单顶飞）。
   */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * 挂到 portal 根节点，供 ChatInput 的 click-outside 把整块菜单（含子层）算作「内部」。
   */
  rootRef?: RefObject<HTMLDivElement | null>;
}

/** 解析该 Agent 已保存的「model」类会话选项显示名（无则 undefined）。 */
function selectedAcpModelLabel(agent: ExternalAgentDescriptorDto): string | undefined {
  const selections = agent.configSelections;
  if (!selections || !agent.configOptions?.length) return undefined;
  const modelOption = agent.configOptions.find((option) => option.category === "model")
    ?? agent.configOptions.find((option) => option.id === "model");
  if (!modelOption || modelOption.type !== "select") return undefined;
  const saved = selections[modelOption.id];
  if (typeof saved !== "string" || !saved) return undefined;
  return modelOption.options?.find((item) => item.value === saved)?.name ?? saved;
}

function isAbsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

function joinPath(cwd: string, rel: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  const name = rel.replace(/^[\\/]+/, "");
  return `${base}\\${name}`.replace(/\//g, "\\");
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/**
 * 从任务收集可引用文件：产物（来自 projection 派生视图）/ 消息附件 / 变更。
 * 3E：artifacts 参数 = useActiveTaskArtifacts()（projection 直读），不再读 task.artifacts。
 */
function collectTaskFiles(
  task: Task | null | undefined,
  artifacts: Artifact[] = [],
): RefFileItem[] {
  if (!task) return [];
  const items: RefFileItem[] = [];
  const seen = new Set<string>();

  const push = (item: RefFileItem): void => {
    const key = (item.path || item.id || item.name).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  const resolve = (path?: string, name?: string): string | undefined => {
    const raw = (path || name || "").trim();
    if (!raw) return undefined;
    if (isAbsPath(raw)) return raw;
    if (task.cwd) return joinPath(task.cwd, raw);
    return path || undefined;
  };

  for (const a of artifacts) {
    const path = resolve(a.path, a.name);
    push({
      id: a.id || `art:${a.name}`,
      name: a.name || basename(path || "file"),
      path: path || a.path,
      // 有绝对路径时优先让 Agent 读盘；否则塞内容
      content: path && isAbsPath(path) ? undefined : a.content || undefined,
      source: "artifact",
    });
  }

  for (const msg of task.messages ?? []) {
    for (const att of msg.attachments ?? []) {
      const path = resolve(att.path, att.name);
      push({
        id: `att:${path || att.name}`,
        name: att.name || basename(path || "file"),
        path,
        source: "attachment",
      });
    }
    // 消息关联的产物 id（防止产物列表偶发不同步）
    for (const id of msg.artifactIds ?? []) {
      const a = artifacts.find((x) => x.id === id);
      if (!a) continue;
      const path = resolve(a.path, a.name);
      push({
        id: a.id,
        name: a.name,
        path: path || a.path,
        content: path && isAbsPath(path) ? undefined : a.content || undefined,
        source: "artifact",
      });
    }
  }

  for (const fc of task.fileChanges ?? []) {
    const path = resolve(undefined, fc.name);
    push({
      id: fc.id || `fc:${fc.name}`,
      name: basename(fc.name),
      path,
      source: "change",
    });
  }

  return items;
}

function collectTaskMessages(task: Task): RefTaskMessage[] {
  return task.messages
    .map((message) => ({
      role: message.role,
      text: [...message.blocks, ...(message.finalBlocks ?? [])]
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim(),
    }))
    .filter((message) => message.text);
}

function mergeRefFiles(...lists: RefFileItem[][]): RefFileItem[] {
  const merged: RefFileItem[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const file of list) {
      const key = (file.path || file.name || file.id).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(file);
    }
  }
  return merged;
}

function historyAttachmentPath(task: Task, path?: string): string | undefined {
  const raw = (path || "").trim();
  if (!raw) return undefined;
  if (isAbsPath(raw) || !task.cwd) return raw;
  return joinPath(task.cwd, raw);
}

export default function InputAddMenu({
  onClose,
  contextMode,
  onSelectConsult,
  consultDisabled,
  onAttachFile,
  onSelectSkill,
  onSelectMcp,
  onSelectRefFile,
  onSelectRefTask,
  onSelectExpert,
  onManageExpert,
  selectedExpertId,
  onSelectConnector,
  onSelectExternalAgent,
  onPinExternalAgent,
  anchorRef,
  rootRef,
}: Props): React.JSX.Element {
  // 直接订阅整棵 tasks，避免仅依赖 artifacts 引用导致偶发不同步
  const tasks = useAppStore((s) => s.tasks);
  const spaces = useAppStore((s) => s.spaces);
  const activeTaskId = useAppStore((s) => contextMode ? null : s.activeTaskId);
  const skills = useAppStore((s) => s.skills);
  const experts = useAppStore((s) => s.experts);
  const connectors = useAppStore((s) => s.connectors);
  const refreshConnectors = useAppStore((s) => s.refreshConnectors);
  const installConnector = useAppStore((s) => s.installConnector);
  const welcomeMode = useAppStore((s) => contextMode ? "working" : s.welcomeMode);
  const modePresetId = useAppStore((s) => contextMode ? null : s.modePresetId);
  const setPage = useAppStore((s) => s.setPage);
  const hookArtifacts = useActiveTaskArtifacts();
  const [recommendedExpertIds, setRecommendedExpertIds] = useState<string[]>([]);
  const [connectorBusy, setConnectorBusy] = useState<string | null>(null);
  /** 当前场景 modeProfile（base + presets）：+ 菜单按 base⊕preset 的 effective policy 收窄 */
  const [modeProfile, setModeProfile] = useState<ModeProfileDto | null>(null);
  /** 当前场景 skillPolicy / mcpPolicy：+ 菜单按黑白名单收窄 */
  const [skillPolicy, setSkillPolicy] = useState<ModeSkillPolicy>(() => emptyModePolicy().skillPolicy);
  const [mcpPolicy, setMcpPolicy] = useState<ModeMcpPolicy>(() => emptyModePolicy().mcpPolicy);
  const [skillFilterOn, setSkillFilterOn] = useState(true);

  useEffect(() => {
    void window.api?.agent?.getModeProfile?.(welcomeMode).then((p) => {
      setModeProfile(p);
      setRecommendedExpertIds(p?.policy?.recommendedExpertIds ?? []);
      setSkillPolicy(p?.policy?.skillPolicy ?? emptyModePolicy().skillPolicy);
      setMcpPolicy(p?.policy?.mcpPolicy ?? emptyModePolicy().mcpPolicy);
    });
  }, [welcomeMode]);

  // 与 HomeHero 一致：任务已锁定（有消息/session）用任务 preset，否则用全局 selection。
  // 复用 shared 纯函数合成 effective policy，保证与 createSession 装配完全一致（B 项修复）。
  const effectivePolicy = useMemo(() => {
    if (!modeProfile) return null;
    const task = tasks.find((t) => t.id === activeTaskId) ?? null;
    const selectedPresetId = task?.modePresetId ?? modePresetId ?? null;
    const preset = resolveModePreset(modeProfile.policy, selectedPresetId);
    return resolveEffectiveModePolicy(modeProfile.policy, preset);
  }, [modeProfile, tasks, activeTaskId, modePresetId]);

  const effSkillPolicy = effectivePolicy?.skillPolicy ?? skillPolicy;
  const effMcpPolicy = effectivePolicy?.mcpPolicy ?? mcpPolicy;
  /** 推荐专家 = base ∪ 当前 Tag/Preset 推荐（effective policy 已去重保序）；无 effective 时回退 policy 级 */
  const effRecommendedExpertIds = effectivePolicy?.recommendedExpertIds ?? recommendedExpertIds;

  useEffect(() => {
    void window.api?.agent?.getAppSettings?.().then((s) => {
      if (s && typeof s.skillModeFilterEnabled === "boolean") {
        setSkillFilterOn(s.skillModeFilterEnabled);
      }
    });
  }, []);

  const sortedExperts = useMemo(() => {
    const rank = (id: string): number => {
      const i = effRecommendedExpertIds.indexOf(id);
      return i < 0 ? 1000 : i;
    };
    // 仅已安装且启用的专家可召唤（listExperts 本身已是已装列表）
    return [...experts]
      .filter((e) => e.installed !== false)
      .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  }, [experts, effRecommendedExpertIds]);

  const activeTask = useMemo(
    () => tasks.find((t) => t.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  );

  const [activeSub, setActiveSub] = useState<SubMenu>(null);
  /**
   * 整块 portal 到 body：根节点 fixed 贴 + 按钮，主菜单在内正常流式；
   * 子菜单 absolute 相对根节点（left:100%），与主菜单绑成一体，不会横向脱开。
   */
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  /** 子菜单相对主菜单顶部的偏移 + 水平方向（右侧放不下则翻到左侧） */
  const [flyoutLayout, setFlyoutLayout] = useState<{
    top: number;
    side: "right" | "left";
  } | null>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const [mcpSearch, setMcpSearch] = useState("");
  const [connectorSearch, setConnectorSearch] = useState("");
  const [refSearch, setRefSearch] = useState("");
  const [taskSearch, setTaskSearch] = useState("");
  const [mcpServers, setMcpServers] = useState<McpServerDto[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const catalogAgents = useExternalAgentCatalog((state) => state.agents);
  const externalAgents = useMemo(() => catalogAgents.filter((item) => item.enabled !== false), [catalogAgents]);
  const externalAgentsLoading = useExternalAgentCatalog((state) => state.loading || (!state.loaded && !state.error));
  const [refTaskBusy, setRefTaskBusy] = useState<string | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const portalRootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Partial<Record<Exclude<SubMenu, null>, HTMLButtonElement | null>>>({});
  /** 当前打开的子菜单 key，供 ResizeObserver / 异步回调用，避免闭包过期 */
  const activeSubRef = useRef<SubMenu>(null);
  activeSubRef.current = activeSub;

  // 同步 portal 根 ref 给父级（click-outside）
  const setPortalRoot = (el: HTMLDivElement | null): void => {
    portalRootRef.current = el;
    if (rootRef) {
      (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    }
  };

  const skillList = useMemo(() => {
    const q = skillSearch.trim().toLowerCase();
    const visible = skills.filter(
      (s) =>
        s.installed &&
        isSkillVisibleForMode(s, welcomeMode, effSkillPolicy, {
          disableFilter: welcomeMode === "general" || !skillFilterOn,
        }) &&
        (q === "" ||
          s.name.toLowerCase().includes(q) ||
          (s.command?.toLowerCase().includes(q) ?? false)),
    );
    return sortSkillsByModePolicy(visible, effSkillPolicy);
  }, [skills, skillSearch, welcomeMode, effSkillPolicy, skillFilterOn]);

  /** 已安装优先；搜索同时覆盖市场未装条目 */
  const connectorInstalled = useMemo(() => {
    const q = connectorSearch.trim().toLowerCase();
    return connectors.filter(
      (c) =>
        c.installed &&
        (q === "" ||
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q)),
    );
  }, [connectors, connectorSearch]);

  const connectorAvailable = useMemo(() => {
    const q = connectorSearch.trim().toLowerCase();
    return connectors.filter(
      (c) =>
        !c.installed &&
        (q === "" ||
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q)),
    );
  }, [connectors, connectorSearch]);

  /** 当前任务可引用文件（产物 + 附件 + 变更）；产物来自 projection 派生视图（hookArtifacts） */
  const refFiles = useMemo((): RefFileItem[] => {
    const fromTask = collectTaskFiles(activeTask, hookArtifacts);
    const q = refSearch.trim().toLowerCase();
    if (!q) return fromTask;
    return fromTask.filter(
      (f) => f.name.toLowerCase().includes(q) || (f.path?.toLowerCase().includes(q) ?? false),
    );
  }, [activeTask, hookArtifacts, refSearch]);

  const refTasks = useMemo((): Task[] => {
    const q = taskSearch.trim().toLowerCase();
    return tasks
      .filter((t) => !t.archived && t.id !== activeTaskId)
      .filter((t) => (q === "" ? true : t.title.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40);
  }, [tasks, activeTaskId, taskSearch]);

  const mcpInstalled = useMemo(() => {
    const q = mcpSearch.trim().toLowerCase();
    return mcpServers.filter(
      (s) =>
        s.installed &&
        !s.disabled &&
        isMcpVisibleForMode(s.name, welcomeMode, effMcpPolicy, { disabled: s.disabled }) &&
        (q === "" ||
          s.name.toLowerCase().includes(q) ||
          s.endpoint.toLowerCase().includes(q)),
    );
  }, [mcpServers, mcpSearch, welcomeMode, effMcpPolicy]);

  const mcpAvailable = useMemo(() => {
    const q = mcpSearch.trim().toLowerCase();
    return mcpServers.filter(
      (s) =>
        !s.installed &&
        isMcpVisibleForMode(s.name, welcomeMode, effMcpPolicy, { disabled: s.disabled }) &&
        (q === "" ||
          s.name.toLowerCase().includes(q) ||
          s.endpoint.toLowerCase().includes(q) ||
          s.sourceId.toLowerCase().includes(q)),
    );
  }, [mcpServers, mcpSearch, welcomeMode, effMcpPolicy]);

  const refreshMcp = async (): Promise<void> => {
    if (!window.api?.mcp?.listServers) return;
    setMcpLoading(true);
    try {
      const list = await window.api.mcp.listServers();
      setMcpServers(list ?? []);
    } catch (err) {
      console.warn("[InputAddMenu] list MCP failed", err);
    } finally {
      setMcpLoading(false);
    }
  };

  useEffect(() => {
    if (activeSub === "mcp") void refreshMcp();
  }, [activeSub]);

  useEffect(() => {
    if (activeSub === "connector") void refreshConnectors();
  }, [activeSub, refreshConnectors]);

  useEffect(() => {
    if (activeSub !== "externalAgent") return;
    void loadExternalAgentCatalog()
      .catch((err) => {
        console.warn("[InputAddMenu] list External Agents failed", err);
      });
  }, [activeSub]);

  /**
   * 主菜单：贴在 + 按钮上方（top-start）；上方不够则翻到下方。
   * portal 根节点 fixed 用视口坐标。
   */
  const syncMenuPos = (): void => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const menuH = Math.max(menu?.offsetHeight ?? 0, 280);
    const menuW = Math.max(menu?.offsetWidth ?? 0, 220);
    const gap = 8;
    const pad = 8;

    let left = rect.left;
    let top = rect.top - gap - menuH;

    if (top < pad) {
      top = rect.bottom + gap;
    }

    left = Math.min(Math.max(pad, left), window.innerWidth - pad - menuW);
    top = Math.min(Math.max(pad, top), window.innerHeight - pad - menuH);

    setMenuPos({ top, left });
  };

  /**
   * 子菜单相对主菜单定位（absolute left:100%）：
   * - top = 触发项相对主菜单顶的偏移（right-start）
   * - 右侧空间不够则 side=left
   * - 仅用视口夹紧垂直偏移，保证不飞出屏幕
   */
  const syncFlyoutLayout = (key: Exclude<SubMenu, null>): void => {
    const btn = itemRefs.current[key];
    const menu = menuRef.current;
    if (!btn || !menu) return;

    const menuRect = menu.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const flyout = flyoutRef.current;
    const flyoutH = Math.max(flyout?.offsetHeight ?? 0, 120);
    const flyoutW = Math.max(flyout?.offsetWidth ?? 0, 240);
    const gap = 6;
    const pad = 8;

    // 相对主菜单顶部的偏移
    let top = btnRect.top - menuRect.top;

    // 视口夹紧：子菜单底/顶不超出屏幕
    const absTop = menuRect.top + top;
    if (absTop + flyoutH > window.innerHeight - pad) {
      top = window.innerHeight - pad - flyoutH - menuRect.top;
    }
    if (menuRect.top + top < pad) {
      top = pad - menuRect.top;
    }

    const spaceRight = window.innerWidth - pad - menuRect.right - gap;
    const side: "right" | "left" = spaceRight >= flyoutW ? "right" : "left";

    setFlyoutLayout({ top, side });
  };

  const syncAllPos = (): void => {
    syncMenuPos();
    const key = activeSubRef.current;
    if (key) syncFlyoutLayout(key);
  };

  // layout 阶段对齐：绘制前算好，避免先错位再跳
  useLayoutEffect(() => {
    syncMenuPos();
  }, []);

  useLayoutEffect(() => {
    if (!activeSub) {
      setFlyoutLayout(null);
      return;
    }
    syncFlyoutLayout(activeSub);
  }, [
    activeSub,
    mcpServers,
    mcpLoading,
    skillList.length,
    refFiles.length,
    refTasks.length,
    connectorInstalled.length,
    connectorAvailable.length,
    mcpSearch,
    skillSearch,
    refSearch,
    taskSearch,
    connectorSearch,
    sortedExperts.length,
    externalAgents.length,
    externalAgentsLoading,
  ]);

  // 尺寸 / 滚动 / 窗口变化时持续纠偏
  useEffect(() => {
    const menu = menuRef.current;
    const flyout = flyoutRef.current;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            syncAllPos();
          })
        : null;
    if (menu && ro) ro.observe(menu);
    if (flyout && ro) ro.observe(flyout);

    const onWin = (): void => {
      syncAllPos();
    };
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);

    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [activeSub]);

  const openSub = (key: Exclude<SubMenu, null>): void => {
    setActiveSub(key);
    activeSubRef.current = key;
    requestAnimationFrame(() => syncFlyoutLayout(key));
  };

  const toggleSub = (key: Exclude<SubMenu, null>): void => {
    setActiveSub((prev) => {
      const next = prev === key ? null : key;
      activeSubRef.current = next;
      if (next) requestAnimationFrame(() => syncFlyoutLayout(next));
      return next;
    });
  };

  const pickMcp = (server: McpServerDto): void => {
    // 先卸载 portal / 透明遮罩，再把 MCP 挂到输入框。
    // 否则焦点恢复发生在旧弹层仍存在的同一帧里，偶发会被遮罩重新吞掉。
    onClose();
    onSelectMcp?.({
      name: server.name,
      endpoint: server.endpoint,
      transport: server.transport,
    });
  };

  const importMcp = async (server: McpServerDto): Promise<void> => {
    if (!window.api?.mcp?.install) return;
    setMcpBusy(server.name);
    try {
      const result = await window.api.mcp.install([server.name]);
      if (!result?.ok) {
        console.warn("[InputAddMenu] install MCP failed", result?.error);
        return;
      }
      // 安装已经落盘；此菜单马上卸载，不必等列表二次刷新后才关闭。
      // 对启动较慢的 MCP，这个 await 曾让全屏透明遮罩长时间留在输入框上方。
      onClose();
      onSelectMcp?.({
        name: server.name,
        endpoint: server.endpoint,
        transport: server.transport,
      });
    } catch (err) {
      console.warn("[InputAddMenu] install MCP failed", err);
    } finally {
      setMcpBusy(null);
    }
  };

  const selectRefFile = (file: RefFileItem): void => {
    // 发送时再从 store 取最新 content/path，避免挂上时空内容
    const live = hookArtifacts.find((a) => a.id === file.id);
    const enriched: RefFileItem = live
      ? {
          ...file,
          name: live.name || file.name,
          path: live.path || file.path,
          content: live.path ? file.content : live.content || file.content,
        }
      : file;
    onSelectRefFile?.(enriched);
    onClose();
  };

  const selectRefTask = async (task: Task): Promise<void> => {
    setRefTaskBusy(task.id);
    try {
      const taskMessages = collectTaskMessages(task);
      let messages = taskMessages;
      // 3E：跨任务产物不再来自 task.artifacts / history.artifacts（legacy artifact-index），
      // 唯一来源 = Artifact Domain（snapshot 触发一次性 legacy migration）；变更/附件仍走历史消息。
      let files = collectTaskFiles(task, []);
      const loadHistory = window.api?.agent?.loadTaskHistory;

      // listTasks 只返回摘要；显式引用动作统一从 session 补齐历史消息和附件。
      if (task.sessionFile && loadHistory) {
        try {
          const history = await loadHistory(task.id);
          if (messages.length === 0) {
            messages = (history.messages ?? [])
              .map((message) => ({ role: message.role, text: message.text.trim() }))
              .filter((message) => message.text);
          }
          // 旧会话兜底：jsonl 内嵌的按消息产物快照（与 Domain 产物按 path/name 去重）
          const historyMessageArtifacts = (history.messages ?? []).flatMap((message) =>
            (message.artifacts ?? []).map((artifact) => ({
              id: artifact.id,
              name: artifact.name,
              path: artifact.path,
              content: artifact.path ? undefined : artifact.content || undefined,
              source: "artifact" as const,
            })),
          );
          const historyAttachments = (history.messages ?? []).flatMap((message) =>
            (message.attachments ?? []).map((attachment) => ({
              id: `hist-att:${attachment.path || attachment.name}`,
              name: attachment.name,
              path: historyAttachmentPath(task, attachment.path),
              source: "attachment" as const,
            })),
          );
          files = mergeRefFiles(
            files,
            // 3E：跨任务产物主来源 = Domain（Domain 优先，jsonl 快照只兜底旧数据）
            await collectTaskDomainArtifacts(window.api?.artifactDomain, task.id),
            historyMessageArtifacts,
            historyAttachments,
          );
        } catch (err) {
          console.warn("[InputAddMenu] load referenced task history failed", err);
        }
      }

      const space = task.spaceId ? spaces.find((item) => item.id === task.spaceId) : undefined;
      onSelectRefTask?.({
        id: task.id,
        title: task.title || "未命名任务",
        spaceName: space?.name,
        cwd: task.cwd ?? space?.path,
        messages,
        files,
      });
      onClose();
    } finally {
      setRefTaskBusy(null);
    }
  };

  const headerArtifact: Artifact | undefined = contextMode ? undefined : hookArtifacts[0] ?? undefined;

  const portalStyle =
    menuPos != null
      ? ({ top: menuPos.top, left: menuPos.left } as const)
      : ({ visibility: "hidden" as const, top: 0, left: 0 } as const);

  /** 子菜单贴在主菜单侧边，坐标相对 portal 根（非视口 fixed） */
  const flyoutStyle =
    flyoutLayout != null
      ? ({
          top: flyoutLayout.top,
          ...(flyoutLayout.side === "right"
            ? { left: "calc(100% + 6px)", right: "auto" }
            : { right: "calc(100% + 6px)", left: "auto" }),
        } as const)
      : ({ visibility: "hidden" as const, top: 0, left: "calc(100% + 6px)" } as const);

  const flyout =
    activeSub === "file" ? (
      <div
        ref={flyoutRef}
        className="add-menu-flyout"
        style={flyoutStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="add-menu-flyout-item"
          onClick={() => {
            onAttachFile?.();
            onClose();
          }}
        >
          <IconFolder size={14} /> 本地文件
        </button>
        {!contextMode && <>
        <button type="button" className="add-menu-flyout-item" onClick={onClose}>
          <IconBook size={14} /> 腾讯文档
        </button>
        <button type="button" className="add-menu-flyout-item" onClick={onClose}>
          <IconBook size={14} /> ima 知识库
        </button>
        <button type="button" className="add-menu-flyout-item" onClick={onClose}>
          <IconBook size={14} /> 乐享知识库
        </button>
        </>}
      </div>
    ) : activeSub === "refTask" ? (
      <div
        ref={flyoutRef}
        className="add-menu-flyout add-menu-flyout-wide"
        style={flyoutStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="add-menu-search">
          <IconSearch size={14} />
          <input
            placeholder="搜索任务"
            value={taskSearch}
            onChange={(e) => setTaskSearch(e.target.value)}
          />
        </div>
        <div className="add-menu-flyout-scroll">
          {refTasks.length === 0 ? (
            <div className="add-menu-flyout-empty">
              {tasks.filter((t) => !t.archived && t.id !== activeTaskId).length === 0
                ? "暂无其它任务可引用"
                : "没有匹配的任务"}
            </div>
          ) : (
            refTasks.map((task) => {
              const spaceName = task.spaceId
                ? spaces.find((space) => space.id === task.spaceId)?.name
                : undefined;
              const taskMeta = [
                spaceName,
                task.messages.length > 0
                  ? `${task.messages.length} 条`
                  : task.sessionFile
                    ? "已有记录"
                    : "空",
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <button
                  key={task.id}
                  type="button"
                  className="add-menu-flyout-item"
                  title={spaceName ? `${task.title} · 来源空间：${spaceName}` : task.title}
                  disabled={refTaskBusy !== null}
                  onClick={() => void selectRefTask(task)}
                >
                  <IconList size={14} />
                  <span className="add-menu-flyout-text">{task.title || "未命名任务"}</span>
                  <span className="add-menu-item-meta">
                    {refTaskBusy === task.id ? "加载中…" : taskMeta}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    ) : activeSub === "ref" ? (
      <div
        ref={flyoutRef}
        className="add-menu-flyout add-menu-flyout-wide"
        style={flyoutStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="add-menu-search">
          <IconSearch size={14} />
          <input
            placeholder="搜索文件"
            value={refSearch}
            onChange={(e) => setRefSearch(e.target.value)}
          />
        </div>
        <div className="add-menu-flyout-scroll">
          {refFiles.length === 0 ? (
            <div className="add-menu-flyout-empty">
              暂无可引用文件
              <div className="add-menu-flyout-empty-hint">
                {activeTask
                  ? `当前任务「${activeTask.title || "未命名"}」还没有产物/附件。Agent 写文件或你上传附件后会出现在这里。`
                  : "请先打开或新建一个任务，再引用该任务中的文件。"}
              </div>
            </div>
          ) : (
            refFiles.map((item) => (
              <button
                key={item.id}
                type="button"
                className="add-menu-flyout-item"
                title={item.path ?? item.name}
                onClick={() => selectRefFile(item)}
              >
                <FileBadge name={item.name} size={14} />
                <span className="add-menu-flyout-text">{item.name}</span>
                <span className="add-menu-item-meta">
                  {item.source === "artifact" ? "产物" : item.source === "change" ? "变更" : "附件"}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    ) : activeSub === "expert" ? (
      <div
        ref={flyoutRef}
        className="add-menu-flyout add-menu-flyout-wide"
        style={flyoutStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="add-menu-flyout-scroll">
          {sortedExperts.length === 0 ? (
            <div className="add-menu-flyout-empty">
              尚未安装专家
              <div className="add-menu-flyout-empty-hint">
                到专家中心安装后再从这里召唤
              </div>
            </div>
          ) : (
            <>
              {sortedExperts.length > 0 && (
                <>
                  <div className="add-menu-section-label">专家</div>
                  {sortedExperts.map((expert) => {
                    const selected = selectedExpertId === expert.id;
                    const recommended = effRecommendedExpertIds.includes(expert.id);
                    return (
                      <button
                        key={expert.id}
                        type="button"
                        className={`add-menu-flyout-item ${selected ? "active" : ""}`}
                        disabled={!expert.enabled}
                        title={
                          expert.enabled
                            ? `${recommended ? "【本场景推荐】" : ""}${expert.description || expert.name}`
                            : `${expert.name}（已停用）`
                        }
                        onClick={() => {
                          if (!expert.enabled) return;
                          onSelectExpert?.(expert.id);
                          onClose();
                        }}
                      >
                        <span className="add-menu-emoji">{expert.emoji || "🧙"}</span>
                        <span className="add-menu-flyout-text">
                          {expert.name}
                          {recommended ? " · 推荐" : ""}
                        </span>
                        {!expert.enabled && (
                          <span className="add-menu-item-count">停用</span>
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
        {onManageExpert && <button type="button" className="add-menu-flyout-footer" onClick={() => { onManageExpert(); onClose(); }}>绑定 / 管理当前任务专家</button>}
        <button
          type="button"
          className="add-menu-flyout-footer"
          onClick={() => {
            setPage("experts");
            onClose();
          }}
        >
          去专家中心安装
        </button>
      </div>
    ) : activeSub === "skill" ? (
      <div
        ref={flyoutRef}
        className="add-menu-flyout add-menu-flyout-wide"
        style={flyoutStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="add-menu-search">
          <IconSearch size={14} />
          <input
            placeholder="搜索技能"
            value={skillSearch}
            onChange={(e) => setSkillSearch(e.target.value)}
          />
        </div>
        <div className="add-menu-flyout-scroll">
          {skillList.length === 0 ? (
            <div className="add-menu-flyout-empty">
              {skills.some((s) => s.installed)
                ? skillFilterOn
                  ? "当前场景无可用技能（已按技能限制/白名单过滤）"
                  : "没有匹配的技能"
                : "暂无已安装技能"}
            </div>
          ) : (
            skillList.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className="add-menu-flyout-item"
                onClick={() => {
                  onSelectSkill?.(skill);
                  onClose();
                }}
              >
                <span className="add-menu-skill-icon">{skill.icon || "✨"}</span>
                <span className="add-menu-flyout-text">{skill.command || skill.name}</span>
              </button>
            ))
          )}
        </div>
        <button
          type="button"
          className="add-menu-flyout-footer"
          onClick={() => {
            void (async () => {
              const folder = await window.api?.pickLocalFolder?.();
              if (!folder?.path) return;
              try {
                const installed = await useAppStore.getState().installSkillByPath(folder.path);
                if (installed) onSelectSkill?.(installed);
              } catch (err) {
                console.warn(err);
              }
              onClose();
            })();
          }}
        >
          <IconUpload size={14} /> 从本地添加技能
        </button>
        <button
          type="button"
          className="add-menu-flyout-footer"
          onClick={() => {
            setPage("skills");
            onClose();
          }}
        >
          <IconSettings size={14} /> 管理技能
        </button>
      </div>
    ) : activeSub === "mcp" ? (
      <div
        ref={flyoutRef}
        className="add-menu-flyout add-menu-flyout-wide"
        style={flyoutStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="add-menu-search">
          <IconSearch size={14} />
          <input
            placeholder="搜索 MCP"
            value={mcpSearch}
            onChange={(e) => setMcpSearch(e.target.value)}
          />
        </div>
        <div className="add-menu-flyout-scroll">
          {mcpLoading && mcpServers.length === 0 ? (
            <div className="add-menu-flyout-empty">加载中…</div>
          ) : (
            <>
              {mcpInstalled.length > 0 && <div className="add-menu-section-label">已安装</div>}
              {mcpInstalled.map((server) => (
                <button
                  key={`inst-${server.name}`}
                  type="button"
                  className="add-menu-flyout-item"
                  onClick={() => pickMcp(server)}
                >
                  <IconBlocks size={14} />
                  <span className="add-menu-flyout-text">{server.name}</span>
                  <span className="add-menu-item-meta">{server.transport}</span>
                </button>
              ))}
              {mcpAvailable.length > 0 && <div className="add-menu-section-label">可导入</div>}
              {mcpAvailable.map((server) => (
                <button
                  key={`avail-${server.name}-${server.sourceId}`}
                  type="button"
                  className="add-menu-flyout-item"
                  disabled={mcpBusy === server.name}
                  onClick={() => void importMcp(server)}
                >
                  <IconBlocks size={14} />
                  <span className="add-menu-flyout-text">{server.name}</span>
                  <span className="add-menu-item-meta">
                    {mcpBusy === server.name ? "导入中…" : "导入"}
                  </span>
                </button>
              ))}
              {!mcpLoading && mcpInstalled.length === 0 && mcpAvailable.length === 0 && (
                <div className="add-menu-flyout-empty">
                  {mcpServers.some((s) => s.installed && !s.disabled)
                    ? "当前场景无可用 MCP（已按黑白名单过滤）"
                    : "暂无 MCP 服务器"}
                </div>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          className="add-menu-flyout-footer"
          onClick={() => {
            setPage("mcp");
            onClose();
          }}
        >
          <IconSettings size={14} /> 管理 MCP
        </button>
      </div>
    ) : activeSub === "externalAgent" ? (
      <div
        ref={flyoutRef}
        className="add-menu-flyout add-menu-flyout-wide"
        style={flyoutStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="add-menu-section-label">外部 Agent · ACP</div>
        <div className="add-menu-flyout-scroll">
          {externalAgentsLoading && externalAgents.length === 0 ? (
            <div className="add-menu-flyout-empty">正在检测本机 ACP Runtime…</div>
          ) : externalAgents.length === 0 ? (
            <div className="add-menu-flyout-empty">未检测到 ACP 外部 Agent</div>
          ) : (
            externalAgents.map((agent) => {
              const acpModel = selectedAcpModelLabel(agent);
              return (
              <div key={agent.id} className="add-menu-flyout-row">
                <button
                  type="button"
                  className="add-menu-flyout-item"
                  disabled={!agent.available}
                  title={agent.detail || agent.commandLabel}
                  onClick={() => {
                    if (!agent.available) return;
                    onSelectExternalAgent?.(agent);
                    onClose();
                  }}
                >
                  <IconBot size={14} />
                  <span className="add-menu-flyout-text">{agent.name}</span>
                  <span className="add-menu-item-meta">
                    {agent.available ? (agent.availability === "adapter" ? "ACP 适配器" : "ACP") : "未就绪"}
                    {acpModel ? ` · ${acpModel}` : ""}
                  </span>
                </button>
                {agent.available && onPinExternalAgent && (
                  <button
                    type="button"
                    className="add-menu-flyout-pin"
                    title={`固定到本任务：每轮自动使用 ${agent.name} 并续接会话`}
                    aria-label={`固定外部 Agent ${agent.name} 到本任务`}
                    onClick={() => {
                      onPinExternalAgent(agent);
                      onClose();
                    }}
                  >
                    <IconPin size={13} />
                  </button>
                )}
              </div>
              );
            })
          )}
        </div>
      </div>
    ) : activeSub === "connector" ? (
      <div
        ref={flyoutRef}
        className="add-menu-flyout add-menu-flyout-wide"
        style={flyoutStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="add-menu-search">
          <IconSearch size={14} />
          <input
            placeholder="搜索连接器"
            value={connectorSearch}
            onChange={(e) => setConnectorSearch(e.target.value)}
          />
        </div>
        <div className="add-menu-flyout-scroll">
          {connectorInstalled.length === 0 && connectorAvailable.length === 0 ? (
            <div className="add-menu-flyout-empty">
              暂无连接器
              <div className="add-menu-flyout-empty-hint">
                到「管理连接器」从市场安装，安装后会出现在这里
              </div>
            </div>
          ) : (
            <>
              {connectorInstalled.length > 0 && (
                <div className="add-menu-section-label">已安装</div>
              )}
              {connectorInstalled.map((conn) => (
                <div key={conn.id} className="add-menu-connector-row">
                  <span className="add-menu-emoji" aria-hidden>
                    🔌
                  </span>
                  <div className="add-menu-connector-info">
                    <span className="add-menu-connector-name">{conn.name}</span>
                    <span className="add-menu-connector-desc" title={`${conn.description || conn.id} · CLI/登录未验证`}>
                      {conn.enabled === false
                        ? "已停用：请到「连接器」页启用后引用"
                        : `${conn.description || conn.id} · 技能已安装；CLI/登录未验证${conn.requiresAuth ? "；使用服务需登录" : ""}`}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="add-menu-connect-btn"
                    title={
                      conn.enabled === false
                        ? "连接器已停用（安装 ≠ active），请到「连接器」页启用"
                        : "挂载配套技能到当前任务；CLI/登录未验证"
                    }
                    disabled={conn.enabled === false}
                    onClick={() => {
                      onSelectConnector?.(conn);
                      onClose();
                    }}
                  >
                    <IconLink size={13} /> {conn.enabled === false ? "已停用" : "引用"}
                  </button>
                </div>
              ))}
              {connectorAvailable.length > 0 && (
                <div className="add-menu-section-label">可安装</div>
              )}
              {connectorAvailable.slice(0, 12).map((conn) => (
                <div key={conn.id} className="add-menu-connector-row">
                  <span className="add-menu-emoji" aria-hidden>
                    🔌
                  </span>
                  <div className="add-menu-connector-info">
                    <span className="add-menu-connector-name">{conn.name}</span>
                    <span className="add-menu-connector-desc" title={`${conn.description || conn.id} · CLI/登录未验证`}>
                      {conn.description || conn.id} · 安装仅添加配套技能，CLI/登录未验证
                    </span>
                  </div>
                  <button
                    type="button"
                    className="add-menu-connect-btn"
                    title="安装配套技能，不执行 CLI 安装或服务登录"
                    disabled={connectorBusy === conn.id}
                    onClick={() => {
                      setConnectorBusy(conn.id);
                      void installConnector(conn.id)
                        .then(() => {
                          /* 装完留在列表，用户可点「引用」 */
                        })
                        .finally(() => setConnectorBusy(null));
                    }}
                  >
                    {connectorBusy === conn.id ? "安装中…" : "安装"}
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
        <button
          type="button"
          className="add-menu-flyout-footer"
          onClick={() => {
            setPage("connectors");
            onClose();
          }}
        >
          管理连接器
        </button>
      </div>
    ) : null;

  const menu = (
    <div
      ref={setPortalRoot}
      className="add-menu-portal-root"
      style={portalStyle}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="add-menu-wrap" role="menu">
        <div className="add-menu" ref={menuRef}>
          {onSelectConsult && (
            <button type="button" className="add-menu-item" data-testid="consult-add-menu"
              disabled={consultDisabled}
              title={consultDisabled ? "多模型会诊由 MyBuddy 主模型调用，当前外部 Agent 不支持" : "仅对当前这条消息使用多个模型独立分析"}
              onMouseEnter={() => setActiveSub(null)}
              onClick={() => { onClose(); onSelectConsult(); }}>
              <IconUsers size={15} className="add-menu-item-icon" /> 多模型会诊
            </button>
          )}
          {headerArtifact && (
            <div className="add-menu-header">
              <FileBadge name={headerArtifact.name} size={16} />
              <span>{headerArtifact.name}</span>
            </div>
          )}

          <button
            type="button"
            ref={(el) => {
              itemRefs.current.file = el;
            }}
            className={`add-menu-item ${activeSub === "file" ? "active" : ""}`}
            onMouseEnter={() => openSub("file")}
            onClick={() => toggleSub("file")}
          >
            <IconUpload size={15} className="add-menu-item-icon" /> 添加文件
            <IconChevronRight size={14} className="add-menu-chevron" />
          </button>

          {onSelectRefTask && <button
            type="button"
            ref={(el) => {
              itemRefs.current.refTask = el;
            }}
            className={`add-menu-item ${activeSub === "refTask" ? "active" : ""}`}
            onMouseEnter={() => openSub("refTask")}
            onClick={() => toggleSub("refTask")}
          >
            <IconList size={15} className="add-menu-item-icon" /> 引用任务
            <IconChevronRight size={14} className="add-menu-chevron" />
          </button>}

          {onSelectRefFile && <button
            type="button"
            ref={(el) => {
              itemRefs.current.ref = el;
            }}
            className={`add-menu-item ${activeSub === "ref" ? "active" : ""}`}
            onMouseEnter={() => openSub("ref")}
            onClick={() => toggleSub("ref")}
          >
            <IconAt size={15} className="add-menu-item-icon" /> 引用对话中的文件
            {refFiles.length > 0 && (
              <span className="add-menu-item-count">{refFiles.length}</span>
            )}
            <IconChevronRight size={14} className="add-menu-chevron" />
          </button>}

          {onSelectExternalAgent && welcomeMode !== "general" && <button
            type="button"
            ref={(el) => {
              itemRefs.current.externalAgent = el;
            }}
            className={`add-menu-item ${activeSub === "externalAgent" ? "active" : ""}`}
            onMouseEnter={() => openSub("externalAgent")}
            onClick={() => toggleSub("externalAgent")}
          >
            <IconBot size={15} className="add-menu-item-icon" /> 外部 Agent
            <IconChevronRight size={14} className="add-menu-chevron" />
          </button>}

          <button
            type="button"
            ref={(el) => {
              itemRefs.current.expert = el;
            }}
            className={`add-menu-item ${activeSub === "expert" ? "active" : ""}`}
            onMouseEnter={() => openSub("expert")}
            onClick={() => toggleSub("expert")}
          >
            <IconUsers size={15} className="add-menu-item-icon" /> 专家
            <IconChevronRight size={14} className="add-menu-chevron" />
          </button>

          <button
            type="button"
            ref={(el) => {
              itemRefs.current.skill = el;
            }}
            className={`add-menu-item ${activeSub === "skill" ? "active" : ""}`}
            onMouseEnter={() => openSub("skill")}
            onClick={() => toggleSub("skill")}
          >
            <IconSparkles size={15} className="add-menu-item-icon" /> 技能
            <IconChevronRight size={14} className="add-menu-chevron" />
          </button>

          <button
            type="button"
            ref={(el) => {
              itemRefs.current.mcp = el;
            }}
            className={`add-menu-item ${activeSub === "mcp" ? "active" : ""}`}
            onMouseEnter={() => openSub("mcp")}
            onClick={() => toggleSub("mcp")}
          >
            <IconBlocks size={15} className="add-menu-item-icon" /> MCP
            <IconChevronRight size={14} className="add-menu-chevron" />
          </button>

          <button
            type="button"
            ref={(el) => {
              itemRefs.current.connector = el;
            }}
            className={`add-menu-item ${activeSub === "connector" ? "active" : ""}`}
            onMouseEnter={() => openSub("connector")}
            onClick={() => toggleSub("connector")}
          >
            <IconLink size={15} className="add-menu-item-icon" /> 连接器
            <IconChevronRight size={14} className="add-menu-chevron" />
          </button>
        </div>
        {flyout}
      </div>
    </div>
  );

  if (typeof document === "undefined") return menu;
  return createPortal(menu, document.body);
}
