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
import { useAppStore } from "@/store/appStore";
import type { SubagentSummaryDto } from "@shared/agent-ipc";
import type { ExternalAgentRunDto } from "@shared/external-agent";
import {
  buildRuntimeOverview,
  formatElapsed,
  readableRole,
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

function Dot({ state }: { state: "running" | "ok" | "err" }): React.JSX.Element {
  return <span className={`ro-dot ro-dot--${state}`} aria-hidden />;
}

export default function RuntimeObservatory(): React.JSX.Element | null {
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const tasks = useAppStore((s) => s.tasks);
  const terminalSessions = useAppStore((s) => s.terminalSessions);
  const openSubagentDrawer = useAppStore((s) => s.openSubagentDrawer);

  const currentTask = useMemo(() => tasks.find((t) => t.id === activeTaskId) ?? null, [tasks, activeTaskId]);
  const messages = currentTask?.messages ?? [];

  // 运行中子代理（主进程按当前 session scope 过滤；事件驱动刷新）
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
        const list = await window.api?.subagent?.active?.();
        // 竞态防御：旧任务的事件/响应不得污染新任务（列表本身按 scope 过滤，
        // 这里再加一道 taskId 校验）
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
      }),
    [activeTaskId, currentTask?.spaceId, messages, activeSubagents, terminalSessions, now],
  );
  const hasRunning =
    vm.runningSubagents.length > 0 || activeExternalAgents.length > 0 || vm.backgroundTasks.some((t) => t.state === "running");
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  const subagentCount = vm.runningSubagents.length + vm.doneSubagents.length;
  const empty =
    vm.runningSubagents.length === 0 && vm.doneSubagents.length === 0 && activeExternalAgents.length === 0 && vm.backgroundTasks.length === 0;

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
          {vm.mainAgent.action && <div className="ro-sub">{vm.mainAgent.action}</div>}
        </div>
      </div>

      {/* 子代理（运行中 + 完成态，task 生命周期内） */}
      {subagentCount > 0 && (
        <>
          <SectionTitle count={subagentCount}>子代理</SectionTitle>
          <ul className="ro-list">
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
                  <span className="ro-name">
                    <IconUsers size={12} /> {s.role}
                  </span>
                  {s.elapsedMs >= 0 && <span className="ro-elapsed">{formatElapsed(s.elapsedMs)}</span>}
                  <span className="ro-sub">{s.work}</span>
                </button>
              </li>
            ))}
            {vm.doneSubagents.map((d) => (
              <li key={`done:${d.id}`} className="ro-row">
                <span className="ro-status-col">
                  <Dot state={d.state === "completed" ? "ok" : "err"} />
                </span>
                <div className="ro-row-main">
                  <span className="ro-name">
                    {readableRole(d.id)} {d.count > 1 && <span className="ro-count">×{d.count}</span>}
                  </span>
                  <span className={`ro-label ro-label--${d.state}`}>
                    {d.state === "completed" ? "已完成" : d.state === "failed" ? "失败" : "已取消"}
                  </span>
                  <span className="ro-sub">{oneLine(d.summary, 56) || "—"}</span>
                </div>
              </li>
            ))}
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
            {vm.backgroundTasks.map((t) => (
              <li key={t.key} className="ro-row">
                <span className="ro-status-col">
                  <Dot state={t.state === "running" ? "running" : t.state === "completed" ? "ok" : "err"} />
                </span>
                <div className="ro-row-main">
                  <span className="ro-name ro-name--mono">{t.name}</span>
                  {t.state === "running" ? (
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
              </li>
            ))}
          </ul>
        </>
      )}

      {empty && <div className="ro-empty">没有子任务在跑</div>}
    </div>
  );
}
