import { useEffect, useState } from "react";
import type { RuntimeRequirementStateDto } from "@shared/agent-ipc";
import type { ProfessionalToolProviderId, ProfessionalToolStatusDto } from "@shared/professional-tools";
import { isManagedToolProvider, isRetiredManagedProvider } from "@shared/professional-tools";
import { RUNTIME_REQUIREMENT_DEFAULTS } from "@shared/runtime-requirement";

const PROVIDER_LABELS: Record<string, string> = {
  penpot: "Penpot",
  "drawio-ai": "Draw.io",
};

type RuntimeAction = "start" | "stop" | "restart" | "open";

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

function isFn(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function asToolId(providerId: string): ProfessionalToolProviderId {
  return providerId as ProfessionalToolProviderId;
}

function phaseFromToolStatus(status: ProfessionalToolStatusDto): RuntimeRequirementStateDto["phase"] {
  if (status.ready) return "ready";
  if (status.state === "starting") return "starting";
  if (status.state === "error") return "failed";
  return "idle";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Penpot / Draw.io 本机进程启停。只出现在插件页已装的受管 MCP 卡片上，
 * 替代账户菜单「扩展软件」总入口。
 */
export function ManagedMcpRuntimeBar({ serverName }: { serverName: string }): React.JSX.Element | null {
  const managed = isManagedToolProvider(serverName) && !isRetiredManagedProvider(serverName);
  const [state, setState] = useState<RuntimeRequirementStateDto | null>(null);
  const [pending, setPending] = useState<RuntimeAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!managed) return undefined;
    let disposed = false;
    const applyList = (list: RuntimeRequirementStateDto[]): void => {
      if (disposed) return;
      setState(list.find((item) => item.providerId === serverName) ?? null);
    };
    void window.api?.agent
      ?.getRuntimeRequirementStates?.()
      .then((list) => applyList(list ?? []))
      .catch(() => undefined);
    const unsub = window.api?.agent?.onRuntimeRequirementState?.((next) => {
      if (next.providerId !== serverName) return;
      setState((prev) => ({ ...next, requiredBy: next.requiredBy ?? prev?.requiredBy }));
    });
    return () => {
      disposed = true;
      unsub?.();
    };
  }, [managed, serverName]);

  if (!managed) return null;

  const defaults = RUNTIME_REQUIREMENT_DEFAULTS[serverName];
  const launch = state?.launch && state.launch !== "none" ? state.launch : defaults.launchPolicy;
  const phase = state?.phase ?? "idle";
  const busy = Boolean(pending) || phase === "starting" || phase === "waiting-backend";
  const canStart = launch !== "none" && (phase === "idle" || phase === "failed");
  const canStop = phase !== "idle";
  const canRestart = launch !== "none" && phase === "ready";
  const canOpen = phase === "ready";
  const canProbe = launch === "none" && (phase === "idle" || phase === "failed");
  const name = PROVIDER_LABELS[serverName] ?? serverName;

  const run = async (action: RuntimeAction): Promise<void> => {
    if (pending) return;
    setPending(action);
    setNotice(null);
    try {
      if (action === "start") {
        if (!isFn(window.api?.agent?.startRuntimeRequirement)) throw new Error("启动接口未就绪");
        await window.api.agent.startRuntimeRequirement(serverName);
        setNotice(`已请求启动 ${name}`);
      } else if (action === "stop") {
        if (!isFn(window.api?.agent?.stopRuntimeRequirement)) throw new Error("停止接口未就绪");
        await window.api.agent.stopRuntimeRequirement(serverName);
        setNotice(`已停止 ${name}`);
      } else if (action === "restart") {
        if (!isFn(window.api?.agent?.restartRuntimeRequirement)) throw new Error("重启接口未就绪");
        await window.api.agent.restartRuntimeRequirement(serverName);
        setNotice(`已发出重启 ${name}`);
      } else {
        if (!isFn(window.api?.professionalTools?.open)) throw new Error("打开接口未就绪");
        const result = await window.api.professionalTools.open(asToolId(serverName));
        if (result && result.ok === false) throw new Error(result.error || "打开失败");
        if (result?.status) {
          setState((prev) => ({
            providerId: serverName,
            phase: phaseFromToolStatus(result.status),
            launch: prev?.launch ?? launch,
            detail: result.status.detail ?? prev?.detail ?? null,
            lastReadyAt: result.status.ready ? Date.now() : prev?.lastReadyAt ?? null,
            lastAttemptAt: Date.now(),
            requiredBy: prev?.requiredBy ?? [],
          }));
        }
        setNotice(`已打开 ${name}`);
      }
    } catch (cause) {
      setNotice(`${name} ${action === "open" ? "打开" : action === "stop" ? "停止" : action === "restart" ? "重启" : "启动"}失败：${errorMessage(cause)}`);
    } finally {
      setPending(null);
    }
  };

  const probe = async (): Promise<void> => {
    if (pending) return;
    setPending("start");
    setNotice(null);
    try {
      if (isFn(window.api?.agent?.startRuntimeRequirement)) {
        await window.api.agent.startRuntimeRequirement(serverName);
      }
      const status = isFn(window.api?.professionalTools?.status)
        ? await window.api.professionalTools.status(asToolId(serverName))
        : undefined;
      if (status) {
        setState((prev) => ({
          providerId: serverName,
          phase: phaseFromToolStatus(status),
          launch: prev?.launch ?? launch,
          detail: status.detail ?? prev?.detail ?? null,
          lastReadyAt: status.ready ? Date.now() : prev?.lastReadyAt ?? null,
          lastAttemptAt: Date.now(),
          requiredBy: prev?.requiredBy ?? [],
        }));
        setNotice(`${name} 探测：${status.ready ? "已就绪" : "未就绪"}${status.detail ? ` · ${status.detail}` : ""}`);
      } else {
        setNotice(`已探测 ${name}`);
      }
    } catch (cause) {
      setNotice(`${name} 探测失败：${errorMessage(cause)}`);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="hub-mcp-runtime">
      <div className="hub-mcp-runtime-row">
        <span className={`hub-mcp-runtime-pill phase-${phase}`}>
          <span className="hub-mcp-runtime-dot" />
          {pending ? "处理中" : phaseLabel(phase)}
        </span>
        <span className="hub-mcp-runtime-label">本机服务</span>
      </div>
      {state?.detail && <div className="hub-mcp-runtime-detail" title={state.detail}>{state.detail}</div>}
      <div className="hub-mcp-runtime-actions">
        {canStart && (
          <button type="button" className={`btn${phase === "failed" ? " primary" : ""}`} disabled={Boolean(pending)} onClick={() => void run("start")}>
            {phase === "failed" ? "重试" : "启动"}
          </button>
        )}
        {canRestart && (
          <button type="button" className="btn" disabled={Boolean(pending) || busy} onClick={() => void run("restart")}>
            重启
          </button>
        )}
        {canOpen && (
          <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => void run("open")}>
            打开
          </button>
        )}
        {canStop && (
          <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => void run("stop")}>
            {pending === "stop" ? "停止中" : "停止"}
          </button>
        )}
        {canProbe && (
          <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => void probe()}>
            探测
          </button>
        )}
      </div>
      {notice && <div className="hub-mcp-runtime-notice">{notice}</div>}
    </div>
  );
}
