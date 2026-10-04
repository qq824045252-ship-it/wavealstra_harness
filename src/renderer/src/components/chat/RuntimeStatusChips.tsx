/**
 * RuntimeStatusChips — 聊天头部轻量 runtime 状态提示（事件驱动，不喧宾夺主）。
 *
 * 只展示当前任务 Tag 声明的 required runtime 的非 idle 状态：启动中/等待后端/已就绪/失败。
 * 其它任务预热起来的软件不出现在本任务顶栏。
 * - 打开时拉取一次快照 + 订阅 push 事件（与 RuntimeContextInspector 同源）；
 * - 全 idle / 空列表 / 当前 Tag 未声明时渲染 null（不占位）；
 * - ready 只保留名称 + 绿点（颜色即状态），忙碌/失败才写短文案；
 * - 单行不换行，点击跳到插件页对应 MCP 卡片（启动/停止/打开）。
 */
import { useEffect, useState } from "react";
import type { RuntimeRequirementStateDto } from "@shared/agent-ipc";
import { isRetiredManagedProvider } from "@shared/professional-tools";
import { useAppStore } from "@/store/appStore";

const PROVIDER_LABELS: Record<string, string> = {
  penpot: "Penpot",
  "drawio-ai": "Draw.io",
};

function phaseLabel(state: RuntimeRequirementStateDto): string {
  switch (state.phase) {
    case "ready":
      return "已就绪";
    case "starting":
      return "启动中";
    case "waiting-backend":
      return "等待中";
    case "failed":
      return "失败";
    default:
      return "未启动";
  }
}

function chipTitle(state: RuntimeRequirementStateDto, name: string): string {
  const status = state.detail?.trim() || phaseLabel(state);
  return `${name} ${status} · 点击到插件 MCP`;
}

interface Props {
  /** 当前任务绑定的 Tag / preset id；缺省不展示任何芯片 */
  modePresetId?: string | null;
}

export default function RuntimeStatusChips({ modePresetId }: Props): React.JSX.Element | null {
  const openHubMcp = useAppStore((s) => s.openHubMcp);
  const [states, setStates] = useState<RuntimeRequirementStateDto[]>([]);

  useEffect(() => {
    let disposed = false;
    const apply = (next: RuntimeRequirementStateDto[]): void => {
      if (!disposed) setStates(next);
    };
    void window.api?.agent
      ?.getRuntimeRequirementStates?.()
      .then((list) => apply(list ?? []))
      .catch(() => undefined);
    const unsub = window.api?.agent?.onRuntimeRequirementState?.((state) => {
      setStates((prev) => {
        const existing = prev.find((s) => s.providerId === state.providerId);
        const next = prev.filter((s) => s.providerId !== state.providerId);
        next.push({ ...state, requiredBy: state.requiredBy ?? existing?.requiredBy });
        return next;
      });
    });
    return () => {
      disposed = true;
      unsub?.();
    };
  }, []);

  const visible = states.filter((s) => {
    if (s.phase === "idle") return false;
    if (!modePresetId) return false;
    if (isRetiredManagedProvider(s.providerId)) return false;
    return Boolean(s.requiredBy?.includes(modePresetId));
  });
  if (visible.length === 0) return null;

  return (
    <span className="runtime-status-chips">
      {visible.map((state) => {
        const name = PROVIDER_LABELS[state.providerId] ?? state.providerId;
        const showPhase = state.phase !== "ready";
        return (
          <button
            key={state.providerId}
            type="button"
            className={`runtime-status-chip phase-${state.phase}`}
            title={chipTitle(state, name)}
            aria-label={chipTitle(state, name)}
            onClick={() => openHubMcp(state.providerId)}
          >
            <span className="runtime-status-chip-dot" aria-hidden="true" />
            <span className="runtime-status-chip-name">{name}</span>
            {showPhase && <span className="runtime-status-chip-phase">{phaseLabel(state)}</span>}
          </button>
        );
      })}
    </span>
  );
}
