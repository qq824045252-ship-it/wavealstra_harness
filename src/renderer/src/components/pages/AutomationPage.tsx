import { useEffect, useMemo, useRef, useState } from "react";
import {
  dateInputToStartMs,
  dateInputToEndMs,
  emptyForm,
  formToSchedule,
  jobToForm,
  templateToForm,
  DOW_LABELS,
  formatScheduleLabel,
  formatNextRunLabel,
  type EveryUnit,
  type FormState,
  type PeriodUnit,
} from "./automationScheduleForm";
import type {
  CronJobDto,
  CronRunDto,
  PermissionMode,
  TaskDto,
} from "../../../../shared/agent-ipc";
import { WELCOME_MODE_LABELS, WELCOME_MODES } from "../../../../shared/mode-profile";
import {
  automationTemplates,
  type AutomationTemplate,
} from "@/mock/data";
import { jobsForProject, resolveJobProjectId, runsForJobs } from "@/lib/projectAutomation";
import { useAppStore } from "@/store/appStore";
import type { Task } from "@/types";
import {
  FULL_ACCESS_CONFIRM,
  PERMISSION_HINT,
  PERMISSION_LABEL,
} from "@/components/chat/permissionCopy";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { useImprovementReport } from "@/components/settings/useImprovementReport";
import NativeImprovementTab from "@/components/settings/NativeImprovementTab";
import WelcomeModeIcon from "@/components/common/WelcomeModeIcon";
import {
  DesktopSectionRow,
  DesktopSectionSidebar,
  useDesktopLeaveGuard,
  useDesktopSectionState,
  useDesktopShell,
} from "@/components/desktop/DesktopSection";
import {
  IconAlert,
  IconBot,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconFolder,
  IconLink,
  IconMore,
  IconPause,
  IconPanel,
  IconPlay,
  IconRotate,
  IconPlus,
  IconSearch,
  IconShield,
  IconSparkles,
  IconTrash,
  IconX,
  IconZap,
} from "@/components/common/icons";
import "@/styles/desktop-project-automation.css";

type Tab = "tasks" | "history";
type PromptMenu = "model" | "skill" | "expert" | "perm" | null;
type ListView = "list" | "form" | "templates" | "review";

function ImprovementAutomation({onOpen}: {onOpen: () => void}): React.JSX.Element | null {
  const { api, report, error, busy, status, update } = useImprovementReport();
  if (!api) return null;
  const latest = report?.runs[0];
  return <section className="review-launch" aria-label="每周自我改进">
    <span className="review-glyph"><IconRotate size={20}/></span>
    <div className="review-launch-main"><h3>每周自我改进</h3>
      <p>{latest ? latest.week + " 当周 · " + latest.added + " 条新线索 · 发布 " + latest.published + " 项" + (latest.issues.length ? " · " + latest.issues.length + " 项待重试" : "")
        : report ? "应用运行期间，每周检查原生会话中的改进机会。" : "正在读取最近的复盘…"}</p></div>
    <button className="review-link" onClick={onOpen}>查看周报<IconChevronRight size={14}/></button>
    <button className="review-primary" disabled={busy || Boolean(status) || !report && !error} onClick={() => void update(api.review)}><IconPlay size={14}/>{busy ? "复盘中…" : "立即复盘"}</button>
    {status && <p className="review-notice" role="status">{status}</p>}
    {error && <p className="review-notice" role="alert">{error}</p>}
  </section>;
}

function uid(): string {
  return `cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatRunStatus(status: CronRunDto["status"]): string {
  if (status === "running") return "运行中";
  if (status === "success") return "成功";
  if (status === "skipped") return "已跳过";
  return "失败";
}

function taskDtoToTask(t: TaskDto, fallbackModelId?: string): Task {
  return {
    id: t.id,
    title: t.title,
    spaceId: t.spaceId ?? undefined,
    status: t.status as Task["status"],
    updatedAt: t.updatedAt,
    messages: [],
    sessionFile: t.sessionFile,
    cwd: t.cwd,
    modelId: t.modelId ?? fallbackModelId,
    permissionMode: t.permissionMode,
    welcomeMode: t.welcomeMode,
    archived: t.archived,
    expertId: t.expertId,
    modePresetId: t.modePresetId,
  };
}

export interface AutomationPageProps {
  /** 项目配置弹窗：只展示/新建该项目的自动化 */
  projectId?: string;
  variant?: "page" | "modal";
  startInForm?: boolean;
  onClose?: () => void;
  onToggleNavigation?: () => void;
}

export default function AutomationPage({
  projectId,
  variant = "page",
  startInForm = false,
  onClose,
  onToggleNavigation,
}: AutomationPageProps = {}): React.JSX.Element {
  const desktopShell = useDesktopShell();
  const desktop = desktopShell && variant === "page" && !projectId;
  const spaces = useAppStore((s) => s.spaces);
  const connectors = useAppStore((s) => s.connectors);
  const skills = useAppStore((s) => s.skills);
  const experts = useAppStore((s) => s.experts);
  const models = useAppStore((s) => s.models);
  const activeModelId = useAppStore((s) => s.activeModelId);
  const addSpaceFromPath = useAppStore((s) => s.addSpaceFromPath);
  const setActiveTask = useAppStore((s) => s.setActiveTask);

  const defaultModelId = activeModelId || models[0]?.id || null;

  const [tab, setTab] = useDesktopSectionState<Tab>(desktop ? "automation:tab" : null, "tasks");
  const [jobs, setJobs] = useDesktopSectionState<CronJobDto[]>(desktop ? "automation:jobs" : null, []);
  const [runs, setRuns] = useDesktopSectionState<CronRunDto[]>(desktop ? "automation:runs" : null, []);
  const [catalogReady, setCatalogReady] = useState(!desktop);
  const [busy, setBusy] = useState(false);
  /** 正在触发测试运行的 job（仅防连点，不阻塞其它 job 并行） */
  const [launchingIds, setLaunchingIds] = useState<Set<string>>(() => new Set());
  const [view, setView] = useDesktopSectionState<ListView>(desktop ? "automation:view" : null, "list");
  const [form, setForm] = useDesktopSectionState<FormState>(desktop ? "automation:form" : null, emptyForm(defaultModelId));
  const [formDirty, setFormDirty] = useDesktopSectionState(desktop ? "automation:form-dirty" : null, false);
  const [formNavigation, setFormNavigation] = useState<(() => void) | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [tipDismissed, setTipDismissed] = useState(false);
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const [connectorMenuOpen, setConnectorMenuOpen] = useState(false);
  const [promptMenu, setPromptMenu] = useState<PromptMenu>(null);
  /** fixed 下拉位置，避免被表单 overflow 裁切 */
  const [promptMenuStyle, setPromptMenuStyle] = useState<React.CSSProperties | null>(null);
  const [fullAccessConfirm, setFullAccessConfirm] = useState(false);
  const [fullAccessAck, setFullAccessAck] = useState(false);
  const [jobQuery, setJobQuery] = useDesktopSectionState(desktop ? "automation:job-query" : null, "");
  const [runQuery, setRunQuery] = useDesktopSectionState(desktop ? "automation:run-query" : null, "");
  const [selectedJobId, setSelectedJobId] = useDesktopSectionState<string | null>(desktop ? "automation:job" : null, null);
  const [selectedRunId, setSelectedRunId] = useDesktopSectionState<string | null>(desktop ? "automation:run" : null, null);
  const query = desktop && tab === "history" ? runQuery : jobQuery;
  const setQuery = desktop && tab === "history" ? setRunQuery : setJobQuery;
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [menuJobId, setMenuJobId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  /** 删除确认：单条 id 或 batch */
  const [deleteConfirm, setDeleteConfirm] = useState<
    null | { mode: "one"; id: string; name: string } | { mode: "batch"; count: number }
  >(null);
  const formRootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const startedInFormRef = useRef(false);
  const refreshRevision = useRef(0);

  useDesktopLeaveGuard(desktop ? () => !busy && !formNavigation : undefined);

  const openPromptMenu = (menu: PromptMenu, anchor: HTMLElement): void => {
    if (promptMenu === menu) {
      setPromptMenu(null);
      setPromptMenuStyle(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 280;
    const menuMaxH = Math.min(280, window.innerHeight * 0.5);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    // 优先向下展开；下方不够再向上，且用 fixed 避免父级 overflow 裁切
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    let left = rect.left;
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - menuWidth - 8);
    }
    if (openUp) {
      setPromptMenuStyle({
        top: "auto",
        bottom: window.innerHeight - rect.top + 6,
        left,
        width: menuWidth,
        maxHeight: Math.min(menuMaxH, Math.max(120, spaceAbove)),
      });
    } else {
      setPromptMenuStyle({
        top: rect.bottom + 6,
        bottom: "auto",
        left,
        width: menuWidth,
        maxHeight: Math.min(menuMaxH, Math.max(120, spaceBelow)),
      });
    }
    setPromptMenu(menu);
  };

  const refresh = async (): Promise<void> => {
    const api = window.api?.cron;
    if (!api) return;
    const revision = ++refreshRevision.current;
    const overview = await api.overview();
    if (revision !== refreshRevision.current) return;
    setJobs(overview.jobs);
    setRuns(overview.runs);
    setCatalogReady(true);
  };

  useEffect(() => {
    const reload = (): void => {
      void refresh().catch((cause) => setToast(cause instanceof Error ? cause.message : "自动化加载失败"));
    };
    reload();
    const unsubscribe = window.api?.cron?.onEvent(reload);
    return () => {
      refreshRevision.current++;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!startInForm || startedInFormRef.current) return;
    startedInFormRef.current = true;
    setForm(emptyForm(defaultModelId));
    setFormError(null);
    setTipDismissed(false);
    setView("form");
    setTab("tasks");
  }, [startInForm, defaultModelId]);

  useEffect(() => {
    if (variant !== "modal") return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (view === "form" || view === "templates") {
        setView("list");
        setFormError(null);
        return;
      }
      onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant, view, onClose]);

  // 倒计时刷新
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!spaceMenuOpen && !connectorMenuOpen && !promptMenu && !menuJobId) return;
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node;
      const el = target as HTMLElement;
      // fixed 菜单在 form 内，点菜单项本身不关
      if (el.closest?.(".auto-dropdown-fixed")) return;
      if (el.closest?.(".auto-prompt-pill.clickable")) return;
      if (formRootRef.current && !formRootRef.current.contains(target) && view === "form") {
        setSpaceMenuOpen(false);
        setConnectorMenuOpen(false);
        setPromptMenu(null);
        setPromptMenuStyle(null);
      } else if (promptMenu) {
        // 点在表单其它区域也关闭提示词菜单
        if (!el.closest?.(".auto-prompt-pill-wrap")) {
          setPromptMenu(null);
          setPromptMenuStyle(null);
        }
      }
      if (menuRef.current && !menuRef.current.contains(target)) {
        setMenuJobId(null);
      }
    };
    const onScroll = (): void => {
      // 滚动时关掉 fixed 菜单，避免错位
      if (promptMenu) {
        setPromptMenu(null);
        setPromptMenuStyle(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onScroll);
    // 表单滚动容器
    const scrollEl = formRootRef.current?.querySelector(".auto-form-scroll");
    scrollEl?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onScroll);
      scrollEl?.removeEventListener("scroll", onScroll);
    };
  }, [spaceMenuOpen, connectorMenuOpen, promptMenu, menuJobId, view]);

  const visibleJobs = useMemo(() => jobsForProject(jobs, projectId), [jobs, projectId]);
  const visibleRuns = useMemo(
    () => (projectId ? runsForJobs(runs, visibleJobs) : runs),
    [projectId, runs, visibleJobs],
  );

  const jobNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const j of visibleJobs) map.set(j.id, j.name);
    return map;
  }, [visibleJobs]);

  const filteredRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visibleRuns;
    return visibleRuns.filter((run) =>
      (jobNameById.get(run.jobId) ?? "").toLowerCase().includes(q) ||
      run.jobId.toLowerCase().includes(q) ||
      (run.error ?? "").toLowerCase().includes(q),
    );
  }, [jobNameById, query, visibleRuns]);
  const selectedJob = visibleJobs.find((job) => job.id === selectedJobId);
  const selectedRun = filteredRuns.find((run) => run.id === selectedRunId) ?? filteredRuns[0];

  const runningJobIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of runs) {
      if (r.status === "running") set.add(r.jobId);
    }
    return set;
  }, [runs]);

  const latestTaskByJob = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of runs) {
      if (!r.taskId) continue;
      if (!map.has(r.jobId)) map.set(r.jobId, r.taskId);
    }
    return map;
  }, [runs]);

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visibleJobs;
    return visibleJobs.filter(
      (j) =>
        j.name.toLowerCase().includes(q) ||
        j.id.toLowerCase().includes(q) ||
        j.prompt.toLowerCase().includes(q) ||
        formatScheduleLabel(j).toLowerCase().includes(q),
    );
  }, [visibleJobs, query]);

  const grouped = useMemo(() => {
    const running: CronJobDto[] = [];
    const current: CronJobDto[] = [];
    const paused: CronJobDto[] = [];
    const delivered: CronJobDto[] = [];
    const cancelled: CronJobDto[] = [];
    for (const j of filteredJobs) {
      if (runningJobIds.has(j.id)) running.push(j);
      else if (j.enabled) current.push(j);
      else if (j.reminder?.state === "delivered") delivered.push(j);
      else if (j.reminder?.state === "cancelled") cancelled.push(j);
      else paused.push(j);
    }
    return { running, current, paused, delivered, cancelled };
  }, [filteredJobs, runningJobIds]);

  const selectedSpace = spaces.find((s) => s.id === form.spaceId);
  const installedConnectors = connectors.filter((c) => c.installed);
  const installedSkills = skills.filter((s) => s.installed && s.enabled !== false);
  const installedExperts = experts.filter((e) => e.installed !== false && e.enabled !== false);
  const selectedModel = models.find((m) => m.id === form.modelId);
  const selectedExpert = installedExperts.find((e) => e.id === form.expertId);

  const openCreate = (seed?: FormState): void => {
    setForm(seed ?? emptyForm(defaultModelId));
    setFormDirty(false);
    setFormError(null);
    setTipDismissed(false);
    setSpaceMenuOpen(false);
    setConnectorMenuOpen(false);
    setPromptMenu(null);
    setPromptMenuStyle(null);
    setView("form");
    setTab("tasks");
  };

  const openEdit = (job: CronJobDto): void => {
    openCreate(jobToForm(job, defaultModelId));
  };

  const openFromTemplate = (t: AutomationTemplate): void => {
    openCreate(templateToForm(t, defaultModelId));
  };

  const closeFormMenus = (): void => {
    setSpaceMenuOpen(false);
    setConnectorMenuOpen(false);
    setPromptMenu(null);
    setPromptMenuStyle(null);
  };

  const leaveFormFor = (next: () => void): void => {
    if (busy) return;
    if (desktop && view === "form" && formDirty) {
      setFormNavigation(() => next);
      return;
    }
    next();
  };

  const cancelForm = (): void => {
    leaveFormFor(() => {
      setFormDirty(false);
      setView("list");
      setFormError(null);
      closeFormMenus();
    });
  };

  const selectDesktopItem = (nextTab: Tab, id: string | null = null): void => {
    leaveFormFor(() => {
      setView("list");
      setTab(nextTab);
      if (nextTab === "tasks") setSelectedJobId(id);
      else if (id) setSelectedRunId(id);
      setFormDirty(false);
      if (batchMode) {
        setBatchMode(false);
        setSelectedIds(new Set());
      }
      setMenuJobId(null);
      closeFormMenus();
    });
  };

  const openTemplates = (): void => {
    leaveFormFor(() => {
      closeFormMenus();
      setFormDirty(false);
      setView("templates");
    });
  };

  const closePromptMenu = (): void => {
    setPromptMenu(null);
    setPromptMenuStyle(null);
  };

  const patchForm = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (desktop) setFormDirty(true);
  };

  const saveForm = async (): Promise<void> => {
    const api = window.api?.cron;
    if (!api) {
      setFormError("定时任务服务未就绪");
      return;
    }
    const name = form.name.trim();
    const prompt = form.prompt.trim();
    if (!name) {
      setFormError("请填写任务名称");
      return;
    }
    if (!prompt) {
      setFormError("请填写提示词");
      return;
    }
    if (form.freqMode === "once" && form.originalOnce?.value !== form.onceAt) {
      const at = new Date(form.onceAt);
      if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
        setFormError("单次执行时间需晚于当前时间");
        return;
      }
    }
    const effectiveFrom = dateInputToStartMs(form.dateStart);
    const effectiveTo = dateInputToEndMs(form.dateEnd);
    if (effectiveFrom != null && effectiveTo != null && effectiveFrom > effectiveTo) {
      setFormError("生效开始日期不能晚于结束日期");
      return;
    }

    const { scheduleType, scheduleExpr } = formToSchedule(form);
    const space = spaces.find((s) => s.id === form.spaceId);
    const now = Date.now();
    const id = form.id ?? uid();
    const existing = jobs.find((j) => j.id === id);
    if (form.id && (!catalogReady || !existing)) {
      setFormError("尚未加载到该计划，请返回计划列表刷新后再试。");
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      const saved = await api.upsert({
        id,
        name,
        prompt,
        scheduleType,
        scheduleExpr,
        timezone: existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        spaceId: form.spaceId ?? undefined,
        cwd: space?.path,
        enabled: existing?.enabled ?? true,
        reminder: existing?.reminder,
        sourceTaskId: existing?.sourceTaskId,
        target: existing?.target,
        maxRuns: existing?.maxRuns,
        restartPolicy: existing?.restartPolicy,
        missedRuns: existing?.missedRuns,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        permissionMode: form.permissionMode,
        welcomeMode: form.welcomeMode,
        modelId: form.modelId ?? undefined,
        expertId: form.expertId ?? undefined,
        skillIds: form.skillIds.length > 0 ? form.skillIds : undefined,
        connectorIds: form.connectorIds.length > 0 ? form.connectorIds : undefined,
        effectiveFrom,
        effectiveTo,
        projectId: resolveJobProjectId({
          existingProjectId: existing?.projectId,
          scopeProjectId: projectId,
        }),
      });
      setJobs((before) => existing
        ? before.map((item) => item.id === saved.id ? saved : item)
        : [saved, ...before]);
      if (desktop) setSelectedJobId(id);
      setFormDirty(false);
      setView("list");
      setTab("tasks");
      void refresh().catch(() => setToast("已保存计划，列表刷新失败"));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (id: string): Promise<void> => {
    if (launchingIds.has(id) || runningJobIds.has(id)) return;
    setMenuJobId(null);
    setLaunchingIds((prev) => new Set(prev).add(id));
    try {
      // 主进程 runNow 立即返回并在后台执行，可与其它 job 并行
      await window.api?.cron?.runNow(id);
      setToast("已触发测试运行。测试运行不会影响正式调度时间。");
      // 稍等事件写入 running 状态
      window.setTimeout(() => {
        void refresh().catch(() => {});
      }, 120);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "测试运行失败");
    } finally {
      setLaunchingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const toggleEnabled = async (job: CronJobDto): Promise<void> => {
    setBusy(true);
    setMenuJobId(null);
    try {
      await window.api?.cron?.setEnabled(job.id, !job.enabled);
      await refresh();
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "未能更新自动化计划");
    } finally {
      setBusy(false);
    }
  };

  const askRemoveJob = (job: CronJobDto): void => {
    setMenuJobId(null);
    setDeleteConfirm({ mode: "one", id: job.id, name: job.name });
  };

  const doRemoveJob = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await window.api?.cron?.remove(id);
      if (selectedJobId === id) setSelectedJobId(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await refresh();
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "未能删除自动化计划");
    } finally {
      setBusy(false);
    }
  };

  const batchSetEnabled = async (enabled: boolean): Promise<void> => {
    if (selectedIds.size === 0) return;
    setBusy(true);
    try {
      await Promise.all(
        [...selectedIds].map((id) => window.api?.cron?.setEnabled(id, enabled)),
      );
      await refresh();
      setSelectedIds(new Set());
    } finally {
      setBusy(false);
    }
  };

  const askBatchRemove = (): void => {
    if (selectedIds.size === 0) return;
    setDeleteConfirm({ mode: "batch", count: selectedIds.size });
  };

  const doBatchRemove = async (): Promise<void> => {
    if (selectedIds.size === 0) return;
    setBusy(true);
    try {
      await Promise.all([...selectedIds].map((id) => window.api?.cron?.remove(id)));
      setSelectedIds(new Set());
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = (): void => {
    const req = deleteConfirm;
    setDeleteConfirm(null);
    if (!req) return;
    if (req.mode === "one") void doRemoveJob(req.id);
    else void doBatchRemove();
  };

  const pickLocalFolder = async (): Promise<void> => {
    setSpaceMenuOpen(false);
    const folder = await window.api?.pickLocalFolder?.();
    if (!folder) return;
    const spaceId = await addSpaceFromPath(folder.path, folder.name);
    if (spaceId) patchForm("spaceId", spaceId);
  };

  const openRunTask = async (taskId?: string): Promise<void> => {
    if (!taskId) return;
    const store = useAppStore.getState();
    const existing = store.tasks.find((t) => t.id === taskId);
    if (!existing) {
      const rows = (await window.api?.db?.listTasks?.()) ?? [];
      const row = rows.find((t) => t.id === taskId);
      if (!row) {
        setToast("未找到对应任务会话（可能已被删除）");
        return;
      }
      const mapped = taskDtoToTask(row, store.activeModelId || undefined);
      useAppStore.setState((s) => ({
        tasks: s.tasks.some((t) => t.id === taskId) ? s.tasks : [mapped, ...s.tasks],
      }));
    }
    setActiveTask(taskId);
  };

  /** 点击行：有历史会话则打开，否则进编辑 */
  const onJobRowClick = (job: CronJobDto): void => {
    if (batchMode) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(job.id)) next.delete(job.id);
        else next.add(job.id);
        return next;
      });
      return;
    }
    if (desktop) {
      selectDesktopItem("tasks", job.id);
      return;
    }
    const taskId = latestTaskByJob.get(job.id);
    if (taskId) void openRunTask(taskId);
    else openEdit(job);
  };

  const toggleSkill = (id: string): void => {
    patchForm(
      "skillIds",
      form.skillIds.includes(id) ? form.skillIds.filter((x) => x !== id) : [...form.skillIds, id],
    );
  };

  const toggleConnector = (id: string): void => {
    patchForm(
      "connectorIds",
      form.connectorIds.includes(id)
        ? form.connectorIds.filter((x) => x !== id)
        : [...form.connectorIds, id],
    );
  };

  const requestPermission = (mode: PermissionMode): void => {
    if (mode === "auto" && form.permissionMode !== "auto") {
      setFullAccessAck(false);
      setFullAccessConfirm(true);
      closePromptMenu();
      return;
    }
    patchForm("permissionMode", mode);
    closePromptMenu();
  };

  const renderJobRow = (job: CronJobDto): React.JSX.Element => {
    const running = runningJobIds.has(job.id);
    const launching = launchingIds.has(job.id);
    const selected = selectedIds.has(job.id);
    const menuOpen = menuJobId === job.id;
    return (
      <div
        key={job.id}
        className={`auto-row ${running ? "is-running" : ""} ${selected ? "is-selected" : ""} ${!job.enabled ? "is-paused" : ""}`}
      >
        {batchMode && (
          <label className="auto-row-check" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={() => {
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(job.id)) next.delete(job.id);
                  else next.add(job.id);
                  return next;
                });
              }}
            />
          </label>
        )}
        <button type="button" className="auto-row-main" onClick={() => onJobRowClick(job)}>
          <span className="auto-row-name">{job.reminder ? "⏰ " : ""}{job.name}</span>
          <span
            className="auto-row-mode"
            title={WELCOME_MODE_LABELS[job.welcomeMode === "coding" || job.welcomeMode === "general" ? job.welcomeMode : "working"]}
          >
            <WelcomeModeIcon
              mode={job.welcomeMode === "coding" || job.welcomeMode === "general" ? job.welcomeMode : "working"}
              size={13}
            />
            <span>
              {job.reminder ? "纯提醒 · 不调用模型" : WELCOME_MODE_LABELS[job.welcomeMode === "coding" || job.welcomeMode === "general" ? job.welcomeMode : "working"]}
            </span>
          </span>
          <span className="auto-row-id" title={job.id}>
            {job.id}
          </span>
          <span className="auto-row-schedule">{formatScheduleLabel(job)}{job.reminder ? ` · ${job.timezone}` : ""}</span>
          {job.sourceTaskId && <span className="auto-row-id" title={`Source task: ${job.sourceTaskId}`}>
            {job.target?.kind === "task" ? "Continue task" : "New task"} · {job.sourceTaskId}
          </span>}
          <span className="auto-row-id" title={job.reminder ? "本机到时提醒；关闭或休眠后恢复会合并补发" : "Runs only while MyBuddy is open. Missed runs are skipped."}>
            {job.reminder ? "离线后补发" : job.restartPolicy === "pause" ? "Pause on restart" : "Resume future runs"}
            {job.maxRuns != null ? ` · ${job.runCount ?? 0}/${job.maxRuns} runs` : ""}
          </span>
        </button>
        <div className="auto-row-right">
          <span className={`auto-row-next ${running || launching ? "running" : ""}`}>
            {running || launching ? "运行中" : formatNextRunLabel(job.nextRunAt, nowTick)}
          </span>
          {!batchMode && (
            <div className="auto-row-actions" ref={menuOpen ? menuRef : undefined}>
              <button
                type="button"
                className="auto-row-icon-btn"
                title={running || launching ? "该任务运行中" : "测试运行（可与其它任务并行）"}
                disabled={running || launching}
                onClick={(e) => {
                  e.stopPropagation();
                  void runNow(job.id);
                }}
              >
                <IconPlay size={14} />
              </button>
              <button
                type="button"
                className={`auto-row-icon-btn ${menuOpen ? "open" : ""}`}
                title="更多"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuJobId(menuOpen ? null : job.id);
                }}
              >
                <IconMore size={14} />
              </button>
              {menuOpen && (
                <div className="auto-row-menu">
                  <button type="button" onClick={() => openEdit(job)}>
                    编辑
                  </button>
                  <button type="button" onClick={() => void toggleEnabled(job)}>
                    {job.enabled ? (
                      <>
                        <IconPause size={13} /> 暂停
                      </>
                    ) : (
                      <>
                        <IconPlay size={13} /> 启用
                      </>
                    )}
                  </button>
                  <button type="button" className="danger" onClick={() => askRemoveJob(job)}>
                    <IconTrash size={13} /> 删除
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderSection = (title: string, list: CronJobDto[]): React.JSX.Element | null => {
    if (list.length === 0) return null;
    return (
      <section className="auto-section">
        <div className="auto-section-title">{title}</div>
        <div className="auto-row-list">{list.map(renderJobRow)}</div>
      </section>
    );
  };

  const renderSidebarJobs = (title: string, jobsInGroup: CronJobDto[]): React.JSX.Element | null => {
    if (!jobsInGroup.length) return null;
    return (
      <section aria-label={title}>
        <div className="desktop-section-group">{title}</div>
        {jobsInGroup.map((job) => (
          <DesktopSectionRow
            key={job.id}
            title={job.name}
            icon={job.reminder ? <IconClock size={14} /> : <IconZap size={14} />}
            active={view === "form" ? form.id === job.id : view === "list" && selectedJob?.id === job.id}
            onClick={() => selectDesktopItem("tasks", job.id)}
          >
            {job.name}
          </DesktopSectionRow>
        ))}
      </section>
    );
  };

  const runTitle = (run: CronRunDto): string => jobNameById.get(run.jobId) ?? run.jobId;

  const desktopSidebar = desktop && (
    <>
      <DesktopSectionSidebar
        title="自动化"
        scrollKey={tab === "history" ? "automation:history" : "automation:plans"}
        actions={
          <button type="button" className="icon-btn" title="添加自动化" aria-label="添加自动化" onClick={() => leaveFormFor(() => openCreate())}>
            <IconPlus size={16} />
          </button>
        }
      >
        <DesktopSectionRow
          icon={<IconZap size={15} />}
          active={tab === "tasks" && view === "list" && !selectedJob}
          onClick={() => selectDesktopItem("tasks")}
        >
          定时任务
        </DesktopSectionRow>
        <DesktopSectionRow
          icon={<IconClock size={15} />}
          active={tab === "history" && view === "list" && !selectedRun}
          onClick={() => selectDesktopItem("history")}
        >
          运行记录
        </DesktopSectionRow>
        <DesktopSectionRow icon={<IconRotate size={15}/>} active={view === "review"} onClick={() => leaveFormFor(() => setView("review"))}>
          每周复盘
        </DesktopSectionRow>
        <DesktopSectionRow icon={<IconSparkles size={15} />} active={view === "templates"} onClick={openTemplates}>
          从模板添加
        </DesktopSectionRow>
        {tab === "history" && view === "list" ? (
          <>
            <div className="desktop-section-group">最近运行</div>
            {filteredRuns.map((run) => (
              <DesktopSectionRow
                key={run.id}
                title={`${runTitle(run)} · ${new Date(run.startedAt).toLocaleString()}`}
                meta={formatRunStatus(run.status)}
                active={selectedRun?.id === run.id}
                onClick={() => selectDesktopItem("history", run.id)}
              >
                {runTitle(run)}
              </DesktopSectionRow>
            ))}
          </>
        ) : (
          <>
            {renderSidebarJobs("运行中", grouped.running)}
            {renderSidebarJobs("已启用", grouped.current)}
            {renderSidebarJobs("已暂停", grouped.paused)}
            {renderSidebarJobs("已提醒", grouped.delivered)}
            {renderSidebarJobs("已取消", grouped.cancelled)}
          </>
        )}
      </DesktopSectionSidebar>
      <ConfirmDialog
        open={formNavigation !== null}
        title="放弃当前更改？"
        body="离开当前自动化表单将丢弃尚未保存的修改。"
        confirmLabel="放弃更改"
        onCancel={() => setFormNavigation(null)}
        onConfirm={() => {
          const navigate = formNavigation;
          setFormNavigation(null);
          navigate?.();
        }}
      />
    </>
  );

  const renderJobDetails = (job: CronJobDto): React.JSX.Element => {
    const running = runningJobIds.has(job.id) || launchingIds.has(job.id);
    const recentRuns = visibleRuns.filter((run) => run.jobId === job.id).slice(0, 5);
    const modelName = models.find((model) => model.id === job.modelId)?.name;
    const spaceName = spaces.find((space) => space.id === job.spaceId)?.name;
    return (
      <article className="desktop-auto-detail">
        <header className="desktop-auto-detail-head">
          <h2>{job.name}</h2>
          <div className="desktop-auto-detail-actions">
            <button type="button" className="btn" onClick={() => openEdit(job)}>编辑</button>
            <button type="button" className="btn" disabled={busy || running} onClick={() => void runNow(job.id)}>
              <IconPlay size={14} /> {running ? "运行中" : "测试运行"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void toggleEnabled(job)}>
              {job.enabled ? "暂停" : "启用"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => askRemoveJob(job)}>删除</button>
          </div>
        </header>
        <dl className="desktop-auto-detail-fields">
          <dt>执行计划</dt><dd>{formatScheduleLabel(job)} · {job.timezone}</dd>
          <dt>状态</dt>
          <dd>{running ? "运行中" : job.reminder?.state === "delivered" ? "已提醒" : job.reminder?.state === "cancelled" ? "已取消" : job.enabled ? "已启用" : "已暂停"}</dd>
          <dt>下次运行</dt><dd>{job.enabled ? formatNextRunLabel(job.nextRunAt, nowTick) || "—" : "—"}</dd>
          {job.spaceId && <><dt>工作空间</dt><dd>{spaceName ?? job.spaceId}</dd></>}
          {job.modelId && <><dt>模型</dt><dd>{modelName ?? job.modelId}</dd></>}
          {job.sourceTaskId && (
            <>
              <dt>来源</dt>
              <dd><button type="button" className="btn" onClick={() => void openRunTask(job.sourceTaskId)}>打开来源任务</button></dd>
            </>
          )}
          {!job.reminder && job.target && (
            <><dt>执行目标</dt><dd>{job.target.kind === "task" ? "继续任务" : "新建任务"}</dd></>
          )}
          {job.maxRuns != null && <><dt>运行次数</dt><dd>{job.runCount ?? 0} / {job.maxRuns}</dd></>}
          <dt>重启后</dt>
          <dd>{job.reminder ? "补发错过的提醒" : job.restartPolicy === "pause" ? "暂停计划" : "继续后续计划"}</dd>
        </dl>
        <h3>{job.reminder ? "提醒内容" : "提示词"}</h3>
        <p className="desktop-auto-prompt">{job.prompt}</p>
        <h3>最近运行</h3>
        {recentRuns.length === 0 ? <p className="desktop-auto-placeholder">暂无运行记录</p> : (
          <div className="auto-run-list">
            {recentRuns.map((run) => (
              <button
                key={run.id}
                type="button"
                className="auto-run-card clickable"
                onClick={() => {
                  setRunQuery("");
                  selectDesktopItem("history", run.id);
                }}
              >
                <span className={`auto-run-status ${run.status}`}>{formatRunStatus(run.status)}</span>
                <span className="auto-run-body">{new Date(run.startedAt).toLocaleString()}</span>
                <IconChevronRight size={15} className="auto-run-chevron" />
              </button>
            ))}
          </div>
        )}
      </article>
    );
  };

  const renderRunDetails = (run: CronRunDto): React.JSX.Element => (
    <article className="desktop-auto-detail">
      <header className="desktop-auto-detail-head">
        <h2>{runTitle(run)}</h2>
        {run.taskId && <button type="button" className="btn" onClick={() => void openRunTask(run.taskId)}>打开任务会话</button>}
      </header>
      <dl className="desktop-auto-detail-fields">
        <dt>状态</dt>
        <dd><span className={`auto-run-status ${run.status}`}>{formatRunStatus(run.status)}</span></dd>
        <dt>开始</dt><dd>{new Date(run.startedAt).toLocaleString()}</dd>
        {run.finishedAt && <><dt>耗时</dt><dd>{Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000))} 秒</dd></>}
      </dl>
      {run.error && <><h3>运行信息</h3><p className="desktop-auto-prompt">{run.error}</p></>}
    </article>
  );

  if (view === "review" && !projectId) return (
    <div className={`content-col auto-root${desktop ? " desktop-auto-screen" : ""}`}>
      {desktopSidebar}
      <div className="auto-form-topbar review-crumb">
        <button className="auto-form-crumb-btn" onClick={() => selectDesktopItem("tasks")}>定时任务</button>
        <IconChevronRight size={13}/><span>每周复盘</span>
      </div>
      <div className="review-workspace"><NativeImprovementTab/></div>
    </div>
  );

  /* ---------- 模板页 ---------- */
  if (view === "templates") {
    return (
      <div className={`content-col ${variant === "modal" ? "auto-root-modal" : ""}${desktop ? " desktop-auto-screen" : ""}`}>
        {desktopSidebar}
        <div className="auto-form-topbar">
          <div className="auto-form-breadcrumb">
            {onToggleNavigation && <button type="button" className="icon-btn" aria-label="打开主导航" onClick={onToggleNavigation}><IconPanel size={16} /></button>}
            <button type="button" className="auto-form-crumb-btn" onClick={() => setView("list")}>
              <IconZap size={15} />
              自动化
            </button>
            <IconChevronRight size={14} className="auto-form-crumb-sep" />
            <span>从模版添加</span>
          </div>
          <button type="button" className="btn" onClick={() => setView("list")}>
            返回
          </button>
        </div>
        <div className="page-scroll">
          <div className="page-container auto-page">
            <div className="auto-templates-head">
              <div className="auto-templates-title">选择模版快速创建</div>
              <div className="auto-templates-sub">选定后进入编辑页，可再调整提示词与频率</div>
            </div>
            <div className="template-grid auto-template-grid">
              {automationTemplates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="template-card auto-template-card"
                  onClick={() => openFromTemplate(t)}
                >
                  <span className="template-icon auto-template-emoji" aria-hidden>
                    {t.emoji}
                  </span>
                  <span>
                    <span className="template-title">{t.title}</span>
                    <div className="template-desc">{t.description}</div>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- 创建 / 编辑表单 ---------- */
  if (view === "form") {
    return (
      <div className={`content-col ${variant === "modal" ? "auto-root-modal" : ""}${desktop ? " desktop-auto-screen" : ""}`} ref={formRootRef}>
        {desktopSidebar}
        <div className="auto-form-topbar">
          <div className="auto-form-breadcrumb">
            <button type="button" className="auto-form-crumb-btn" onClick={cancelForm}>
              <IconZap size={15} />
              自动化
            </button>
            <IconChevronRight size={14} className="auto-form-crumb-sep" />
            <span>{form.id ? "编辑自动化任务" : "添加自动化任务"}</span>
          </div>
          <div className="auto-form-top-actions">
            <button type="button" className="btn" onClick={cancelForm} disabled={busy}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={() => void saveForm()} disabled={busy}>
              保存
            </button>
          </div>
        </div>

        <div className="page-scroll auto-form-scroll">
          <div className="auto-form-container">
            {!tipDismissed && (
              <div className="auto-tip-banner">
                <IconAlert size={15} />
                <span>
                  {form.reminder ? "提醒在本机运行；关闭或休眠期间无法准时弹出，恢复后会合并补发错过的提醒。" : "自动化任务执行时，请勿关闭电脑或退出客户端，否则任务将无法正常执行"}
                </span>
                <button
                  type="button"
                  className="auto-tip-close"
                  title="关闭"
                  onClick={() => setTipDismissed(true)}
                >
                  <IconX size={14} />
                </button>
              </div>
            )}

            {formError && <div className="auto-form-error">{formError}</div>}

            <label className="auto-field">
              <span className="auto-field-label">名称</span>
              <input
                className="auto-input"
                value={form.name}
                placeholder="给自动化任务起个名字"
                maxLength={64}
                onChange={(e) => patchForm("name", e.target.value)}
                autoFocus
              />
            </label>

            <div className="auto-field" style={form.reminder ? { display: "none" } : undefined}>
              <span className="auto-field-label">任务类型</span>
              <div className="auto-seg auto-mode-seg">
                {WELCOME_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`auto-seg-btn auto-mode-seg-btn ${form.welcomeMode === mode ? "active" : ""}`}
                    onClick={() => patchForm("welcomeMode", mode)}
                  >
                    <WelcomeModeIcon mode={mode} size={14} />
                    {WELCOME_MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
              <div className="auto-field-hint">
                决定执行时的场景策略（技能过滤、权限建议、系统提示等），与新建任务的办公 / 代码 / 设计一致。
              </div>
            </div>

            <div className="auto-field" style={form.reminder ? { display: "none" } : undefined}>
              <span className="auto-field-label">
                工作空间<span className="auto-optional">（可选）</span>
              </span>
              <div className="auto-space-row">
                {selectedSpace ? (
                  <button
                    type="button"
                    className="auto-space-chip"
                    onClick={() => {
                      setSpaceMenuOpen((v) => !v);
                      setConnectorMenuOpen(false);
                      setPromptMenu(null);
                    }}
                  >
                    <IconFolder size={14} />
                    <span className="auto-space-chip-name">{selectedSpace.name}</span>
                    <span
                      className="auto-space-chip-x"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        patchForm("spaceId", null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation();
                          patchForm("spaceId", null);
                        }
                      }}
                    >
                      <IconX size={12} />
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="auto-space-add"
                    onClick={() => {
                      setSpaceMenuOpen((v) => !v);
                      setConnectorMenuOpen(false);
                      setPromptMenu(null);
                    }}
                  >
                    <IconPlus size={14} />
                  </button>
                )}
                {spaceMenuOpen && (
                  <div className="auto-dropdown">
                    <button
                      type="button"
                      className="auto-dropdown-item"
                      onClick={() => {
                        patchForm("spaceId", null);
                        setSpaceMenuOpen(false);
                      }}
                    >
                      <span>—</span>
                      <span>不使用工作空间</span>
                      {!form.spaceId && <IconCheck size={14} />}
                    </button>
                    {spaces
                      .filter((s) => !s.archived)
                      .map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className={`auto-dropdown-item ${form.spaceId === s.id ? "active" : ""}`}
                          onClick={() => {
                            patchForm("spaceId", s.id);
                            setSpaceMenuOpen(false);
                          }}
                          title={s.path}
                        >
                          <IconFolder size={14} />
                          <span className="auto-dropdown-main">
                            <span>{s.name}</span>
                            {s.path && <span className="auto-dropdown-sub">{s.path}</span>}
                          </span>
                          {form.spaceId === s.id && <IconCheck size={14} />}
                        </button>
                      ))}
                    <button
                      type="button"
                      className="auto-dropdown-item accent"
                      onClick={() => void pickLocalFolder()}
                    >
                      <IconPlus size={14} />
                      <span>打开本地文件夹</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="auto-field">
              <span className="auto-field-label">{form.reminder ? "提醒内容（到时直接发送）" : "提示词"}</span>
              <div className="auto-prompt-shell">
                <div className="auto-prompt-box">
                  <textarea
                    className="auto-prompt-textarea"
                    value={form.prompt}
                    placeholder="描述希望定期执行的任务内容，可写清目标、输出格式与约束…"
                    onChange={(e) => patchForm("prompt", e.target.value)}
                    rows={8}
                  />
                </div>
                <div className="auto-prompt-toolbar" style={form.reminder ? { display: "none" } : undefined}>
                  <div className={`auto-prompt-pill-wrap ${promptMenu === "model" ? "is-open" : ""}`}>
                    <button
                      type="button"
                      className={`auto-prompt-pill clickable ${promptMenu === "model" ? "open" : ""}`}
                      onClick={(e) => {
                        openPromptMenu("model", e.currentTarget);
                        setSpaceMenuOpen(false);
                        setConnectorMenuOpen(false);
                      }}
                    >
                      <IconBot size={13} />
                      {selectedModel?.name ?? "Auto"}
                      <IconChevronDown size={11} />
                    </button>
                    {promptMenu === "model" && (
                      <div className="auto-dropdown auto-dropdown-fixed" style={promptMenuStyle ?? undefined}>
                        <button
                          type="button"
                          className={`auto-dropdown-item ${!form.modelId ? "active" : ""}`}
                          onClick={() => {
                            patchForm("modelId", null);
                            closePromptMenu();
                          }}
                        >
                          <span>Auto（应用默认）</span>
                          {!form.modelId && <IconCheck size={14} />}
                        </button>
                        {models.filter((m) => m.enabled !== false).map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            className={`auto-dropdown-item ${form.modelId === m.id ? "active" : ""}`}
                            onClick={() => {
                              patchForm("modelId", m.id);
                              closePromptMenu();
                            }}
                          >
                            <span className="auto-dropdown-main">
                              <span>{m.name}</span>
                              <span className="auto-dropdown-sub">{m.vendor}</span>
                            </span>
                            {form.modelId === m.id && <IconCheck size={14} />}
                          </button>
                        ))}
                        {models.length === 0 && (
                          <div className="auto-dropdown-empty">暂无可用模型，请先在设置中配置</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className={`auto-prompt-pill-wrap ${promptMenu === "skill" ? "is-open" : ""}`}>
                    <button
                      type="button"
                      className={`auto-prompt-pill clickable ${promptMenu === "skill" ? "open" : ""} ${form.skillIds.length ? "active-count" : ""}`}
                      onClick={(e) => {
                        openPromptMenu("skill", e.currentTarget);
                        setSpaceMenuOpen(false);
                        setConnectorMenuOpen(false);
                      }}
                    >
                      <IconSparkles size={13} />
                      技能{form.skillIds.length > 0 ? ` · ${form.skillIds.length}` : ""}
                      <IconChevronDown size={11} />
                    </button>
                    {promptMenu === "skill" && (
                      <div
                        className="auto-dropdown auto-dropdown-fixed auto-dropdown-wide"
                        style={promptMenuStyle ?? undefined}
                      >
                        {installedSkills.length === 0 ? (
                          <div className="auto-dropdown-empty">暂无已安装技能</div>
                        ) : (
                          installedSkills.map((s) => {
                            const on = form.skillIds.includes(s.id);
                            return (
                              <button
                                key={s.id}
                                type="button"
                                className={`auto-dropdown-item ${on ? "active" : ""}`}
                                onClick={() => toggleSkill(s.id)}
                              >
                                <span className="auto-dropdown-main">
                                  <span>{s.name}</span>
                                  {s.description && (
                                    <span className="auto-dropdown-sub">{s.description}</span>
                                  )}
                                </span>
                                {on && <IconCheck size={14} />}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>

                  <div className={`auto-prompt-pill-wrap ${promptMenu === "expert" ? "is-open" : ""}`}>
                    <button
                      type="button"
                      className={`auto-prompt-pill clickable ${promptMenu === "expert" ? "open" : ""} ${form.expertId ? "active-count" : ""}`}
                      onClick={(e) => {
                        openPromptMenu("expert", e.currentTarget);
                        setSpaceMenuOpen(false);
                        setConnectorMenuOpen(false);
                      }}
                    >
                      <IconBot size={13} />
                      {selectedExpert ? `专家 · ${selectedExpert.name}` : "召唤专家"}
                      <IconChevronDown size={11} />
                    </button>
                    {promptMenu === "expert" && (
                      <div
                        className="auto-dropdown auto-dropdown-fixed auto-dropdown-wide"
                        style={promptMenuStyle ?? undefined}
                      >
                        <button
                          type="button"
                          className={`auto-dropdown-item ${!form.expertId ? "active" : ""}`}
                          onClick={() => {
                            patchForm("expertId", null);
                            closePromptMenu();
                          }}
                        >
                          <span>不使用专家</span>
                          {!form.expertId && <IconCheck size={14} />}
                        </button>
                        {installedExperts.map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            className={`auto-dropdown-item ${form.expertId === e.id ? "active" : ""}`}
                            onClick={() => {
                              patchForm("expertId", e.id);
                              closePromptMenu();
                            }}
                          >
                            <span className="auto-dropdown-main">
                              <span>
                                {e.emoji ? `${e.emoji} ` : ""}
                                {e.name}
                              </span>
                              {e.description && (
                                <span className="auto-dropdown-sub">{e.description}</span>
                              )}
                            </span>
                            {form.expertId === e.id && <IconCheck size={14} />}
                          </button>
                        ))}
                        {installedExperts.length === 0 && (
                          <div className="auto-dropdown-empty">暂无已安装专家</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className={`auto-prompt-pill-wrap ${promptMenu === "perm" ? "is-open" : ""}`}>
                    <button
                      type="button"
                      className={`auto-prompt-pill clickable ${form.permissionMode === "auto" ? "danger" : ""} ${promptMenu === "perm" ? "open" : ""}`}
                      onClick={(e) => {
                        openPromptMenu("perm", e.currentTarget);
                        setSpaceMenuOpen(false);
                        setConnectorMenuOpen(false);
                      }}
                      title={PERMISSION_HINT[form.permissionMode]}
                    >
                      {form.permissionMode === "auto" ? (
                        <IconAlert size={13} />
                      ) : (
                        <IconShield size={13} />
                      )}
                      {PERMISSION_LABEL[form.permissionMode]}
                      <IconChevronDown size={11} />
                    </button>
                    {promptMenu === "perm" && (
                      <div className="auto-dropdown auto-dropdown-fixed" style={promptMenuStyle ?? undefined}>
                        {(["default", "readonly", "auto"] as PermissionMode[]).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            className={`auto-dropdown-item ${form.permissionMode === mode ? "active" : ""}`}
                            onClick={() => requestPermission(mode)}
                          >
                            <span className="auto-dropdown-main">
                              <span>{PERMISSION_LABEL[mode]}</span>
                              <span className="auto-dropdown-sub">{PERMISSION_HINT[mode]}</span>
                            </span>
                            {form.permissionMode === mode && <IconCheck size={14} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="auto-field" style={form.reminder ? { display: "none" } : undefined}>
              <span className="auto-field-label">
                连接器
                <span className="auto-optional">（勾选即授权该连接器在任务中免确认使用）</span>
              </span>
              <div className="auto-select-wrap">
                <button
                  type="button"
                  className="auto-select-trigger"
                  onClick={() => {
                    setConnectorMenuOpen((v) => !v);
                    setSpaceMenuOpen(false);
                    setPromptMenu(null);
                  }}
                >
                  <span>
                    {form.connectorIds.length === 0
                      ? "选择连接器"
                      : `已选 ${form.connectorIds.length} 个连接器`}
                  </span>
                  <IconChevronDown size={14} />
                </button>
                {connectorMenuOpen && (
                  <div className="auto-dropdown auto-dropdown-wide">
                    {installedConnectors.length === 0 ? (
                      <div className="auto-dropdown-empty">暂无已安装连接器</div>
                    ) : (
                      installedConnectors.map((c) => {
                        const on = form.connectorIds.includes(c.id);
                        return (
                          <button
                            key={c.id}
                            type="button"
                            className={`auto-dropdown-item ${on ? "active" : ""}`}
                            onClick={() => toggleConnector(c.id)}
                          >
                            <IconLink size={14} />
                            <span className="auto-dropdown-main">
                              <span>{c.name}</span>
                              {c.description && (
                                <span className="auto-dropdown-sub">{c.description}</span>
                              )}
                            </span>
                            {on && <IconCheck size={14} />}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
              {form.connectorIds.length > 0 && (
                <div className="auto-chip-row">
                  {form.connectorIds.map((id) => {
                    const c = connectors.find((x) => x.id === id);
                    return (
                      <span key={id} className="auto-chip">
                        {c?.name ?? id}
                        <button type="button" onClick={() => toggleConnector(id)} title="移除">
                          <IconX size={12} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="auto-field">
              <span className="auto-field-label">
                执行频率
                <span className="auto-optional">
                  {form.reminder ? "（纯提醒不调用模型；本机离线后恢复补发）" : "（建议避开上午高峰时段，高峰期容易排队等待；选择非高峰执行更稳定）"}
                </span>
              </span>
              <div className="auto-seg">
                {(
                  [
                    ["period", "周期"],
                    ["every", "按间隔"],
                    ["once", "单次"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`auto-seg-btn ${form.freqMode === key ? "active" : ""}`}
                    onClick={() => patchForm("freqMode", key)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {form.freqMode === "cron" && <label className="auto-freq-row">自定义周期<input className="auto-input" aria-label="Cron表达式" value={form.cronExpr} onChange={event => patchForm("cronExpr", event.target.value)} /></label>}
              {form.freqMode === "period" && (
                <div className="auto-freq-row">
                  <select
                    className="auto-input auto-input-sm"
                    value={form.periodUnit}
                    onChange={(e) => patchForm("periodUnit", e.target.value as PeriodUnit)}
                  >
                    <option value="day">每天</option>
                    <option value="week">每周</option>
                    <option value="month">每月</option>
                  </select>
                  {form.periodUnit === "week" && (
                    <select
                      className="auto-input auto-input-sm"
                      value={form.periodDow}
                      onChange={(e) => patchForm("periodDow", Number(e.target.value))}
                    >
                      {DOW_LABELS.map((label, i) => (
                        <option key={label} value={i}>
                          {label}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    type="time"
                    className="auto-input auto-input-sm"
                    value={form.periodTime}
                    onChange={(e) => patchForm("periodTime", e.target.value)}
                  />
                </div>
              )}

              {form.freqMode === "every" && (
                <div className="auto-freq-row">
                  <span className="auto-freq-hint">每</span>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    className="auto-input auto-input-sm auto-input-num"
                    value={form.everyN}
                    onChange={(e) => patchForm("everyN", Math.max(1, Number(e.target.value) || 1))}
                  />
                  <select
                    className="auto-input auto-input-sm"
                    value={form.everyUnit}
                    onChange={(e) => patchForm("everyUnit", e.target.value as EveryUnit)}
                  >
                    <option value="s">秒</option>
                    <option value="m">分钟</option>
                    <option value="h">小时</option>
                    <option value="d">天</option>
                  </select>
                </div>
              )}

              {form.freqMode === "once" && (
                <div className="auto-freq-row">
                  <input
                    type="datetime-local"
                    className="auto-input auto-input-sm"
                    value={form.onceAt}
                    onChange={(e) => patchForm("onceAt", e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="auto-field">
              <span className="auto-field-label">
                生效日期区间
                <span className="auto-optional">（可选，留空表示始终生效。）</span>
              </span>
              <div className="auto-freq-row">
                <input
                  type="date"
                  className="auto-input auto-input-sm"
                  value={form.dateStart}
                  onChange={(e) => patchForm("dateStart", e.target.value)}
                />
                <span className="auto-freq-hint">至</span>
                <input
                  type="date"
                  className="auto-input auto-input-sm"
                  value={form.dateEnd}
                  onChange={(e) => patchForm("dateEnd", e.target.value)}
                />
              </div>
              <div className="auto-field-hint">
                超出区间的周期触发会记为「已跳过」；过期后任务自动暂停。手动「测试运行」不受区间限制。
              </div>
            </div>
          </div>
        </div>

        {fullAccessConfirm && (
          <div className="modal-overlay" onClick={() => setFullAccessConfirm(false)}>
            <div
              className="new-project-modal"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              style={{ width: 420 }}
            >
              <div className="new-project-modal-head">
                <div className="new-project-modal-title">{FULL_ACCESS_CONFIRM.title}</div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setFullAccessConfirm(false)}
                >
                  <IconX size={16} />
                </button>
              </div>
              <div className="new-project-modal-body">
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "var(--fg-secondary)" }}>
                  {FULL_ACCESS_CONFIRM.body}
                </p>
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={fullAccessAck}
                    onChange={(e) => setFullAccessAck(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>{FULL_ACCESS_CONFIRM.checkbox}</span>
                </label>
              </div>
              <div className="new-project-modal-foot">
                <span />
                <div className="new-project-foot-actions">
                  <button type="button" className="btn" onClick={() => setFullAccessConfirm(false)}>
                    {FULL_ACCESS_CONFIRM.cancel}
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!fullAccessAck}
                    onClick={() => {
                      patchForm("permissionMode", "auto");
                      setFullAccessConfirm(false);
                    }}
                  >
                    {FULL_ACCESS_CONFIRM.confirm}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ---------- 列表 / 运行记录（WorkBuddy 风格） ---------- */
  return (
    <div className={`content-col auto-root ${variant === "modal" ? "auto-root-modal" : ""}${desktop ? " desktop-auto-screen" : ""}`}>
      {desktopSidebar}
      {toast && (
        <div className="auto-toast" role="status">
          <IconCheck size={15} />
          <span>{toast}</span>
        </div>
      )}

      {variant === "modal" && (
        <header className="project-auto-modal-head">
          <div className="project-auto-modal-titles">
            <h2>自动化任务</h2>
            <p>配置自动化任务，将按计划定时执行</p>
          </div>
          <button
            type="button"
            className="project-rail-toggle"
            title="关闭"
            aria-label="关闭"
            onClick={() => onClose?.()}
          >
            <IconX size={16} strokeWidth={1.7} />
          </button>
        </header>
      )}

      <div className="auto-toolbar">
        {onToggleNavigation && <button type="button" className="icon-btn" aria-label="打开主导航" onClick={onToggleNavigation}><IconPanel size={16} /></button>}
        {desktop ? (
          <div className="desktop-auto-heading">{tab === "tasks" ? "定时任务" : "运行记录"}</div>
        ) : <div className="hub-tabs">
          <button
            type="button"
            className={`pill ${tab === "tasks" ? "dark" : ""}`}
            onClick={() => setTab("tasks")}
          >
            <IconZap size={13} />
            定时任务
          </button>
          <button
            type="button"
            className={`pill ${tab === "history" ? "dark" : ""}`}
            onClick={() => setTab("history")}
          >
            <IconClock size={13} />
            运行记录
          </button>
        </div>}

        <div className="auto-toolbar-search">
          <IconSearch size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "tasks" ? "搜索自动化" : "搜索运行记录"}
            aria-label={tab === "tasks" ? "搜索自动化" : "搜索运行记录"}
          />
        </div>

        <div className="auto-toolbar-actions">
          {tab === "tasks" && (
            <>
              <button
                type="button"
                className={`btn auto-toolbar-btn ${batchMode ? "primary" : ""}`}
                onClick={() => {
                  setBatchMode((v) => !v);
                  if (desktop) setSelectedJobId(null);
                  setSelectedIds(new Set());
                  setMenuJobId(null);
                }}
              >
                批量管理
              </button>
              {!desktop && <>
              <button
                type="button"
                className="btn auto-toolbar-btn"
                onClick={() => setView("templates")}
              >
                从模版添加
              </button>
              <button
                type="button"
                className="btn primary auto-toolbar-btn"
                onClick={() => openCreate()}
              >
                <IconPlus size={14} /> 添加自动化
              </button>
              </>}
            </>
          )}
        </div>
      </div>

      {batchMode && tab === "tasks" && (
        <div className="auto-batch-bar">
          <span>已选 {selectedIds.size} 项</span>
          <button
            type="button"
            className="btn"
            disabled={busy || selectedIds.size === 0}
            onClick={() => void batchSetEnabled(true)}
          >
            启用
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || selectedIds.size === 0}
            onClick={() => void batchSetEnabled(false)}
          >
            暂停
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || selectedIds.size === 0}
            onClick={() => askBatchRemove()}
          >
            删除
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setBatchMode(false);
              setSelectedIds(new Set());
            }}
          >
            完成
          </button>
        </div>
      )}

      <div className="page-scroll">
        <div className="page-container auto-page auto-page-list">
          {!projectId && tab === "tasks" && (!desktop || !selectedJob) && !batchMode && (!query.trim() || "每周自我改进复盘".includes(query.trim())) &&
            <ImprovementAutomation onOpen={() => setView("review")}/>}
          {desktop && tab === "tasks" && selectedJob && !batchMode
            ? renderJobDetails(selectedJob)
            : desktop && tab === "history" && selectedRun
              ? renderRunDetails(selectedRun)
              : tab === "tasks" ? (
            visibleJobs.length === 0 ? (
              <div className="empty-block auto-empty">
                <div className="auto-empty-icon">
                  <IconClock size={36} />
                </div>
                <div className="empty-block-title">
                  {projectId
                    ? "还没有自动化任务，点击右上角「添加自动化」创建"
                    : "尚未添加定时任务"}
                </div>
                <div className="auto-empty-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setView("templates")}
                  >
                    从模版添加
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => openCreate()}
                  >
                    <IconPlus size={14} /> 添加自动化
                  </button>
                </div>
              </div>
            ) : filteredJobs.length === 0 ? (
              <div className="empty-block auto-empty">
                <div className="empty-block-title">无匹配的自动化任务</div>
              </div>
            ) : (
              <>
                {renderSection("运行中", grouped.running)}
                {renderSection("当前", grouped.current)}
                {renderSection("已暂停", grouped.paused)}
                {renderSection("已提醒", grouped.delivered)}
                {renderSection("已取消", grouped.cancelled)}
              </>
            )
          ) : filteredRuns.length === 0 ? (
            <div className="empty-block auto-empty">
              <div className="auto-empty-icon">
                <IconClock size={36} />
              </div>
              <div className="empty-block-title">{visibleRuns.length ? "无匹配的运行记录" : "暂无运行记录"}</div>
              {!visibleRuns.length && <div className="auto-empty-sub">创建并启用定时任务后，运行结果会显示在这里</div>}
            </div>
          ) : (
            <div className="auto-run-list">
              {filteredRuns.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    className={`auto-run-card ${run.taskId ? "clickable" : ""}`}
                    disabled={!run.taskId}
                    onClick={() => void openRunTask(run.taskId)}
                    title={run.taskId ? "打开对应任务会话" : undefined}
                  >
                    <span className={`auto-run-status ${run.status}`}>
                      {formatRunStatus(run.status)}
                    </span>
                    <div className="auto-run-body">
                      <div className="auto-run-title">
                        {jobNameById.get(run.jobId) ?? run.jobId}
                      </div>
                      <div className="auto-run-meta">
                        {new Date(run.startedAt).toLocaleString()}
                        {run.finishedAt
                          ? ` · 耗时 ${Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000))}s`
                          : ""}
                        {run.error ? ` · ${run.error}` : ""}
                        {run.taskId ? " · 点击查看会话" : ""}
                      </div>
                    </div>
                    {run.taskId && (
                      <IconChevronRight size={16} className="auto-run-chevron" />
                    )}
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>

      {variant === "modal" && (
        <footer className="project-auto-modal-foot">
          <button type="button" className="btn" onClick={() => onClose?.()}>
            关闭
          </button>
        </footer>
      )}

      <ConfirmDialog
        open={deleteConfirm != null}
        title="删除自动化任务"
        body={
          deleteConfirm?.mode === "batch" ? (
            <>
              确定删除选中的 <strong>{deleteConfirm.count}</strong> 个自动化任务？
              <br />
              <span style={{ color: "var(--fg-muted)", fontSize: 12.5 }}>
                已产生的运行记录与会话不会一并删除。
              </span>
            </>
          ) : (
            <>
              确定删除
              {deleteConfirm?.mode === "one" && deleteConfirm.name ? (
                <>
                  「<strong>{deleteConfirm.name}</strong>」
                </>
              ) : (
                "该"
              )}
              自动化任务？
              <br />
              <span style={{ color: "var(--fg-muted)", fontSize: 12.5 }}>
                删除后不可恢复；历史会话仍可在侧栏查看。
              </span>
            </>
          )
        }
        confirmLabel="删除"
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
