import { useEffect, useRef, useState } from "react";
import { IconChevronLeft, IconPencil, IconPlus } from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";
import { useProjectConfigRailStore } from "@/store/projectConfigRailStore";
import { jobsForProject } from "@/lib/projectAutomation";
import { selectedProjectPolicyIds, type ProjectUnsavedGuard } from "@/lib/projectWorkspace";
import {
  RAIL_DEFAULT_WIDTH,
  RAIL_SECTION_LABELS,
  railResizeMove,
  railResizeStart,
  type ProjectConfigSection,
} from "@/lib/projectConfigRail";
import type { CronJobDto } from "@shared/agent-ipc";
import type { ProjectDetailsDto } from "@shared/project-domain";
import ProjectAutomationModal from "./ProjectAutomationModal";
import ProjectCapabilityDetail from "./ProjectCapabilityDetail";
import ProjectInstructionsDetail from "./ProjectInstructionsDetail";

interface Props {
  project: ProjectDetailsDto;
  onOpenSettings: () => void;
  /** Rail 内部动作（rail-back/rail-collapse）与全局导航共用 Unsaved Guard */
  onNavigate: (dest: { type: "rail-back" } | { type: "rail-collapse" }) => void;
  /** 以独立 key 注册 Rail 的 Dirty Guard（不覆盖 Pane 表单 Guard） */
  onRegisterUnsaved: (guard: ProjectUnsavedGuard | null) => void;
  onRefresh: () => Promise<void>;
  onToast: (text: string) => void;
  /** Connector/MCP 全局管理入口（跳转全局设置） */
  onManageConnectors?: () => void;
  onManageMcp?: () => void;
}

interface CapabilityItem {
  id: string;
  name: string;
  emoji?: string;
}

const MAX_CHIPS = 3;

function CapabilityChips({ items }: { items: CapabilityItem[] }): React.JSX.Element {
  const visible = items.slice(0, MAX_CHIPS);
  const extra = items.length - visible.length;
  return (
    <div className="project-config-avatars">
      {visible.map((item) => (
        <span key={item.id} className="project-config-avatar" title={item.name}>
          {item.emoji || item.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {extra > 0 && <span className="project-config-more">+{extra}</span>}
    </div>
  );
}

export default function ProjectConfigRail({
  project,
  onOpenSettings,
  onNavigate,
  onRegisterUnsaved,
  onRefresh,
  onToast,
  onManageConnectors,
  onManageMcp,
}: Props): React.JSX.Element | null {
  const experts = useAppStore((state) => state.experts);
  const skills = useAppStore((state) => state.skills);
  const connectors = useAppStore((state) => state.connectors);
  const mode = useProjectConfigRailStore((state) => state.mode);
  const section = useProjectConfigRailStore((state) => state.section);
  const intent = useProjectConfigRailStore((state) => state.intent);
  const width = useProjectConfigRailStore((state) => state.width);
  const dock = useProjectConfigRailStore((state) => state.dock);
  const resizing = useProjectConfigRailStore((state) => state.resizing);
  const openSection = useProjectConfigRailStore((state) => state.openSection);
  const handleEscape = useProjectConfigRailStore((state) => state.handleEscape);
  const setWidthDuringResize = useProjectConfigRailStore((state) => state.setWidthDuringResize);
  const commitWidth = useProjectConfigRailStore((state) => state.commitWidth);

  const railRef = useRef<HTMLElement>(null);
  const rafRef = useRef<number | null>(null);
  /** Detail 上报的 Dirty Guard（Instructions / Capability 共用，§6/§7） */
  const [detailGuard, setDetailGuard] = useState<ProjectUnsavedGuard | null>(null);
  const [autoJobs, setAutoJobs] = useState<CronJobDto[]>([]);
  const [autoModal, setAutoModal] = useState<{ startInForm: boolean } | null>(null);
  const autoModalRef = useRef(autoModal);
  autoModalRef.current = autoModal;
  const detailGuardRef = useRef(detailGuard);
  detailGuardRef.current = detailGuard;
  /** §24：返回 Summary 时 focus 回原卡片 */
  const lastSectionRef = useRef<ProjectConfigSection | null>(null);
  const prevModeRef = useRef(mode);
  useEffect(() => {
    if (mode === "detail" && section) lastSectionRef.current = section;
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (prev === "detail" && mode === "summary" && lastSectionRef.current) {
      const card = railRef.current?.querySelector<HTMLElement>(`[data-card="${lastSectionRef.current}"]`);
      card?.focus();
    }
  }, [mode, section]);

  /** §7：Rail 的 Guard 独立注册；clean 时注销，把注册权交还 Pane 表单 */
  useEffect(() => {
    onRegisterUnsaved(detailGuard);
    return () => onRegisterUnsaved(null);
  }, [detailGuard, onRegisterUnsaved]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const jobs = (await window.api?.cron?.list()) ?? [];
      if (!cancelled) setAutoJobs(jobsForProject(jobs, project.id));
    };
    void load();
    const off = window.api?.cron?.onEvent(() => {
      void load();
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [project.id]);

  /** Esc（§23）：Detail + dirty → Guard；Detail + clean → Summary；Overlay + Summary → 收起 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (autoModalRef.current) return;
      const state = useProjectConfigRailStore.getState();
      if (state.mode === "collapsed") return;
      if (state.mode === "detail") {
        if (detailGuardRef.current?.dirty) {
          onNavigate({ type: "rail-back" });
          return;
        }
        handleEscape();
        return;
      }
      if (state.dock !== "overlay") return;
      handleEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleEscape, onNavigate]);

  const selected = selectedProjectPolicyIds(project.policies);
  const expertItems: CapabilityItem[] = selected.experts.map((id) => {
    const expert = experts.find((item) => item.id === id);
    return expert ? { id, name: expert.name, emoji: expert.emoji } : { id, name: id, emoji: "🧙" };
  });
  const skillItems: CapabilityItem[] = selected.skills.map((id) => {
    const skill = skills.find((item) => item.id === id);
    return skill ? { id, name: skill.name, emoji: skill.icon || skill.name.slice(0, 1) } : { id, name: id };
  });
  const connectorItems: CapabilityItem[] = selected.connectors.map((id) => {
    const connector = connectors.find((item) => item.id === id);
    return connector ? { id, name: connector.name } : { id, name: id };
  });
  const mcpItems: CapabilityItem[] = project.policies.mcp.allow.map((id) => ({ id, name: id }));
  const instructionPreview = project.instructions?.trim() || project.description?.trim() || "";
  /** §18：Registry 中已消失的已配置项（Summary 轻量警示，不暴露策略细节） */
  const missingCounts = {
    experts: selected.experts.filter((id) => !experts.some((item) => item.id === id)).length,
    skills: selected.skills.filter((id) => !skills.some((item) => item.id === id)).length,
    connectors: selected.connectors.filter((id) => !connectors.some((item) => item.id === id)).length,
  };

  const renderSummaryCard = (
    target: ProjectConfigSection | "automation",
    label: string,
    content: React.JSX.Element,
    addAsEdit = false,
    missing = 0,
    onActivate?: (intent: "manage" | "add") => void,
  ): React.JSX.Element => (
    <section
      className="project-config-card"
      role="button"
      tabIndex={0}
      data-card={target}
      aria-label={`打开${label}配置`}
      onClick={() => (onActivate ? onActivate("manage") : openSection(target as ProjectConfigSection))}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (onActivate) onActivate("manage");
          else openSection(target as ProjectConfigSection);
        }
      }}
    >
      <div className="project-config-card-head">
        <span className="project-config-card-title">
          {label}
          {missing > 0 && (
            <span className="project-config-card-warn" title={`${missing} 项已不可用，可在配置中移除`}>
              ⚠{missing}
            </span>
          )}
        </span>
        <button
          type="button"
          className="project-config-card-add"
          title={addAsEdit ? "编辑指令" : `添加${label}`}
          aria-label={addAsEdit ? "编辑指令" : `添加${label}`}
          onClick={(event) => {
            event.stopPropagation();
            const intent = addAsEdit ? "manage" : "add";
            if (onActivate) onActivate(intent);
            else openSection(target as ProjectConfigSection, intent);
          }}
        >
          {addAsEdit ? <IconPencil size={14} strokeWidth={1.7} /> : <IconPlus size={15} strokeWidth={1.7} />}
        </button>
      </div>
      {content}
    </section>
  );

  const renderDetail = (): React.JSX.Element | null => {
    if (section === "instructions") {
      return (
        <ProjectInstructionsDetail
          project={project}
          onDirtyChange={setDetailGuard}
          onRefresh={onRefresh}
          onToast={onToast}
        />
      );
    }
    if (section === "experts" || section === "skills" || section === "connectors" || section === "mcp") {
      return (
        <ProjectCapabilityDetail
          project={project}
          section={section}
          addIntent={intent === "add"}
          onDirtyChange={setDetailGuard}
          onRefresh={onRefresh}
          onToast={onToast}
          onManageGlobal={
            section === "connectors" ? onManageConnectors : section === "mcp" ? onManageMcp : undefined
          }
        />
      );
    }
    return null;
  };

  return (
    <>
      {dock === "overlay" && (
        <div
          className="project-config-overlay-mask"
          aria-hidden="true"
          onClick={() => onNavigate({ type: "rail-collapse" })}
        />
      )}
      <aside
        ref={railRef}
        className={`project-config-rail ${dock === "overlay" ? "overlay" : ""} ${resizing ? "resizing" : ""}`}
        data-mode={mode}
        style={{ width }}
        aria-label="项目配置"
      >
        {dock === "docked" && (
          <div
            className="project-config-rail-resize"
            role="separator"
            aria-label="调整项目配置栏宽度"
            aria-orientation="vertical"
            title="拖拽调整宽度（双击恢复默认）"
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              useProjectConfigRailStore.setState(railResizeStart(useProjectConfigRailStore.getState()));
            }}
            onPointerMove={(event) => {
              const state = useProjectConfigRailStore.getState();
              if (!state.resizing || event.buttons !== 1) return;
              if (rafRef.current != null) return;
              rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null;
                const right = railRef.current?.getBoundingClientRect().right ?? window.innerWidth;
                useProjectConfigRailStore.setState(railResizeMove(state, event.clientX, right));
              });
            }}
            onPointerUp={() => {
              if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
              rafRef.current = null;
              commitWidth();
            }}
            onLostPointerCapture={() => {
              if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
              rafRef.current = null;
              commitWidth();
            }}
            onDoubleClick={() => {
              setWidthDuringResize(RAIL_DEFAULT_WIDTH);
              commitWidth();
            }}
          />
        )}

        <div className="project-config-rail-head">
          {mode === "detail" ? (
            <>
              <button
                type="button"
                className="project-config-back"
                title="返回概览"
                aria-label="返回概览"
                onClick={() => onNavigate({ type: "rail-back" })}
              >
                <IconChevronLeft size={16} strokeWidth={1.7} />
              </button>
              <h3>{RAIL_SECTION_LABELS[(section ?? "experts") as ProjectConfigSection]}</h3>
            </>
          ) : (
            <h3>项目配置</h3>
          )}
          <button
            type="button"
            className="project-rail-toggle"
            title="收起项目配置"
            aria-label="收起项目配置"
            onClick={() => onNavigate({ type: "rail-collapse" })}
          >
            <IconChevronLeft size={16} strokeWidth={1.7} />
          </button>
        </div>

        <div className="project-config-rail-body">
          {mode === "detail" ? (
            renderDetail()
          ) : (
            <>
              {renderSummaryCard(
                "instructions",
                "指令",
                instructionPreview
                  ? <p className="project-config-copy">{instructionPreview}</p>
                  : <p className="project-config-empty">还没有项目指令</p>,
                true,
              )}

              {renderSummaryCard(
                "experts",
                "专家",
                expertItems.length === 0 ? <p className="project-config-empty">尚未添加专家</p> : <CapabilityChips items={expertItems} />,
                false,
                missingCounts.experts,
              )}
              {renderSummaryCard(
                "skills",
                "技能",
                skillItems.length === 0 ? <p className="project-config-empty">尚未添加技能</p> : <CapabilityChips items={skillItems} />,
                false,
                missingCounts.skills,
              )}
              {renderSummaryCard(
                "connectors",
                "连接器",
                connectorItems.length === 0 ? <p className="project-config-empty">尚未添加连接器</p> : <CapabilityChips items={connectorItems} />,
                false,
                missingCounts.connectors,
              )}
              {renderSummaryCard(
                "mcp",
                "MCP",
                mcpItems.length === 0 ? <p className="project-config-empty">尚未配置 MCP</p> : <CapabilityChips items={mcpItems} />,
              )}
              {renderSummaryCard(
                "automation",
                "自动化",
                autoJobs.length === 0
                  ? <p className="project-config-empty">尚未添加自动化</p>
                  : <CapabilityChips items={autoJobs.map((job) => ({ id: job.id, name: job.name }))} />,
                false,
                0,
                (intent) => setAutoModal({ startInForm: intent === "add" }),
              )}
              <button type="button" className="project-config-settings" onClick={onOpenSettings}>更多设置</button>
            </>
          )}
        </div>
      </aside>
      {autoModal && (
        <ProjectAutomationModal
          projectId={project.id}
          startInForm={autoModal.startInForm}
          onClose={() => setAutoModal(null)}
        />
      )}
    </>
  );
}
