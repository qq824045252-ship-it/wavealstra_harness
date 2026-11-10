/**
 * RuntimeObservatory — 「概览」顶部的当前任务 Runtime Observatory。
 *
 * 三个紧凑 section：当前任务（主 Agent）/ 子代理 / 后台任务。
 * - 运行中子代理点击 → 复用现有 SubagentDrawer（openSubagentDrawer），不造第二套 chat；
 * - 完成态子代理是当前 task 聊天时间线的短暂派生（Subagent 本体仍 disposable）；
 * - 事件驱动：subagent.onEvent 刷新 active 列表；elapsed 文本用本地 1s tick；
 *   组件卸载/任务切换必须清理 timer 与订阅（taskId ref 防旧任务响应污染）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { currentTerminalOwnerKey, useAppStore } from "@/store/appStore";
import type { SubagentSummaryDto } from "@shared/agent-ipc";
import type { SubagentUsage } from "@shared/subagent-model-config";
import type { ExternalAgentRunDto } from "@shared/external-agent";
import { modelBadgeTitle, type ModelBadge } from "@/lib/modelBadge";
import {
  buildRuntimeOverview,
  formatElapsed,
  readableRole,
  subagentUsageFields,
  subagentUsageTitle,
  oneLine,
  type RuntimeOverviewVm,
} from "./overviewRuntime";
import { IconUsers, IconBot } from "@/components/common/icons";

function SectionTitle({ children, count }: { children: string; count?: number }): React.JSX.Element {
  return (
    <div className="ro-section-title">
      <span>{children}</span>
      {count !== undefined && count > 0 && <span className="ro-count">{count}</span>}
    </div>
  );
}

function Dot({ state }: { state: "running" | "ok" | "err" | "idle" }): React.JSX.Element {
  return <span className={`ro-dot ro-dot--${state}`} aria-hidden />;
}

/**
 * 子代理累计用量的四个参数：输入 / 缓存读 / 输出 / 缓存命中率。
 * 独立一行并允许折行：窄面板下宁可两行，也不压缩数值或溢出。
 */
function UsageGrid({ usage }: { usage?: SubagentUsage }): React.JSX.Element | null {
  if (!usage) return null;
  return (
    <span className="ro-usage" title={subagentUsageTitle(usage)}>
      {subagentUsageFields(usage).map((field) => (
        <span key={field.key} className={`ro-usage-item${field.tone && field.tone !== "normal" ? ` ro-usage-item--${field.tone}` : ""}`}>
          {field.label} <b>{field.value}</b>
        </span>
      ))}
    </span>
  );
}

/** 模型标签：显示在智能体名称下方一行（面板窄时也放得下完整名称）；完整标识与来源在 title。 */
function ModelChip({ badge }: { badge?: ModelBadge }): React.JSX.Element | null {
  if (!badge) return null;
  return (
    <span className="ro-model" title={modelBadgeTitle(badge)}>
      {badge.label}
    </span>
  );
}

export default function RuntimeObservatory(): React.JSX.Element | null {
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const tasks = useAppStore((s) => s.tasks);
  const terminalSessions = useAppStore((s) => s.terminalSessions);
  const activeModelId = useAppStore((s) => s.activeModelId);
  const models = useAppStore((s) => s.models);
  const openSubagentDrawer = useAppStore((s) => s.openSubagentDrawer);
  const [expandedDoneId, setExpandedDoneId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const currentTask = useMemo(() => tasks.find((t) => t.id === activeTaskId) ?? null, [tasks, activeTaskId]);
  const messages = currentTask?.messages ?? [];
  // 模型目录 id → 展示名：只用于把 provider/model 显示成用户认识的名字
  const modelNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const model of models ?? []) {
      const id = (model?.id ?? "").trim();
      if (id) map[id] = model.name;
    }
    return map;
  }, [models]);
  const mainModel = useMemo(
    () => ({ id: activeModelId, name: activeModelId ? modelNames[activeModelId] : undefined }),
    [activeModelId, modelNames],
  );

  // 运行中子代理（按 taskId 作用域过滤；事件驱动刷新）
  const [activeSubagents, setActiveSubagents] = useState<SubagentSummaryDto[]>([]);
  const [activeExternalAgents, setActiveExternalAgents] = useState<ExternalAgentRunDto[]>([]);
  const taskIdRef = useRef<string | null>(null);
  taskIdRef.current = activeTaskId;

  useEffect(() => {
    if (!activeTaskId) {
      setActiveSubagents([]);
      return;
    }
    let disposed = false;
    const fetchActive = async (): Promise<void> => {
      try {
        const list = await window.api?.subagent?.active?.(activeTaskId);
        // 竞态防御：旧任务的事件/响应不得污染新任务
        // （列表本身已按 taskId 过滤，这里再加一道 taskId 校验）
        if (!disposed && taskIdRef.current === activeTaskId) setActiveSubagents(list ?? []);
      } catch {
        if (!disposed && taskIdRef.current === activeTaskId) setActiveSubagents([]);
      }
    };
    void fetchActive();
    const unsub = window.api?.subagent?.onEvent?.(() => void fetchActive());
    return () => {
      disposed = true;
      unsub?.();
    };
  }, [activeTaskId]);

  useEffect(() => {
    if (!activeTaskId) {
      setActiveExternalAgents([]);
      return;
    }
    let disposed = false;
    const fetchActive = async (): Promise<void> => {
      try {
        const list = await window.api?.externalAgent?.active?.(activeTaskId);
        if (!disposed && taskIdRef.current === activeTaskId) setActiveExternalAgents(list ?? []);
      } catch {
        if (!disposed && taskIdRef.current === activeTaskId) setActiveExternalAgents([]);
      }
    };
    void fetchActive();
    const unsub = window.api?.externalAgent?.onEvent?.((event) => {
      if (event.taskId === activeTaskId) void fetchActive();
    });
    return () => {
      disposed = true;
      unsub?.();
    };
  }, [activeTaskId]);
  // elapsed 文本本地 tick：仅当存在运行中条目（有 elapsed 需要自然更新）才启动，
  // 空闲概览不产生无意义重渲染；组件销毁/无运行项时清理（不触发 IPC/重 fetch）
  const [now, setNow] = useState(() => Date.now());
  const vm: RuntimeOverviewVm = useMemo(
    () =>
      buildRuntimeOverview({
        taskId: activeTaskId ?? "",
        workspaceId: currentTask?.spaceId,
        messages,
        activeSubagents,
        terminalSessions,
        now,
        mainModel,
        modelNames,
      }),
    [activeTaskId, currentTask?.spaceId, messages, activeSubagents, terminalSessions, now, mainModel, modelNames],
  );
  const hasRunning =
    vm.runningSubagents.length > 0 || activeExternalAgents.length > 0 || vm.backgroundTasks.some((t) => t.state === "running");
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  const subagentCount = vm.runningSubagents.length + vm.queuedSubagents.length + vm.doneSubagents.length;
  const empty =
    vm.runningSubagents.length === 0 && vm.queuedSubagents.length === 0 && vm.doneSubagents.length === 0
    && activeExternalAgents.length === 0 && vm.backgroundTasks.length === 0;

  if (!activeTaskId) return null;

  return (
    <div className="ro-root">
      {/* 当前任务 / 主 Agent */}
      <SectionTitle>当前任务</SectionTitle>
      <div className="ro-row ro-row--main">
        <span className="ro-status-col">
          <Dot state={vm.mainAgent.state === "working" ? "running" : "ok"} />
        </span>
        <div className="ro-main-info">
          <div className="ro-main-name">
            <IconBot size={13} /> 主 Agent
            <span className={`ro-label ro-label--${vm.mainAgent.state}`}>{vm.mainAgent.label}</span>
          </div>
          <ModelChip badge={vm.mainAgent.model} />
          {vm.mainAgent.action && <div className="ro-sub">{vm.mainAgent.action}</div>}
        </div>
      </div>

      {/* 子代理（运行中 + 完成态，task 生命周期内） */}
      {subagentCount > 0 && (
        <>
          <SectionTitle count={subagentCount}>子代理</SectionTitle>
          {/* 排队口径：并行派发请求了 N 个、实际只开了 M 个时，用户必须看得到差额与原因 */}
          {vm.subagentConcurrency && vm.subagentConcurrency.queued > 0 && (
            <div className="ro-hint">
              <span>{vm.subagentConcurrency.workers} 并发 · {vm.subagentConcurrency.queued} 排队</span>
              {vm.subagentConcurrency.serializedReason && (
                <span className="ro-hint-detail">{vm.subagentConcurrency.serializedReason}</span>
              )}
            </div>
          )}
          <ul className="ro-list ro-list--subagents">
            {vm.runningSubagents.map((s) => (
              <li key={`run:${s.id}`} className="ro-row">
                <span className="ro-status-col">
                  <Dot state="running" />
                </span>
                <button
                  className="ro-row-main ro-btn"
                  title="打开临时 Chat（steer / 中止）"
                  onClick={() => openSubagentDrawer(s.id)}
                >
                  <span className="ro-item-head">
                    <span className="ro-name" title={s.displayName ? `id: ${s.id}` : undefined}>
                      <IconUsers size={12} /> {s.displayName || s.role}
                    </span>
                    {s.elapsedMs >= 0 && <span className="ro-elapsed">{formatElapsed(s.elapsedMs)}</span>}
                  </span>
                  <ModelChip badge={s.model} />
                  <UsageGrid usage={s.usage} />
                  <span className="ro-sub">{s.work}</span>
                </button>
              </li>
            ))}
            {vm.queuedSubagents.map((q) => (
              <li key={`queued:${q.id}`} className="ro-row ro-row--queued">
                <span className="ro-status-col">
                  <Dot state="idle" />
                </span>
                <div className="ro-row-main" title="已计划，等待并发名额；子会话创建后才可打开临时 Chat">
                  <span className="ro-item-head">
                    <span className="ro-name" title={`id: ${q.id}`}>
                      <IconUsers size={12} /> {q.displayName || q.role}
                    </span>
                    <span className="ro-label ro-label--queued">排队中</span>
                  </span>
                  <span className="ro-sub" title={q.task}>{q.task || "等待并发名额"}</span>
                </div>
              </li>
            ))}
            {vm.doneSubagents.map((d) => {
              const isExpanded = expandedDoneId === d.id;
              return (
                <li key={`done:${d.id}`} className={`ro-row ro-row--done ${isExpanded ? "expanded" : ""}`}>
                  <span className="ro-status-col">
                    <Dot state={d.state === "completed" ? "ok" : "err"} />
                  </span>
                  <div
                    className="ro-row-main ro-btn ro-btn--done"
                    role="button"
                    tabIndex={0}
                    title={isExpanded ? "点击收起详情" : "点击查看该子代理任务目标与完整执行结果"}
                    onClick={() => setExpandedDoneId(isExpanded ? null : d.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setExpandedDoneId(isExpanded ? null : d.id);
                      }
                    }}
                  >
                    <div className="ro-done-header">
                      <span className="ro-name" title={d.displayName ? `id: ${d.id}` : undefined}>
                        {d.displayName || readableRole(d.id)} {d.count > 1 && <span className="ro-count">×{d.count}</span>}
                      </span>
                      <span className={`ro-label ro-label--${d.state}`}>
                        {d.state === "completed" ? "已完成" : d.state === "failed" ? "失败" : "已取消"}
                      </span>
                    </div>
                    <ModelChip badge={d.model} />
                    <UsageGrid usage={d.usage} />
                    <span className="ro-sub">{oneLine(d.summary, 60) || "—"}</span>

                    {/* 点击展开后的任务要求与完整输出结果 */}
                    {isExpanded && (
                      <div className="ro-done-expanded" onClick={(e) => e.stopPropagation()}>
                        {d.task && (
                          <div className="ro-detail-block">
                            <span className="ro-detail-title">任务要求:</span>
                            <div className="ro-detail-text">{d.task}</div>
                          </div>
                        )}
                        {d.detail && (
                          <div className="ro-detail-block">
                            <span className="ro-detail-title">执行输出 / 结果:</span>
                            <pre className="ro-detail-pre">{d.detail}</pre>
                          </div>
                        )}
                        <div className="ro-detail-footer">
                          {d.detail && (
                            <button
                              type="button"
                              className="ro-detail-btn"
                              onClick={() => {
                                void navigator.clipboard.writeText(d.detail ?? "");
                                setCopiedId(d.id);
                                setTimeout(() => setCopiedId((cur) => (cur === d.id ? null : cur)), 1500);
                              }}
                            >
                              {copiedId === d.id ? "已复制结果" : "复制结果"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="ro-detail-btn ro-detail-btn-primary"
                            onClick={() => openSubagentDrawer(d.id)}
                          >
                            打开临时抽屉
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {activeExternalAgents.length > 0 && (
        <>
          <SectionTitle count={activeExternalAgents.length}>外部子任务</SectionTitle>
          <ul className="ro-list">
            {activeExternalAgents.map((run) => (
              <li key={run.runId} className="ro-row">
                <span className="ro-status-col">
                  <Dot state={run.status === "failed" ? "err" : "running"} />
                </span>
                <div className="ro-row-main">
                  <span className="ro-name">
                    <IconBot size={12} /> {run.agentName}
                  </span>
                  <span className={`ro-label ro-label--${run.status === "blocked" ? "working" : "running"}`}>
                    {run.status === "blocked" ? "等待授权" : "运行中"}
                  </span>
                  {run.capabilities.resumeSupported && <span className="ro-label ro-label--ok">可续聊</span>}
                  <span className="ro-elapsed">{formatElapsed(Math.max(0, now - run.startedAt))}</span>
                  <span className="ro-sub" title={run.cwd}>
                    输出 {run.outputCursor} · 产物 {run.artifactRefs.length}{run.verification.status === "workspace_observed" ? " · 工作目录已观察" : ""}
                  </span>
                  {run.capabilities.cancelSupported && (
                    <button
                      type="button"
                      className="btn"
                      title="停止这个外部子任务"
                      onClick={() => {
                        void window.api?.externalAgent?.cancel?.(run.runId).finally(() => {
                          setActiveExternalAgents((current) => current.filter((item) => item.runId !== run.runId));
                        });
                      }}
                    >
                      停止
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {/* 后台任务（终端会话 + 运行中 bash 命令） */}
      {vm.backgroundTasks.length > 0 && (
        <>
          <SectionTitle count={vm.backgroundTasks.length}>后台任务</SectionTitle>
          <ul className="ro-list">
            {vm.backgroundTasks.map((t) => {
              const isRunning = t.state === "running";
              const s = useAppStore.getState();
              const ownerKey = currentTerminalOwnerKey(s);
              const current = s.terminalTabsByOwner[ownerKey];
              const hasMatchingTab = Boolean(t.terminalId && current?.tabs.some((tab) => tab.id === t.terminalId));
              const canNavigate = isRunning && hasMatchingTab;

              return (
                <li key={t.key} className="ro-row">
                  <span className="ro-status-col">
                    <Dot state={isRunning ? "running" : t.state === "completed" ? "ok" : "err"} />
                  </span>
                  {canNavigate ? (
                    <button
                      type="button"
                      className="ro-row-main ro-btn ro-btn--task"
                      title="点击切换到该终端"
                      onClick={() => {
                        const store = useAppStore.getState();
                        if (t.terminalId) {
                          store.setActiveTerminalTabId(t.terminalId);
                          store.showTerminal();
                        }
                      }}
                    >
                      <span className="ro-name ro-name--mono">{t.name}</span>
                      <span className="ro-label ro-label--running">running</span>
                      {t.elapsedMs !== undefined && <span className="ro-elapsed">{formatElapsed(t.elapsedMs)}</span>}
                    </button>
                  ) : (
                    <div className="ro-row-main ro-static" title={isRunning ? "后台运行中" : "终端已结束"}>
                      <span className="ro-name ro-name--mono">{t.name}</span>
                      {isRunning ? (
                        <>
                          <span className="ro-label ro-label--running">running</span>
                          {t.elapsedMs !== undefined && <span className="ro-elapsed">{formatElapsed(t.elapsedMs)}</span>}
                        </>
                      ) : (
                        <span className="ro-label ro-label--ok">
                          {t.exitCode !== undefined ? `exit ${t.exitCode}` : "已结束"}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {empty && <div className="ro-empty">没有子任务在跑</div>}
    </div>
  );
}
