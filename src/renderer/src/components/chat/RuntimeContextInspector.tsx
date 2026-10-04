import { useEffect, useMemo, useState } from "react";
import {
  IconCheck,
  IconCopy,
  IconOpenExternal,
  IconPlay,
  IconPuzzle,
  IconRotate,
  IconStop,
  IconTrash,
  IconX,
} from "@/components/common/icons";
import type { AgentLoadoutObservationDto } from "@shared/agent-loadout";
import type {
  RuntimeContextInspectionDto,
  RuntimeContextSnapshotDto,
  RuntimeRequirementStateDto,
} from "@shared/agent-ipc";
import type { ProfessionalToolProviderId, ProfessionalToolStatusDto } from "@shared/professional-tools";
import { isManagedToolProvider, isRetiredManagedProvider } from "@shared/professional-tools";
import { RUNTIME_REQUIREMENT_DEFAULTS } from "@shared/runtime-requirement";
import { useAppStore } from "@/store/appStore";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { diffRuntimeAuditSnapshots, sanitizeRuntimeAuditSnapshot } from "@shared/runtime-audit-inspector";

const SOURCE_LABELS: Record<string, string> = {
  global: "Global",
  mode: "Mode",
  project: "Project",
  tag: "Tag",
  task: "Task",
};

const PROVIDER_LABELS: Record<string, string> = {
  penpot: "Penpot",
  "drawio-ai": "Draw.io",
};

const PHASE_RANK: Record<RuntimeRequirementStateDto["phase"], number> = {
  failed: 0,
  starting: 1,
  "waiting-backend": 2,
  ready: 3,
  idle: 4,
};

type RuntimeAction = "start" | "stop" | "restart" | "open";

function reasonLabel(reason?: string): string {
  if (!reason) return "已启用";
  if (reason === "global_disabled") return "全局已停用";
  if (reason === "mode_not_supported") return "当前 Mode 不支持";
  const source = reason.split("_")[0];
  if (reason.includes("not_allowed")) return `不在 ${SOURCE_LABELS[source] ?? source} 允许列表`;
  if (reason.includes("policy_denied")) return `被 ${SOURCE_LABELS[source] ?? source} Policy 拒绝`;
  return reason;
}

function phaseLabel(phase: RuntimeRequirementStateDto["phase"]): string {
  switch (phase) {
    case "ready":
      return "已就绪";
    case "starting":
      return "启动中";
    case "waiting-backend":
      return "等待后端";
    case "failed":
      return "启动失败";
    default:
      return "未启动";
  }
}

function launchLabel(launch: RuntimeRequirementStateDto["launch"]): string {
  if (launch === "gui") return "GUI";
  if (launch === "backend") return "服务";
  return "托管";
}

function providerLabel(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isFn(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function hasAgentRuntimeControl(): boolean {
  const agent = window.api?.agent;
  return isFn(agent?.startRuntimeRequirement) && isFn(agent?.stopRuntimeRequirement) && isFn(agent?.restartRuntimeRequirement);
}

function effectiveLaunch(state: Pick<RuntimeRequirementStateDto, "providerId" | "launch">): RuntimeRequirementStateDto["launch"] {
  if (state.launch !== "none") return state.launch;
  if (isManagedToolProvider(state.providerId)) return RUNTIME_REQUIREMENT_DEFAULTS[state.providerId].launchPolicy;
  return "none";
}

function phaseFromToolStatus(status: ProfessionalToolStatusDto): RuntimeRequirementStateDto["phase"] {
  if (status.ready) return "ready";
  if (status.state === "starting") return "starting";
  if (status.state === "error") return "failed";
  return "idle";
}

function asToolId(providerId: string): ProfessionalToolProviderId {
  return providerId as ProfessionalToolProviderId;
}

export default function RuntimeContextInspector(): React.JSX.Element | null {
  const open = useAppStore((state) => state.extensionSoftwareOpen);
  const onClose = useAppStore((state) => state.closeExtensionSoftware);
  const taskId = useAppStore((state) => state.activeTaskId);
  const [value, setValue] = useState<RuntimeContextInspectionDto | null>(null);
  const [snapshots, setSnapshots] = useState<RuntimeContextSnapshotDto[]>([]);
  const [loadoutObservations, setLoadoutObservations] = useState<AgentLoadoutObservationDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openProjectDetails = useAppStore((state) => state.openProjectDetails);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const [kindFilter, setKindFilter] = useState<"all" | "expert" | "skill" | "connector" | "mcp">("all");
  const [stateFilter, setStateFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [runtimeScope, setRuntimeScope] = useState<"current" | "all">("all");
  const [compareOlderId, setCompareOlderId] = useState("");
  const [compareNewerId, setCompareNewerId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingClear, setPendingClear] = useState<"task" | "all" | null>(null);
  const [runtimeStates, setRuntimeStates] = useState<RuntimeRequirementStateDto[]>([]);
  const [pendingById, setPendingById] = useState<Record<string, RuntimeAction>>({});
  const [statusOverrides, setStatusOverrides] = useState<Record<string, Partial<RuntimeRequirementStateDto>>>({});
  const agentControlReady = hasAgentRuntimeControl();

  const loadRuntimeStates = async (): Promise<void> => {
    try {
      const states = await window.api?.agent?.getRuntimeRequirementStates?.();
      setRuntimeStates(states ?? []);
    } catch {
      setRuntimeStates([]);
    }
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    void loadRuntimeStates();
    if (!taskId) {
      setValue(null);
      setSnapshots([]);
      setLoadoutObservations([]);
      setLoading(false);
      return;
    }
    try {
      const [next, history, loadoutHistory] = await Promise.all([
        window.api?.agent?.inspectRuntimeContext?.(taskId),
        window.api?.agent?.listRuntimeContextSnapshots?.(taskId, 30),
        window.api?.agent?.listAgentLoadoutObservations?.(taskId, 30),
      ]);
      if (!next) throw new Error("扩展软件接口未就绪");
      setValue(next);
      const nextSnapshots = history ?? [];
      setSnapshots(nextSnapshots);
      setLoadoutObservations(loadoutHistory ?? []);
      setCompareNewerId((current) =>
        nextSnapshots.some((snapshot) => snapshot.id === current) ? current : nextSnapshots[0]?.id || "",
      );
      setCompareOlderId((current) =>
        nextSnapshots.some((snapshot) => snapshot.id === current)
          ? current
          : nextSnapshots[1]?.id || nextSnapshots[0]?.id || "",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) void load();
    else {
      setValue(null);
      setSnapshots([]);
      setError(null);
      setRuntimeStates([]);
      setPendingById({});
      setStatusOverrides({});
      return undefined;
    }
    const unsub = window.api?.agent?.onRuntimeRequirementState?.(() => void loadRuntimeStates());
    return () => {
      unsub?.();
    };
  }, [open, taskId]);

  const currentTagId = value?.tag?.id;
  const visibleRuntimeStates = useMemo(
    () =>
      runtimeStates
        .filter((state) => !isRetiredManagedProvider(state.providerId))
        .map((state) => {
          const launch = effectiveLaunch(state);
          const override = statusOverrides[state.providerId];
          return { ...state, ...override, launch: override?.launch ?? launch };
        }),
    [runtimeStates, statusOverrides],
  );
  const grouped = useMemo(() => {
    const map = new Map<string, RuntimeContextInspectionDto["capabilities"]>();
    for (const capability of value?.capabilities ?? []) {
      if (kindFilter !== "all" && capability.kind !== kindFilter) continue;
      if (stateFilter === "enabled" && !capability.enabled) continue;
      if (stateFilter === "disabled" && capability.enabled) continue;
      const list = map.get(capability.kind) ?? [];
      list.push(capability);
      map.set(capability.kind, list);
    }
    return map;
  }, [kindFilter, stateFilter, value]);

  const sortedRuntimes = useMemo(() => {
    const tagged = visibleRuntimeStates.map((state) => ({
      ...state,
      current: Boolean(currentTagId && state.requiredBy?.includes(currentTagId)),
    }));
    const visible = runtimeScope === "current" && currentTagId
      ? tagged.filter((state) => state.current)
      : tagged;
    return [...visible].sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      const phase = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
      if (phase !== 0) return phase;
      return providerLabel(a.providerId).localeCompare(providerLabel(b.providerId), "zh");
    });
  }, [currentTagId, runtimeScope, visibleRuntimeStates]);

  const currentRequired = useMemo(
    () => visibleRuntimeStates.filter((state) => currentTagId && state.requiredBy?.includes(currentTagId)),
    [currentTagId, visibleRuntimeStates],
  );
  const currentStartable = currentRequired.filter(
    (state) => state.launch !== "none" && (state.phase === "idle" || state.phase === "failed"),
  );
  const compareOlder = snapshots.find((snapshot) => snapshot.id === compareOlderId);
  const compareNewer = snapshots.find((snapshot) => snapshot.id === compareNewerId);
  const comparison = compareOlder && compareNewer ? diffRuntimeAuditSnapshots(compareOlder, compareNewer) : [];
  const totalStorageBytes = snapshots.reduce((total, snapshot) => total + snapshot.storageBytes, 0);

  const setPending = (providerId: string, action: RuntimeAction | null): void => {
    setPendingById((current) => {
      if (action) return { ...current, [providerId]: action };
      const next = { ...current };
      delete next[providerId];
      return next;
    });
  };

  const overlayFromToolStatus = (providerId: string, status: ProfessionalToolStatusDto | undefined): void => {
    if (!status) return;
    setStatusOverrides((current) => ({
      ...current,
      [providerId]: {
        phase: phaseFromToolStatus(status),
        detail: status.detail ?? current[providerId]?.detail ?? null,
        lastAttemptAt: Date.now(),
      },
    }));
  };

  const readToolStatus = async (providerId: string): Promise<ProfessionalToolStatusDto | undefined> => {
    if (!isFn(window.api?.professionalTools?.status)) return undefined;
    return window.api.professionalTools.status(asToolId(providerId));
  };

  const runRuntimeAction = async (providerId: string, action: RuntimeAction): Promise<void> => {
    if (pendingById[providerId]) return;
    setPending(providerId, action);
    const name = providerLabel(providerId);
    try {
      if (action === "start") {
        if (isFn(window.api?.agent?.startRuntimeRequirement)) {
          await window.api.agent.startRuntimeRequirement(providerId);
          setNotice(`已请求启动 ${name}`);
        } else if (isFn(window.api?.professionalTools?.open)) {
          setStatusOverrides((current) => ({
            ...current,
            [providerId]: { phase: "starting", detail: "正在启动…", lastAttemptAt: Date.now() },
          }));
          const result = await window.api.professionalTools.open(asToolId(providerId));
          if (result && result.ok === false) throw new Error(result.error || "启动失败");
          overlayFromToolStatus(providerId, result?.status ?? await readToolStatus(providerId));
          setNotice(`已启动 ${name}（兼容通道：当前窗口主进程较旧，建议完全退出后重开 MyBuddy）`);
        } else {
          throw new Error("启动接口未就绪，请完全退出并重新打开 MyBuddy（仅刷新页面不够）");
        }
      } else if (action === "stop") {
        if (isFn(window.api?.agent?.stopRuntimeRequirement)) {
          await window.api.agent.stopRuntimeRequirement(providerId);
          setNotice(`已停止 ${name}`);
        } else if (isFn(window.api?.professionalTools?.stop)) {
          const status = await window.api.professionalTools.stop(asToolId(providerId));
          overlayFromToolStatus(providerId, status);
          setNotice(status.ready ? `${name} 仍在运行（外部已打开的进程不会被强制关闭）` : `已停止 ${name}`);
        } else {
          throw new Error("停止接口未就绪，请完全退出并重新打开 MyBuddy");
        }
      } else if (action === "restart") {
        if (isFn(window.api?.agent?.restartRuntimeRequirement)) {
          await window.api.agent.restartRuntimeRequirement(providerId);
          const after = await readToolStatus(providerId);
          overlayFromToolStatus(providerId, after);
          setNotice(after?.ready ? `已重启 ${name}` : `已发出重启 ${name}，正在等待就绪`);
        } else if (isFn(window.api?.professionalTools?.stop) && isFn(window.api?.professionalTools?.open)) {
          setStatusOverrides((current) => ({
            ...current,
            [providerId]: { phase: "starting", detail: "正在重启…", lastAttemptAt: Date.now() },
          }));
          await window.api.professionalTools.stop(asToolId(providerId));
          const result = await window.api.professionalTools.open(asToolId(providerId));
          if (result && result.ok === false) throw new Error(result.error || "重启失败");
          overlayFromToolStatus(providerId, result?.status ?? await readToolStatus(providerId));
          setNotice(`已重启 ${name}（兼容通道）`);
        } else {
          throw new Error("重启接口未就绪，请完全退出并重新打开 MyBuddy（仅刷新页面不够）");
        }
      } else if (isFn(window.api?.professionalTools?.open)) {
        const result = await window.api.professionalTools.open(asToolId(providerId));
        if (result && result.ok === false) throw new Error(result.error || "打开失败");
        overlayFromToolStatus(providerId, result?.status);
        setNotice(`已打开 ${name}`);
      } else {
        throw new Error("打开接口未就绪，请完全退出并重新打开 MyBuddy");
      }
      if (agentControlReady) await loadRuntimeStates();
    } catch (cause) {
      setNotice(`${name} ${action === "open" ? "打开" : action === "stop" ? "停止" : action === "restart" ? "重启" : "启动"}失败：${errorMessage(cause)}`);
    } finally {
      setPending(providerId, null);
    }
  };

  const probeRuntime = async (providerId: string): Promise<void> => {
    if (pendingById[providerId]) return;
    setPending(providerId, "start");
    const name = providerLabel(providerId);
    try {
      if (isFn(window.api?.agent?.startRuntimeRequirement)) {
        await window.api.agent.startRuntimeRequirement(providerId);
      }
      const status = await readToolStatus(providerId);
      overlayFromToolStatus(providerId, status);
      if (!status && !isFn(window.api?.agent?.startRuntimeRequirement)) {
        throw new Error("探测接口未就绪，请完全退出并重新打开 MyBuddy（仅刷新页面不够）");
      }
      setNotice(
        status
          ? `${name} 探测：${status.ready ? "已就绪" : "未就绪"}${status.detail ? ` · ${status.detail}` : ""}`
          : `已探测 ${name}`,
      );
      if (agentControlReady) await loadRuntimeStates();
    } catch (cause) {
      setNotice(`${name} 探测失败：${errorMessage(cause)}`);
    } finally {
      setPending(providerId, null);
    }
  };

  const startCurrentRequired = async (): Promise<void> => {
    if (currentStartable.length === 0) return;
    setNotice(`正在启动当前 Tag 所需的 ${currentStartable.length} 个运行环境…`);
    await Promise.all(currentStartable.map((state) => runRuntimeAction(state.providerId, "start")));
  };

  const copyRedacted = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({
        exportedAt: Date.now(),
        taskId,
        snapshots: snapshots.map(sanitizeRuntimeAuditSnapshot),
        loadoutObservations,
      }, null, 2));
      setNotice("已复制脱敏 Audit JSON（含 Loadout evidence）；指令正文与原始 Prompt 未导出");
    } catch (cause) {
      setNotice(`复制失败：${errorMessage(cause)}`);
    }
  };

  const clearAudit = async (all: boolean): Promise<void> => {
    if (!all && !taskId) return;
    const removed = await window.api?.agent?.clearRuntimeAudit?.(all ? undefined : taskId ?? undefined);
    setNotice(removed ? `已清除 ${removed.total} 条 Audit（Runtime ${removed.runtimeSnapshots} / Loadout ${removed.loadoutObservations}）` : "Audit 清理接口未就绪");
    await load();
  };

  if (!open) return null;
  return (
    <div className="modal-overlay runtime-inspector-overlay" onClick={onClose}>
      <section className="runtime-inspector" role="dialog" aria-modal="true" aria-label="扩展软件" onClick={(event) => event.stopPropagation()}>
        <header className="runtime-inspector-head">
          <div>
            <div className="runtime-inspector-title"><IconPuzzle size={16} /> 扩展软件</div>
            <div className="runtime-inspector-sub">管理本机扩展软件的启动与状态。</div>
          </div>
          <div className="runtime-inspector-actions">
            <button className="icon-btn" type="button" title="刷新" onClick={() => void load()} disabled={loading}><IconRotate size={14} /></button>
            <button className="icon-btn" type="button" title="关闭" onClick={onClose}><IconX size={15} /></button>
          </div>
        </header>
        <div className="runtime-inspector-body">
          {loading && !value && runtimeStates.length === 0 && <div className="runtime-inspector-empty">正在加载扩展软件…</div>}
          {error && <div className="project-form-error">{error}</div>}
          {notice && <div className="runtime-inspector-notice">{notice}</div>}
          {value && (
            <div className="runtime-inspector-summary">
              <div>
                <span>Mode</span>
                <strong>{value.mode.label}</strong>
                <code>{value.mode.id}</code>
              </div>
              <div>
                <span>Project</span>
                <strong>{value.project?.name ?? "未绑定"}</strong>
                {value.project?.archived && <code>archived</code>}
                {value.project && (
                  <button type="button" className="btn runtime-inspector-mini-btn" onClick={() => { onClose(); openProjectDetails(value.project!.id); }}>
                    打开项目
                  </button>
                )}
              </div>
              <div>
                <span>Tag</span>
                <strong>{value.tag?.label ?? "未选择"}</strong>
                {value.tag && <code>{value.tag.id}</code>}
              </div>
            </div>
          )}

          <div className="runtime-inspector-section">
            {!agentControlReady && (
              <div className="runtime-inspector-notice runtime-inspector-restart-hint">
                启停走兼容通道：当前窗口还是旧主进程。要让「启动 / 重启 / 探测」与状态完全同步，请完全退出 MyBuddy 再打开（只刷新页面不够）。
              </div>
            )}
            <div className="runtime-inspector-section-head">
              <h3>运行环境</h3>
              <span className="runtime-inspector-runtime-toolbar">
                <div className="runtime-scope-toggle" role="group" aria-label="运行环境范围">
                  <button
                    type="button"
                    className={runtimeScope === "current" ? "active" : ""}
                    onClick={() => setRuntimeScope("current")}
                    disabled={!currentTagId}
                  >
                    当前所需{currentTagId ? ` ${currentRequired.length}` : ""}
                  </button>
                  <button
                    type="button"
                    className={runtimeScope === "all" ? "active" : ""}
                    onClick={() => setRuntimeScope("all")}
                  >
                    全部 {runtimeStates.length}
                  </button>
                </div>
                <button
                  type="button"
                  className="btn runtime-inspector-mini-btn"
                  disabled={currentStartable.length === 0}
                  onClick={() => void startCurrentRequired()}
                >
                  <IconPlay size={11} /> 启动当前所需
                </button>
              </span>
            </div>
            {currentTagId && runtimeScope === "current" && currentRequired.length === 0 && (
              <div className="runtime-inspector-empty">当前 Tag 没有声明必需运行环境</div>
            )}
            {!loading && runtimeStates.length === 0 && (
              <div className="runtime-inspector-empty">暂无扩展软件</div>
            )}
            <div className="runtime-state-list">
              {sortedRuntimes.map((state) => {
                const pending = pendingById[state.providerId];
                const busy = Boolean(pending) || state.phase === "starting" || state.phase === "waiting-backend";
                const canStart = state.launch !== "none" && (state.phase === "idle" || state.phase === "failed");
                const canStop = state.phase !== "idle";
                const canRestart = state.launch !== "none" && state.phase === "ready";
                const canOpen = state.phase === "ready";
                return (
                  <div key={state.providerId} className={`runtime-state-card phase-${state.phase}${state.current ? " current" : ""}`}>
                    <div className="runtime-state-card-main">
                      <div className="runtime-state-card-id">
                        <strong>{providerLabel(state.providerId)}</strong>
                        <code>{state.providerId}</code>
                        <span className="runtime-state-launch">{launchLabel(state.launch)}</span>
                        {state.current && <span className="runtime-state-current">当前所需</span>}
                      </div>
                      <span className={`runtime-state-pill phase-${state.phase}`}>
                        <span className="runtime-state-dot" />
                        {pending === "start" || pending === "restart" ? "处理中" : phaseLabel(state.phase)}
                      </span>
                    </div>
                    {state.detail && (
                      <div className="runtime-state-detail" title={state.detail}>{state.detail}</div>
                    )}
                    <div className="runtime-state-actions">
                      {canStart && (
                        <button
                          type="button"
                          className={`btn runtime-inspector-mini-btn${state.phase === "failed" ? " primary" : ""}`}
                          disabled={Boolean(pending)}
                          onClick={() => void runRuntimeAction(state.providerId, "start")}
                        >
                          <IconPlay size={11} /> {state.phase === "failed" ? "重试" : "启动"}
                        </button>
                      )}
                      {canRestart && (
                        <button
                          type="button"
                          className="btn runtime-inspector-mini-btn"
                          disabled={Boolean(pending) || busy}
                          onClick={() => void runRuntimeAction(state.providerId, "restart")}
                        >
                          <IconRotate size={11} /> 重启
                        </button>
                      )}
                      {canOpen && (
                        <button
                          type="button"
                          className="btn runtime-inspector-mini-btn"
                          disabled={Boolean(pending)}
                          onClick={() => void runRuntimeAction(state.providerId, "open")}
                        >
                          <IconOpenExternal size={11} /> 打开
                        </button>
                      )}
                      {canStop && (
                        <button
                          type="button"
                          className="btn runtime-inspector-mini-btn"
                          disabled={Boolean(pending)}
                          onClick={() => void runRuntimeAction(state.providerId, "stop")}
                        >
                          <IconStop size={11} /> {pending === "stop" ? "停止中" : "停止"}
                        </button>
                      )}
                      {state.launch === "none" && (state.phase === "idle" || state.phase === "failed") && (
                        <button
                          type="button"
                          className="btn runtime-inspector-mini-btn"
                          disabled={Boolean(pending)}
                          onClick={() => void probeRuntime(state.providerId)}
                        >
                          探测
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {value && (
            <>
              <div className="runtime-inspector-section">
                <div className="runtime-inspector-toolbar">
                  <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)}>
                    <option value="all">全部能力</option>
                    <option value="expert">Expert</option>
                    <option value="skill">Skill</option>
                    <option value="connector">Connector</option>
                    <option value="mcp">MCP</option>
                  </select>
                  <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}>
                    <option value="all">全部状态</option>
                    <option value="enabled">仅启用</option>
                    <option value="disabled">仅禁用</option>
                  </select>
                  <button type="button" className="btn runtime-inspector-mini-btn" onClick={() => { onClose(); setSettingsOpen(true, "modes"); }}>
                    打开 Mode / Tag 配置
                  </button>
                </div>
              </div>

              <div className="runtime-inspector-section">
                <h3>Agent Loadout <small>推荐 ≠ 自动应用</small></h3>
                <div className="runtime-inspector-empty">
                  基于任务标题 / Project / Mode / Tag / Memory / Skill effectiveness 的确定性推荐。Policy deny、disabled 和 allowlist 永远是硬门禁。
                </div>
                <div className="runtime-capability-list">
                  {value.loadout.capabilities.map((item) => (
                    <div className={`runtime-capability-row ${item.blocked ? "disabled" : item.actual ? "enabled" : ""}`} key={`loadout:${item.kind}:${item.id}`}>
                      <span className="runtime-capability-state">{item.blocked ? <IconX size={13} /> : item.actual ? <IconCheck size={13} /> : "→"}</span>
                      <div className="runtime-capability-main">
                        <strong>{item.kind}:{item.label}</strong>
                        <small>score {item.score.toFixed(2)} · {item.recommended ? "recommended" : "actual-only"} · {item.actual ? "actual" : "not selected"}{item.blocked ? ` · blocked ${item.blockReason ?? ""}` : ""}</small>
                        {item.evidence.length > 0 && <small>{item.evidence.map((e) => e.label).join(" · ")}</small>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="runtime-inspector-empty">
                  推荐 {value.loadout.summary.recommended} · 推荐∩实际 {value.loadout.summary.matchedActual} · 未选择 {value.loadout.summary.notSelected} · 被策略阻断 {value.loadout.summary.blocked}
                  {value.loadout.modelSuggestion ? ` · 模型建议 ${value.loadout.modelSuggestion}` : ""}
                  {value.loadout.permissionSuggestion ? ` · 权限建议 ${value.loadout.permissionSuggestion}` : ""}
                </div>
                {loadoutObservations.length > 0 && (
                  <details className="runtime-snapshot">
                    <summary>Loadout Observation · 最近 {loadoutObservations.length} 轮</summary>
                    {loadoutObservations.slice(0, 10).map((obs) => (
                      <div className="runtime-snapshot-meta" key={obs.id}>
                        {new Date(obs.createdAt).toLocaleString()} · {obs.outcome} · 推荐 {obs.recommended.length} · 匹配实际 {obs.matchedActual.length} · 未选 {obs.notSelected.length} · blocked {obs.blocked.length} · 实际使用 Skill {obs.usedSkillIds.length ? obs.usedSkillIds.join(", ") : "无"}
                        <br />
                        <small>{obs.context.mode}{obs.context.tagId ? ` / ${obs.context.tagId}` : ""} · Memory {obs.context.memoryIds.length} · Scenario {obs.context.scenarioIds.length} · Profile {obs.context.profileIds.length}</small>
                        {obs.recommended.length > 0 && <><br /><small>{obs.recommended.map((item) => `${item.kind}:${item.id} ← ${item.evidence.map((e) => e.label).join(" / ") || "无 evidence"}`).join("；")}</small></>}
                      </div>
                    ))}
                  </details>
                )}
              </div>

              <div className="runtime-inspector-section">
                <h3>Assembly Fingerprint</h3>
                <code title={value.assemblyHash}>{value.assemblyHash.slice(0, 16)}</code>
                {value.latestExecution && (
                  <div className={value.latestExecution.differsFromCurrent ? "runtime-warning" : "runtime-inspector-empty"}>
                    {value.latestExecution.differsFromCurrent
                      ? `当前配置与上次执行不同：${value.latestExecution.changes.join("；") || "assembly hash changed"}`
                      : "当前配置与上次执行一致"}
                  </div>
                )}
              </div>

              <div className="runtime-inspector-section">
                <h3>指令来源</h3>
                <div className="runtime-instruction-list">
                  {value.instructions.map((segment) => (
                    <div className="runtime-instruction-row" key={`${segment.id}:${segment.sourceId ?? ""}`}>
                      <span>{segment.title}</span>
                      <code>{segment.source}{segment.sourceId ? ` · ${segment.sourceId}` : ""}</code>
                      <small>{segment.chars} 字符</small>
                    </div>
                  ))}
                </div>
              </div>

              {["expert", "skill", "connector", "mcp"].filter((kind) => kindFilter === "all" || kind === kindFilter).map((kind) => {
                const items = grouped.get(kind) ?? [];
                const enabledCount = items.filter((item) => item.enabled).length;
                return (
                  <div className="runtime-inspector-section" key={kind}>
                    <h3>
                      {kind === "mcp" ? "MCP" : `${kind[0].toUpperCase()}${kind.slice(1)}`}
                      {items.length > 0 && <small>{enabledCount}/{items.length} 启用</small>}
                    </h3>
                    {items.length === 0 ? (
                      <div className="runtime-inspector-empty">无候选项</div>
                    ) : (
                      <div className="runtime-capability-list">
                        {items.map((item) => {
                          const projectDenied = !item.enabled && item.sources.some((source) => source.source === "project") && value.project;
                          const modeDenied = !item.enabled && item.sources.some((source) => source.source === "tag" || source.source === "mode");
                          return (
                            <div className={`runtime-capability-row ${item.enabled ? "enabled" : "disabled"}`} key={`${kind}:${item.id}`}>
                              <span className="runtime-capability-state">{item.enabled ? <IconCheck size={13} /> : <IconX size={13} />}</span>
                              <div className="runtime-capability-main">
                                <strong>{item.id}</strong>
                                <small>{item.sources.map((source) => `${SOURCE_LABELS[source.source] ?? source.source}:${source.decision}`).join(" → ") || "无策略来源"}</small>
                              </div>
                              <span className="runtime-capability-reason">{reasonLabel(item.reason)}</span>
                              {(projectDenied || modeDenied) && (
                                <button
                                  type="button"
                                  className="btn runtime-inspector-mini-btn"
                                  onClick={() => {
                                    onClose();
                                    if (projectDenied && value.project) openProjectDetails(value.project.id);
                                    else setSettingsOpen(true, "modes");
                                  }}
                                >
                                  去配置
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {value.warnings.length > 0 && (
                <div className="runtime-inspector-section">
                  <h3>Warnings</h3>
                  {value.warnings.map((warning) => <div className="runtime-warning" key={warning}>{warning}</div>)}
                </div>
              )}

              <div className="runtime-inspector-section">
                <div className="runtime-inspector-section-head">
                  <h3>Execution Snapshot / Audit · {snapshots.length} · {(totalStorageBytes / 1024).toFixed(1)} KiB</h3>
                  <span>
                    <button type="button" className="btn runtime-inspector-mini-btn" disabled={!snapshots.length} onClick={() => void copyRedacted()}><IconCopy size={12} /> 复制脱敏 JSON</button>
                    <button type="button" className="btn runtime-inspector-mini-btn danger" disabled={!snapshots.length} onClick={() => setPendingClear("task")}><IconTrash size={12} /> 清除此任务</button>
                    <button type="button" className="btn runtime-inspector-mini-btn danger" onClick={() => setPendingClear("all")}>清除全部</button>
                  </span>
                </div>
                {snapshots.length === 0 && <div className="runtime-inspector-empty">还没有真实执行快照</div>}
                {snapshots.length >= 2 && (
                  <div className="runtime-audit-compare">
                    <select value={compareOlderId} onChange={(event) => setCompareOlderId(event.target.value)}>
                      {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.createdAt).toLocaleString()}</option>)}
                    </select>
                    <span>对比</span>
                    <select value={compareNewerId} onChange={(event) => setCompareNewerId(event.target.value)}>
                      {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.createdAt).toLocaleString()}</option>)}
                    </select>
                    <div>{comparison.length ? comparison.map((change) => <small key={change}>{change}</small>) : <small>两次装配无差异</small>}</div>
                  </div>
                )}
                <div className="runtime-snapshot-list">
                  {snapshots.map((snapshot) => (
                    <details className="runtime-snapshot" key={snapshot.id}>
                      <summary>
                        <span>{new Date(snapshot.createdAt).toLocaleString()}</span>
                        <code>{snapshot.mode}{snapshot.tagId ? ` · ${snapshot.tagId}` : ""}</code>
                        <small>{snapshot.resolvedCapabilities.filter((item) => item.enabled).length}/{snapshot.resolvedCapabilities.length} 能力启用</small>
                      </summary>
                      <div className="runtime-snapshot-meta">状态：{snapshot.status} · Execution：{snapshot.executionId} · Hash：{snapshot.assemblyHash.slice(0, 12)} · 存储：{snapshot.storageBytes} B · Project：{snapshot.projectId ?? "未绑定"}{snapshot.projectUpdatedAt ? ` · revision ${snapshot.projectUpdatedAt}` : ""}{snapshot.error ? ` · ${snapshot.error}` : ""}</div>
                      {snapshot.resolvedInstructions.map((segment) => (
                        <div className="runtime-instruction-row" key={`${snapshot.id}:${segment.id}`}>
                          <span>{segment.title}</span>
                          <code>{segment.source}{segment.sourceId ? ` · ${segment.sourceId}` : ""}</code>
                          <small>{segment.chars} 字符 · {segment.storage === "full" ? "全文" : `摘要 ${segment.storedChars}`} · {segment.contentHash.slice(0, 10)}</small>
                        </div>
                      ))}
                      {snapshot.resolvedCapabilities.filter((item) =>
                        (kindFilter === "all" || item.kind === kindFilter) &&
                        (stateFilter === "all" || (stateFilter === "enabled" ? item.enabled : !item.enabled))
                      ).map((item) => (
                        <div className={`runtime-capability-row ${item.enabled ? "enabled" : "disabled"}`} key={`${snapshot.id}:${item.kind}:${item.id}`}>
                          <span className="runtime-capability-state">{item.enabled ? <IconCheck size={13} /> : <IconX size={13} />}</span>
                          <div className="runtime-capability-main">
                            <strong>{item.kind}:{item.id}</strong>
                            <small>{item.sources.map((source) => `${SOURCE_LABELS[source.source] ?? source.source}:${source.decision}`).join(" → ") || "无策略来源"}</small>
                          </div>
                          <span className="runtime-capability-reason">{reasonLabel(item.reason)}</span>
                        </div>
                      ))}
                      {snapshot.warnings.map((warning) => <div className="runtime-warning" key={`${snapshot.id}:${warning}`}>{warning}</div>)}
                    </details>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </section>
      <ConfirmDialog
        open={pendingClear !== null}
        title="清除 Runtime Audit？"
        body={pendingClear === "all"
          ? "将清除全部任务的 Runtime Audit 与 Loadout Observation，此操作不可恢复。"
          : "将清除当前任务的 Runtime Audit 与 Loadout Observation，此操作不可恢复。"}
        confirmLabel="清除"
        danger
        onCancel={() => setPendingClear(null)}
        onConfirm={() => {
          const scope = pendingClear;
          setPendingClear(null);
          if (scope) void clearAudit(scope === "all");
        }}
      />
    </div>
  );
}
