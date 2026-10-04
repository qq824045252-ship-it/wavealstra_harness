import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlert,
  IconBroom,
  IconCheck,
  IconCode,
  IconRefresh,
} from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";
import {
  DEFAULT_PYTHON_REQUEST,
  PYTHON_BASE_ENVIRONMENT_LABEL,
  pythonFailureStageLabel,
  type PythonEnvironmentInfo,
  type PythonProjectInterpreterView,
  type PythonRuntimePhase,
  type PythonRuntimeProgressEvent,
  type PythonRuntimeStatus,
} from "@shared/python-runtime";
import "./PythonRuntimeTab.css";

type RuntimeAction = "prepare" | "override" | "reset-project" | "cleanup" | "diagnostics" | "refresh" | null;

const PREPARING_PHASES = new Set<PythonRuntimePhase>([
  "checking",
  "downloading",
  "installing",
  "verifying",
]);

function environmentVersion(environment: PythonEnvironmentInfo | undefined): string {
  if (!environment) return `Python ${DEFAULT_PYTHON_REQUEST}`;
  return `Python ${environment.pythonVersion || environment.pythonRequest || DEFAULT_PYTHON_REQUEST}`;
}

function RuntimeBadge({
  tone,
  children,
}: {
  tone: "good" | "busy" | "warn" | "bad";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className={`python-runtime-badge ${tone}`}>
      {tone === "good" ? <IconCheck size={13} /> : tone === "bad" ? <IconAlert size={13} /> : null}
      {children}
    </span>
  );
}

function projectSourceLabel(project: PythonProjectInterpreterView | null): string {
  if (!project) return "无当前项目";
  if (project.source === "override") return "手动覆盖";
  if (project.source === "auto") return "自动识别";
  return "受管环境";
}

export default function PythonRuntimeTab(): React.JSX.Element {
  const spaces = useAppStore((state) => state.spaces);
  const tasks = useAppStore((state) => state.tasks);
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const activeTaskId = useAppStore((state) => state.activeTaskId);

  const currentProject = useMemo(() => {
    if (activeWorkspaceId) {
      const space = spaces.find((item) => item.id === activeWorkspaceId) ?? null;
      return {
        name: space?.name ?? "当前工作空间",
        dir: space?.path?.trim() || null,
        unavailable: Boolean(space?.pathMissing),
      };
    }

    const task = activeTaskId ? tasks.find((item) => item.id === activeTaskId) ?? null : null;
    const space = task?.spaceId ? spaces.find((item) => item.id === task.spaceId) ?? null : null;
    return {
      name: space?.name ?? task?.title ?? "当前项目",
      dir: space?.path?.trim() || task?.cwd?.trim() || null,
      unavailable: Boolean(space?.pathMissing),
    };
  }, [activeTaskId, activeWorkspaceId, spaces, tasks]);

  const [status, setStatus] = useState<PythonRuntimeStatus | null>(null);
  const [progress, setProgress] = useState<PythonRuntimeProgressEvent | null>(null);
  const [project, setProject] = useState<PythonProjectInterpreterView | null>(null);
  const [action, setAction] = useState<RuntimeAction>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const refreshQueuedRef = useRef<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const projectDir = currentProject.unavailable ? null : currentProject.dir;
    const [nextStatus, nextProject] = await Promise.all([
      window.api?.pythonRuntime?.status?.(),
      projectDir ? window.api?.pythonRuntime?.inspectProject?.(projectDir) : Promise.resolve(null),
    ]);
    if (nextStatus) setStatus(nextStatus);
    setProject(nextProject ?? null);
  }, [currentProject.dir, currentProject.unavailable]);

  const queueReload = useCallback((): void => {
    if (refreshQueuedRef.current != null) return;
    refreshQueuedRef.current = window.setTimeout(() => {
      refreshQueuedRef.current = null;
      void load();
    }, 180);
  }, [load]);

  useEffect(() => {
    void load();
    const off = window.api?.pythonRuntime?.onProgress?.((event) => {
      setProgress(event);
      setStatus((current) => current
        ? { ...current, phase: event.phase, detail: event.detail }
        : current);
      if (event.phase === "ready" || event.phase === "failed") queueReload();
    });
    return () => {
      off?.();
      if (refreshQueuedRef.current != null) {
        window.clearTimeout(refreshQueuedRef.current);
        refreshQueuedRef.current = null;
      }
    };
  }, [load, queueReload]);

  const environments = status?.environments ?? [];
  const readyEnvironments = useMemo(() => environments.filter((item) => item.ready), [environments]);
  const baseEnvironment = useMemo(
    () => environments.find((item) => item.label === PYTHON_BASE_ENVIRONMENT_LABEL && item.ready),
    [environments],
  );
  const phase = status?.phase ?? "idle";
  const preparing = PREPARING_PHASES.has(phase);
  const runtimeReady = Boolean(baseEnvironment);
  const lastFailed = phase === "failed";

  const health = useMemo((): { tone: "good" | "busy" | "warn" | "bad"; title: string; detail: string } => {
    if (preparing) {
      return {
        tone: "busy",
        title: "正在准备 Python",
        detail: progress?.detail || status?.detail || "正在准备受管运行环境",
      };
    }
    if (runtimeReady && lastFailed) {
      return {
        tone: "warn",
        title: "Python 可用",
        detail: `基础环境正常；上一次额外环境准备失败：${status?.detail || "请查看诊断信息"}`,
      };
    }
    if (runtimeReady) {
      return {
        tone: "good",
        title: "Python 可用",
        detail: "MyBuddy 会按任务依赖自动复用或准备隔离环境，不修改系统 Python。",
      };
    }
    if (lastFailed) {
      return {
        tone: "bad",
        title: "Python 需要修复",
        detail: status?.detail || "受管 Python 环境准备失败",
      };
    }
    return {
      tone: "warn",
      title: "Python 尚未准备",
      detail: "首次需要 Python 时会自动安装；也可以现在提前准备基础环境。",
    };
  }, [lastFailed, preparing, progress?.detail, runtimeReady, status?.detail]);

  const withAction = async (nextAction: Exclude<RuntimeAction, null>, work: () => Promise<void>): Promise<void> => {
    setAction(nextAction);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setAction(null);
    }
  };

  const prepareBase = async (): Promise<void> => {
    await withAction("prepare", async () => {
      const result = await window.api?.pythonRuntime?.prepare?.({
        python: DEFAULT_PYTHON_REQUEST,
        dependencies: [],
        label: PYTHON_BASE_ENVIRONMENT_LABEL,
      });
      if (!result) throw new Error("Python 运行时服务不可用");
      if (!result.ok) {
        throw new Error(
          `${pythonFailureStageLabel(result.failureStage ?? null)}：${result.detail ?? result.error ?? "未知原因"}`,
        );
      }
      setNotice({
        text: result.created
          ? `基础环境已准备完成 · Python ${result.pythonVersion ?? DEFAULT_PYTHON_REQUEST}`
          : `基础环境正常 · Python ${result.pythonVersion ?? DEFAULT_PYTHON_REQUEST}`,
      });
      await load();
      setProgress(null);
    });
  };

  const refresh = async (): Promise<void> => {
    await withAction("refresh", async () => {
      await load();
      setNotice({ text: "运行时状态已刷新" });
    });
  };

  const cleanup = async (): Promise<void> => {
    await withAction("cleanup", async () => {
      const [staging, cache] = await Promise.all([
        window.api?.pythonRuntime?.cleanStaging?.(),
        window.api?.pythonRuntime?.reclaimDisk?.(),
      ]);
      setNotice({
        text: [staging?.detail, cache?.detail].filter(Boolean).join("；") || "没有需要清理的运行时缓存",
      });
      await load();
    });
  };

  const exportDiagnostics = async (): Promise<void> => {
    await withAction("diagnostics", async () => {
      const result = await window.api?.pythonRuntime?.exportDiagnostics?.();
      if (!result || result.cancelled) return;
      setNotice({ text: result.detail, error: !result.ok });
    });
  };

  const overrideProjectInterpreter = async (): Promise<void> => {
    const projectDir = currentProject.dir;
    if (!projectDir || currentProject.unavailable) return;
    await withAction("override", async () => {
      const picked = await window.api?.pythonRuntime?.pickInterpreter?.(projectDir);
      if (!picked) return;
      const result = await window.api?.pythonRuntime?.bindProject?.({
        projectDir,
        pythonPath: picked,
      });
      if (!result) throw new Error("Python 运行时服务不可用");
      if (!result.ok) throw new Error(result.error);
      setNotice({ text: `已覆盖当前项目解释器 · Python ${result.binding.pythonVersion ?? ""}`.trim() });
      await load();
    });
  };

  const resetProjectInterpreter = async (): Promise<void> => {
    if (!project || project.source !== "override") return;
    await withAction("reset-project", async () => {
      const targetDir = project.resolvedProjectDir || currentProject.dir;
      if (!targetDir) return;
      const result = await window.api?.pythonRuntime?.unbindProject?.(targetDir);
      if (!result?.ok) throw new Error(result?.detail ?? "恢复自动识别失败");
      setNotice({ text: "已取消手动覆盖，当前项目恢复自动识别" });
      await load();
    });
  };

  const busy = action !== null;
  const fraction = progress?.fraction ?? null;
  const activeEnvironment = progress?.environmentId
    ? environments.find((item) => item.id === progress.environmentId)
    : undefined;
  const projectVersion = project?.pythonVersion ? `Python ${project.pythonVersion}` : "Python";

  return (
    <div className="python-runtime-tab">
      <section className={`python-runtime-hero ${health.tone}`}>
        <div className="python-runtime-hero-main">
          <div className="python-runtime-mark"><IconCode size={19} /></div>
          <div className="python-runtime-copy">
            <div className="python-runtime-title-row">
              <strong>{health.title}</strong>
              <RuntimeBadge tone={health.tone}>
                {preparing ? "准备中" : runtimeReady ? environmentVersion(baseEnvironment) : "受管运行时"}
              </RuntimeBadge>
            </div>
            <div className="python-runtime-detail">{health.detail}</div>
            {lastFailed && status?.failureStage && (
              <div className="python-runtime-error">
                失败阶段：{pythonFailureStageLabel(status.failureStage)}{status.error ? ` · ${status.error}` : ""}
              </div>
            )}
          </div>
          <div className="python-runtime-actions">
            {!runtimeReady && (
              <button className="btn primary" disabled={busy || preparing} onClick={() => void prepareBase()}>
                {action === "prepare" || preparing ? "正在准备…" : "准备 Python"}
              </button>
            )}
            <button className="btn" disabled={busy} onClick={() => void refresh()} title="刷新运行时状态">
              <IconRefresh size={13} />
              刷新
            </button>
          </div>
        </div>

        {preparing && (
          <div className="python-runtime-progress">
            <div className="python-runtime-progress-track">
              <div
                className={`python-runtime-progress-fill ${fraction == null ? "indeterminate" : ""}`}
                style={fraction == null ? undefined : { width: `${Math.round(fraction * 100)}%` }}
              />
            </div>
            <div className="python-runtime-progress-label">
              {activeEnvironment?.label || progress?.detail || "正在准备运行环境"}
            </div>
          </div>
        )}
      </section>

      {notice && (
        <div className={`python-runtime-notice ${notice.error ? "error" : ""}`}>
          {notice.error ? <IconAlert size={13} /> : <IconCheck size={13} />}
          <span>{notice.text}</span>
        </div>
      )}

      <section className="python-runtime-summary">
        <div className="python-runtime-summary-item">
          <span>基础环境</span>
          <strong>{runtimeReady ? environmentVersion(baseEnvironment) : "未准备"}</strong>
        </div>
        <div className="python-runtime-summary-item">
          <span>隔离环境</span>
          <strong>{readyEnvironments.length} 个</strong>
        </div>
        <div className="python-runtime-summary-item">
          <span>当前项目 Python</span>
          <strong>{projectSourceLabel(project)}</strong>
        </div>
      </section>

      <div className="python-runtime-explain">
        <strong>默认不用管理环境。</strong>
        临时代码、Skill 和 MyBuddy 内置能力始终使用受管隔离环境；只有明确执行当前项目里的 Python 脚本时，才会优先使用项目自己的环境。
      </div>

      <details className="python-runtime-advanced">
        <summary>高级设置</summary>
        <div className="python-runtime-advanced-body">
          <section className="python-runtime-section">
            <div className="python-runtime-section-head">
              <div>
                <div className="python-runtime-section-title">当前项目 Python</div>
                <div className="python-runtime-section-desc">
                  MyBuddy 自动检查当前空间/任务目录里的 .venv、venv、env。uv、Poetry、PDM 使用项目内虚拟环境时无需额外配置。
                </div>
              </div>
            </div>

            {!currentProject.dir ? (
              <div className="python-runtime-project-empty">当前没有可识别的项目文件夹。进入一个空间或绑定本地文件夹后会自动识别。</div>
            ) : currentProject.unavailable ? (
              <div className="python-runtime-project-empty error">{currentProject.name} 的本地文件夹当前不可用。</div>
            ) : (
              <div className="python-runtime-project-card">
                <div className="python-runtime-project-main">
                  <div className="python-runtime-project-name-row">
                    <strong>{currentProject.name}</strong>
                    <span className={`python-runtime-project-source ${project?.source ?? "managed"}`}>
                      {projectSourceLabel(project)}
                    </span>
                  </div>
                  <code className="python-runtime-project-dir" title={currentProject.dir}>{currentProject.dir}</code>
                  {project?.pythonPath ? (
                    <div className="python-runtime-project-python">
                      <span>{projectVersion}</span>
                      <code title={project.pythonPath}>{project.pythonPath}</code>
                    </div>
                  ) : (
                    <div className="python-runtime-project-managed">
                      未发现项目虚拟环境；项目脚本会使用 MyBuddy 受管 Python。
                    </div>
                  )}
                  {project?.detail && <div className="python-runtime-project-detail">{project.detail}</div>}
                </div>
                <div className="python-runtime-project-actions">
                  <button className="btn" disabled={busy} onClick={() => void overrideProjectInterpreter()}>
                    {action === "override" ? "校验中…" : project?.source === "override" ? "更换解释器…" : "选择解释器…"}
                  </button>
                  {project?.source === "override" && (
                    <button className="btn" disabled={busy} onClick={() => void resetProjectInterpreter()}>
                      {action === "reset-project" ? "恢复中…" : "恢复自动"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="python-runtime-section">
            <div className="python-runtime-section-head">
              <div>
                <div className="python-runtime-section-title">运行时维护</div>
                <div className="python-runtime-section-desc">
                  uv、解释器和隔离环境由 MyBuddy 管理。这里主要用于排障，不需要日常操作。
                </div>
              </div>
              <div className="python-runtime-section-actions">
                <button className="btn" disabled={busy || preparing} onClick={() => void cleanup()}>
                  <IconBroom size={13} />
                  {action === "cleanup" ? "清理中…" : "清理缓存"}
                </button>
                <button className="btn" disabled={busy} onClick={() => void exportDiagnostics()}>
                  {action === "diagnostics" ? "导出中…" : "导出诊断"}
                </button>
              </div>
            </div>

            <div className="python-runtime-runtime-info">
              <div>
                <span>安装器</span>
                <strong>{status?.uv.available ? `uv ${status.uv.version ?? ""}`.trim() : "按需安装"}</strong>
              </div>
              <div>
                <span>运行时目录</span>
                <code title={status?.roots.runtime}>{status?.roots.runtime ?? "—"}</code>
              </div>
              <div>
                <span>受管解释器</span>
                <strong>{status?.interpreters.length ?? 0} 个</strong>
              </div>
            </div>

            {readyEnvironments.length > 0 && (
              <div className="python-runtime-env-list">
                {readyEnvironments.map((environment) => (
                  <div className="python-runtime-env" key={environment.id}>
                    <span className="python-runtime-env-name">{environment.label || environment.id}</span>
                    <span>{environmentVersion(environment)}</span>
                    <span>{environment.dependencies.length === 0 ? "基础" : `${environment.dependencies.length} 个依赖`}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </details>
    </div>
  );
}
