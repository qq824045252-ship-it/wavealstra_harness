import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { Page, Skill } from "@/types";
import type { PluginStoragePathsDto } from "@shared/plugin-storage";
import { McpConfigEditor, MCP_EXPOSURE_LABELS } from "@/components/hub/McpConfigEditor";
import { McpToolsDialog } from "@/components/hub/McpToolsDialog";
import type {
  LocalConnectorDto,
  McpDiscoveryDto,
  McpServerDto,
  McpStatusSnapshotDto,
  McpUiPromptDto,
} from "../../../../shared/agent-ipc";
import { HubGrid, HubCard, HubStatusBadge, HubActionsMenu, HubEmpty, HubHeader, HubToolbar, HubSearch, HubFilterPills, HubImportBar, HubDropOverlay, HubToast, HubAuthoringModal, HubSkillDetailModal, ManagedMcpRuntimeBar } from "@/components/hub";

type HubTab = "experts" | "skills" | "mcp" | "connectors";

const STATUS_LABEL: Record<string, string> = {
  connected: "已连接",
  connecting: "连接中",
  cached: "已缓存",
  failed: "失败",
  "needs-auth": "需要授权",
  "not-connected": "未连接",
  disabled: "已停用",
};

const HUB_TABS: HubTab[] = ["experts", "skills", "mcp", "connectors"];

const TAB_LABEL: Record<HubTab, string> = {
  experts: "专家",
  skills: "技能",
  mcp: "MCP",
  connectors: "连接器",
};

type HubToastKind = "ok" | "err" | "info";
type HubToastState = { kind: HubToastKind; text: string };

type HubCardExpansionCommand = { sequence: number; expanded: boolean };

function useHubBulkExpansion(): {
  command: HubCardExpansionCommand;
  toggle: () => void;
} {
  const [command, setCommand] = useState<HubCardExpansionCommand>({ sequence: 0, expanded: false });
  return {
    command,
    toggle: () => setCommand((prev) => ({ sequence: prev.sequence + 1, expanded: !prev.expanded })),
  };
}

function HubBulkExpandButton({ command, onToggle }: { command: HubCardExpansionCommand; onToggle: () => void }): React.JSX.Element {
  return (
    <button type="button" className="btn hub-bulk-expand" onClick={onToggle}>
      {command.expanded ? "全部收起" : "全部展开"}
    </button>
  );
}

function ExpertsTab({ query }: { query: string }): React.JSX.Element {
  const experts = useAppStore((s) => s.experts);
  const marketExperts = useAppStore((s) => s.marketExperts);
  const installExpert = useAppStore((s) => s.installExpert);
  const installExpertByPath = useAppStore((s) => s.installExpertByPath);
  const importExpertZip = useAppStore((s) => s.importExpertZip);
  const uninstallExpert = useAppStore((s) => s.uninstallExpert);
  const deleteMarketExpert = useAppStore((s) => s.deleteMarketExpert);
  const summonExpert = useAppStore((s) => s.summonExpert);
  const refreshExperts = useAppStore((s) => s.refreshExperts);
  const installedSkills = useAppStore((s) => s.skills);
  const refreshSkills = useAppStore((s) => s.refreshSkills);
  const [authoringOpen, setAuthoringOpen] = useState(false);
  const [editingExpertId, setEditingExpertId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<HubToastState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** 专家中心筛选：全部 | 已安装 | 具体分类 */
  const [marketCat, setMarketCat] = useState<string>("全部");
  const bulkExpansion = useHubBulkExpansion();

  useEffect(() => {
    void refreshExperts();
  }, [refreshExperts]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const q = query.trim().toLowerCase();

  const installedById = useCallback(
    (id: string) => experts.find((e) => e.id === id || e.name === id),
    [experts],
  );
  const isExpertInstalled = useCallback(
    (id: string, name?: string) =>
      experts.some((e) => e.id === id || e.name === id || (name != null && (e.id === name || e.name === name))),
    [experts],
  );

  /** 市场列表（搜索后）：已安装置顶 */
  const filteredMarket = useMemo(() => {
    const list = marketExperts.filter(
      (e) => !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
    );
    return [...list].sort((a, b) => {
      const ai = isExpertInstalled(a.id, a.name) ? 1 : 0;
      const bi = isExpertInstalled(b.id, b.name) ? 1 : 0;
      return bi - ai;
    });
  }, [marketExperts, q, isExpertInstalled]);

  const installedMarketCount = useMemo(
    () => marketExperts.filter((e) => isExpertInstalled(e.id, e.name)).length,
    [marketExperts, isExpertInstalled],
  );

  /** 已安装但不在市场列表中的专家（ZIP/文件夹导入等） */
  const customInstalled = useMemo(() => {
    return experts.filter((e) => {
      const inMarket = marketExperts.some((m) => m.id === e.id || m.name === e.name);
      if (inMarket) return false;
      if (!q) return true;
      return e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
    });
  }, [experts, marketExperts, q]);

  const totalInstalledExperts = installedMarketCount + customInstalled.length;

  const expertErrText = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("agents/*.md") || msg.includes("prompt.md")) return `${msg} · 请确认目录包含 agents/*.md 或 prompt.md`;
    if (msg.includes("路径不存在")) return `${msg} · 请检查文件是否被移动或删除`;
    if (msg.includes("zip")) return msg;
    return msg;
  };

  const toggleExpert = async (id: string, enabled: boolean): Promise<void> => {
    setBusyId(`enable-${id}`);
    try {
      if (!window.api?.agent) throw new Error("专家 API 不可用，请重新启动应用");
      await window.api.agent.setExpertEnabled(id, enabled);
      await refreshExperts();
      setToast({ kind: "ok", text: enabled ? "专家模板已启用" : "专家模板已停用；已绑定任务保留自己的身份配置" });
    } catch (err) { setToast({ kind: "err", text: expertErrText(err) }); }
    finally { setBusyId(null); }
  };

  const handleImportZip = async (): Promise<void> => {
    setBusyId("import-zip");
    try {
      const picked = await (window.api as unknown as { pickZipFile?: () => Promise<{ path: string } | null> })?.pickZipFile?.();
      if (!picked?.path) return;
      if (!picked.path.toLowerCase().endsWith(".zip")) {
        setToast({ kind: "err", text: "仅支持 .zip 专家包，请选择 ZIP 文件" });
        return;
      }
      const dto = await importExpertZip(picked.path);
      setToast({ kind: "ok", text: dto ? `已导入「${dto.name}」` : "ZIP 已导入" });
    } catch (err) {
      setToast({ kind: "err", text: `导入失败：${expertErrText(err)}` });
    } finally {
      setBusyId(null);
    }
  };

  const handleImportFolder = async (): Promise<void> => {
    setBusyId("import-folder");
    try {
      const picked = await (window.api as unknown as { pickLocalFolder?: () => Promise<{ path: string } | null> })?.pickLocalFolder?.();
      if (!picked?.path) return;
      const dto = await installExpertByPath(picked.path);
      setToast({ kind: "ok", text: dto ? `已导入「${dto.name}」` : "文件夹已导入" });
    } catch (err) {
      setToast({ kind: "err", text: `导入失败：${expertErrText(err)}` });
    } finally {
      setBusyId(null);
    }
  };

  const handleExpertDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (!files.length) return;
    const api = window.api as unknown as { getPathForFile?: (f: File) => string } | undefined;
    const paths = files
      .map((f) => {
        try {
          return api?.getPathForFile?.(f) ?? (f as unknown as { path?: string }).path ?? "";
        } catch {
          return "";
        }
      })
      .map((p) => p.trim())
      .filter(Boolean);
    if (!paths.length) {
      setToast({ kind: "err", text: "无法读取拖入文件路径，请用按钮导入" });
      return;
    }
    const target = paths[0];
    setBusyId("import-drop");
    try {
      const dto = target.toLowerCase().endsWith(".zip")
        ? await importExpertZip(target)
        : await installExpertByPath(target);
      setToast({ kind: "ok", text: dto ? `已导入「${dto.name}」` : "已导入" });
    } catch (err) {
      setToast({ kind: "err", text: `导入失败：${expertErrText(err)}` });
    } finally {
      setBusyId(null);
    }
  };

  const exportExpert = async (expertId: string): Promise<void> => {
    setBusyId(`export-${expertId}`);
    try {
      const path = await window.api?.agent?.exportExpert?.(expertId);
      if (path) {
        setToast({ kind: "ok", text: `已导出：${path}` });
        void window.api?.showItemInFolder?.(path);
      }
    } catch (err) {
      console.warn(err);
      setToast({ kind: "err", text: String(err instanceof Error ? err.message : err) });
    } finally {
      setBusyId(null);
    }
  };

  /**
   * @param listMode installed = 已安装列表：卸载后退回市场
   *                 market = 市场列表：删除=真正移除市场条目
   */
  const renderExpertCard = (
    expert: {
      id: string;
      name: string;
      description: string;
      author?: string;
      emoji?: string;
      tags?: string[];
      category?: string;
      version?: string;
      examples?: string[];
      source?: string;
      skills?: string[];
    },
    installed: ReturnType<typeof installedById>,
    listMode: "installed" | "market",
  ): React.JSX.Element => (
    <HubCard
      key={expert.id}
      expansionCommand={bulkExpansion.command}
      icon={<span style={{ fontSize: 16 }}>{expert.emoji || "🧙"}</span>}
      title={expert.name}
      meta={
        <>
          {expert.author ?? "—"}
          {expert.source === "zip" ? " · ZIP 导入" : expert.source === "folder" ? " · 本地导入" : ""}
          {expert.category ? ` · ${expert.category}` : ""}
          {expert.version ? ` · v${expert.version}` : ""}
          {installed?.skills?.length ? ` · ${installed.skills.length} skills` : ""}
        </>
      }
      description={expert.description}
      tags={expert.tags}
      density="compact"
      highlight={!!installed}
      status={
        installed ? (
          <HubStatusBadge label={installed.enabled ? "已启用" : "已停用"} tone={installed.enabled ? "positive" : "neutral"} />
        ) : expert.version ? (
          <HubStatusBadge label={`v${expert.version}`} tone="neutral" />
        ) : (
          <HubStatusBadge label="未安装" tone="neutral" />
        )
      }
      footer={
        listMode === "installed" && installed ? (
          <HubActionsMenu
            primary={
              <button type="button" className="btn primary" disabled={!installed.enabled} onClick={() => summonExpert(installed.id)}>
                召唤
              </button>
            }
            actions={[
              { label: "查看 / 编辑模板", onClick: () => { void refreshSkills(); setEditingExpertId(installed.id); } },
              { label: installed.enabled ? "停用模板" : "启用模板", onClick: () => void toggleExpert(installed.id, !installed.enabled), disabled: busyId === `enable-${installed.id}` },
              { label: busyId === `export-${installed.id}` ? "导出中…" : "导出", onClick: () => void exportExpert(installed.id), disabled: busyId === `export-${installed.id}` },
              { label: busyId === `un-${installed.id}` ? "卸载中…" : "卸载", onClick: () => void (async () => { setBusyId(`un-${installed.id}`); try { await uninstallExpert(installed.id); setToast({ kind: "ok", text: `已卸载「${expert.name}」` }); } catch (err) { setToast({ kind: "err", text: `卸载失败：${expertErrText(err)}` }); } finally { setBusyId(null); } })(), disabled: busyId === `un-${installed.id}` },
            ]}
          />
        ) : installed ? (
          <HubActionsMenu
            primary={
              <button type="button" className="btn primary" disabled={!installed.enabled} onClick={() => summonExpert(installed.id)}>
                召唤
              </button>
            }
            actions={[
              { label: "查看 / 编辑模板", onClick: () => { void refreshSkills(); setEditingExpertId(installed.id); } },
              { label: installed.enabled ? "停用模板" : "启用模板", onClick: () => void toggleExpert(installed.id, !installed.enabled), disabled: busyId === `enable-${installed.id}` },
              { label: busyId === `un-${installed.id}` ? "卸载中…" : "卸载", onClick: () => void (async () => { setBusyId(`un-${installed.id}`); try { await uninstallExpert(installed.id); setToast({ kind: "ok", text: `已卸载「${expert.name}」` }); } catch (err) { setToast({ kind: "err", text: `卸载失败：${expertErrText(err)}` }); } finally { setBusyId(null); } })() },
              { label: busyId === `mkt-${expert.id}` ? "删除中…" : "永久删除", danger: true, dividerBefore: true, onClick: () => void (async () => { setBusyId(`mkt-${expert.id}`); try { await deleteMarketExpert(expert.id); setToast({ kind: "ok", text: `已从市场删除「${expert.name}」` }); } catch (err) { setToast({ kind: "err", text: `删除失败：${err instanceof Error ? err.message : String(err)}` }); } finally { setBusyId(null); } })() },
            ]}
          />
        ) : (
          <HubActionsMenu
            primary={
              <button
                type="button"
                className="btn primary"
                disabled={busyId === expert.id}
                onClick={() => void (async () => { setBusyId(expert.id); try { await installExpert(expert.id); setToast({ kind: "ok", text: `已安装「${expert.name}」` }); } catch (err) { setToast({ kind: "err", text: `安装失败：${expertErrText(err)}` }); } finally { setBusyId(null); } })()}
              >
                {busyId === expert.id ? "安装中…" : "安装"}
              </button>
            }
            actions={[{ label: busyId === `mkt-${expert.id}` ? "删除中…" : "永久删除", danger: true, onClick: () => void (async () => { setBusyId(`mkt-${expert.id}`); try { await deleteMarketExpert(expert.id); setToast({ kind: "ok", text: `已从市场删除「${expert.name}」` }); } catch (err) { setToast({ kind: "err", text: `删除失败：${err instanceof Error ? err.message : String(err)}` }); } finally { setBusyId(null); } })() }]}
          />
        )
      }
    >
      {installed?.skills?.length ? <ExpertPrivateSkills expertId={installed.id} skillIds={installed.skills ?? []} /> : null}
      {expert.examples?.length ? (
        <div className="expert-examples" style={{ marginTop: 6 }}>
          {expert.examples.slice(0, 2).map((ex) => (
            <div key={ex} className="expert-example" title={ex}>
              💬 {ex}
            </div>
          ))}
          {expert.examples.length > 2 && <div className="expert-example">… +{expert.examples.length - 2}</div>}
        </div>
      ) : null}
    </HubCard>
  )

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => void handleExpertDrop(e)}
      className={`hub-tab-body${dragOver ? " expert-drop-active" : ""}`}
    >
      <HubToast toast={toast} />
      <HubImportBar
        onCreate={() => { void refreshSkills(); setAuthoringOpen(true); }}
        createLabel="创建专家"
        onImportZip={() => void handleImportZip()}
        onImportFolder={() => void handleImportFolder()}
        busyId={busyId}
        hint="创建单专家或导入 ZIP / 文件夹；Private Skills 随专家生命周期管理"
        rightAction={<HubBulkExpandButton command={bulkExpansion.command} onToggle={bulkExpansion.toggle} />}
      />
      {authoringOpen && (
        <HubAuthoringModal
          mode="expert"
          skills={installedSkills}
          onClose={() => setAuthoringOpen(false)}
          onCreated={async (message) => { await refreshExperts(); setToast({ kind: "ok", text: message }); }}
        />
      )}
      {editingExpertId && <HubAuthoringModal mode="expert" expertId={editingExpertId} skills={installedSkills} onClose={() => setEditingExpertId(null)} onCreated={async (message) => { await refreshExperts(); setToast({ kind: "ok", text: message }); }} />}
      <HubDropOverlay visible={dragOver} text="松开以导入（ZIP 自动走 ZIP 导入，文件夹走本地目录导入）" />

      {(() => {
            const cats = [
              "全部",
              "已安装",
              ...new Set(filteredMarket.map((e) => e.category ?? "其他")),
            ];
            const showInstalledOnly = marketCat === "已安装";
            const marketVisible = showInstalledOnly
              ? filteredMarket.filter((e) => isExpertInstalled(e.id, e.name))
              : marketCat === "全部"
                ? filteredMarket
                : filteredMarket.filter((e) => (e.category ?? "其他") === marketCat);
            // 仅「全部」时在顶部插入本地导入；「已安装」时把本地导入并入列表
            const showCustomInAll = marketCat === "全部" && customInstalled.length > 0;
            const showCustomInInstalled = showInstalledOnly && customInstalled.length > 0;
            const empty =
              marketVisible.length === 0 &&
              !showCustomInAll &&
              !showCustomInInstalled &&
              (showInstalledOnly ? totalInstalledExperts === 0 : filteredMarket.length === 0);

            return (
              <>
                <HubToolbar
                  left={
                    <HubFilterPills
                      pills={cats.map((c) => ({
                        id: c,
                        label: c,
                        count:
                          c === "全部"
                            ? filteredMarket.length + customInstalled.length
                            : c === "已安装"
                              ? totalInstalledExperts
                              : filteredMarket.filter((e) => (e.category ?? "其他") === c).length,
                      }))}
                      activeId={marketCat}
                      onChange={(id) => setMarketCat(id)}
                    />
                  }
                />

                {empty ? (
                  <HubEmpty
                    icon="🛍️"
                    title={showInstalledOnly ? "尚未安装专家" : "市场暂无更多专家"}
                    description={showInstalledOnly ? "切换到「全部」或分类浏览并安装专家" : "从市场安装专家后，可在「已安装」中管理"}
                  />
                ) : (
                  <>
                    {(showCustomInAll || showCustomInInstalled) && (
                      <>
                        {showCustomInAll && (
                          <div className="hub-section-note">本地导入 · 不在市场目录中</div>
                        )}
                        <HubGrid density="compact">
                          {customInstalled.map((expert) =>
                            renderExpertCard(
                              expert,
                              expert,
                              showInstalledOnly ? "installed" : "market",
                            ),
                          )}
                        </HubGrid>
                      </>
                    )}
                    {marketVisible.length > 0 && (
                      <HubGrid density="compact">
                        {marketVisible.map((expert) =>
                          renderExpertCard(
                            expert,
                            installedById(expert.id) ?? installedById(expert.name),
                            showInstalledOnly ? "installed" : "market",
                          ),
                        )}
                      </HubGrid>
                    )}
                  </>
                )}
              </>
            );
      })()}
    </div>
  );
}

/**
 * 已安装专家的 Private Skills 展示：数量 + 名称/描述（只读，来自 ExpertDto.skills + 详情 IPC）。
 * 不写入全局 Skill Center；加载失败时回退仅显示目录名。
 */
function ExpertPrivateSkills({
  expertId,
  skillIds,
}: {
  expertId: string;
  skillIds: string[];
}): React.JSX.Element | null {
  const [details, setDetails] = useState<
    Array<{ id: string; name: string; description: string; shadowed?: boolean }> | null
  >(null);
  useEffect(() => {
    let alive = true;
    setDetails(null);
    void window.api?.agent?.listExpertPrivateSkills?.(expertId).then((rows) => {
      if (alive && Array.isArray(rows)) setDetails(rows);
    }).catch(() => {
      if (alive) setDetails([]);
    });
    return () => {
      alive = false;
    };
  }, [expertId]);
  const rows = details ??
    skillIds.map((id) => ({ id, name: id, description: "", shadowed: false }));
  if (!rows.length) return null;
  return (
    <div className="expert-private-skills">
      <div className="expert-private-skills-title">
        自带技能 <span className="hub-subtab-count">{rows.length}</span>
      </div>
      <div className="expert-skill-tags">
        {rows.slice(0, 6).map((s) => (
          <span
            key={s.id}
            className={`expert-skill-tag${s.shadowed ? " shadowed" : ""}`}
            title={
              s.shadowed
                ? `${s.description || s.id}（被全局同名技能覆盖：first-wins 优先级不变，会话使用全局版本）`
                : s.description || s.id
            }
          >
            {s.name}
            {s.shadowed && <span className="expert-skill-shadow-badge">被全局覆盖</span>}
          </span>
        ))}
        {rows.length > 6 && <span className="expert-skill-tag expert-skill-tag--more">+{rows.length - 6}</span>}
      </div>
    </div>
  );
}

/** 技能来源徽章：我的 / 内置 / 连接器 / 市场 */
function SkillSourceBadge({ skill }: { skill: Skill }): React.JSX.Element | null {
  const src = skill.source;
  let label: string;
  if (!src || src === "manual") {
    label = "我的";
  } else if (src === "builtin-market") {
    label = "本地";
  } else if (src === "local-market") {
    label = "MyBuddy";
  } else if (src.startsWith("connector:")) {
    label = `连接器·${src.slice("connector:".length)}`;
  } else {
    label = src;
  }
  return <HubStatusBadge label={label} tone="neutral" />;
}

/** 市场条目 source/author → 分类 */
function marketSkillKind(skill: { source?: string; author?: string }): "本地" | "MyBuddy" {
  if (skill.source === "local") return "本地";
  if (skill.source === "mybuddy") return "MyBuddy";
  const a = (skill.author ?? "").toLowerCase();
  if (a.includes("mybuddy") || a === "内置") return "本地";
  return "MyBuddy";
}

function SkillsTab({ query }: { query: string }): React.JSX.Element {
  const skills = useAppStore((s) => s.skills);
  const marketSkills = useAppStore((s) => s.marketSkills);
  const setSkillEnabled = useAppStore((s) => s.setSkillEnabled);
  const installSkill = useAppStore((s) => s.installSkill);
  const installSkillByPath = useAppStore((s) => s.installSkillByPath);
  const uninstallSkill = useAppStore((s) => s.uninstallSkill);
  const deleteMarketSkill = useAppStore((s) => s.deleteMarketSkill);
  const refreshSkills = useAppStore((s) => s.refreshSkills);
  const [authoringOpen, setAuthoringOpen] = useState(false);
  const [detailSkill, setDetailSkill] = useState<Skill | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<HubToastState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const skillErr = (err: unknown): string => {
    const m = err instanceof Error ? err.message : String(err);
    if (m.includes("SKILL.md")) return `${m} · 请确认目录包含 SKILL.md`;
    return m;
  };
  const handleSkillDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (!files.length) return;
    const api = window.api as unknown as { getPathForFile?: (f: File) => string } | undefined;
    const paths = files
      .map((f) => {
        try {
          return api?.getPathForFile?.(f) ?? (f as unknown as { path?: string }).path ?? "";
        } catch {
          return "";
        }
      })
      .map((p) => p.trim())
      .filter(Boolean);
    if (!paths.length) {
      setToast({ kind: "err", text: "无法读取拖入路径，请用按钮导入" });
      return;
    }
    setBusyId("import-drop");
    try {
      await installSkillByPath(paths[0]);
      setToast({ kind: "ok", text: "已导入技能" });
    } catch (err) {
      setToast({ kind: "err", text: `导入失败：${skillErr(err)}` });
    } finally {
      setBusyId(null);
    }
  };
  const handleImportSkillFolder = async (): Promise<void> => {
    setBusyId("import-folder");
    try {
      const picked = await (window.api as unknown as { pickLocalFolder?: () => Promise<{ path: string } | null> })?.pickLocalFolder?.();
      if (!picked?.path) return;
      await installSkillByPath(picked.path);
      setToast({ kind: "ok", text: "已导入技能" });
    } catch (err) {
      setToast({ kind: "err", text: `导入失败：${skillErr(err)}` });
    } finally {
      setBusyId(null);
    }
  };
  /** 子标签：已安装 | 市场（官方库） */
  const [subTab, setSubTab] = useState<"local" | "mybuddy">("local");
  /** 市场内来源筛选：全部 | 本地 | MyBuddy */
  const [marketSource, setMarketSource] = useState<"全部" | "本地" | "MyBuddy">("全部");
  const bulkExpansion = useHubBulkExpansion();

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  /** 已安装列表（全部本地副本，可删除） */
  const filteredInstalled = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.command?.toLowerCase().includes(q),
    );
  }, [skills, query]);

  const filteredMarket = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = marketSkills;
    if (marketSource !== "全部") {
      list = list.filter((s) => marketSkillKind(s) === marketSource);
    }
    if (!q) return list;
    return list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [marketSkills, query, marketSource]);

  const marketLocalCount = useMemo(
    () => marketSkills.filter((s) => marketSkillKind(s) === "本地").length,
    [marketSkills],
  );
  const marketWbCount = useMemo(
    () => marketSkills.filter((s) => marketSkillKind(s) === "MyBuddy").length,
    [marketSkills],
  );

  const findInstalledSkill = (marketId: string, marketName: string) =>
    skills.find(
      (s) => s.name === marketName || s.id === marketName || s.name === marketId || s.id === marketId,
    );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => void handleSkillDrop(e)}
      className={`hub-tab-body${dragOver ? " expert-drop-active" : ""}`}
    >
      <HubToast toast={toast} />
      <HubImportBar
        onCreate={() => setAuthoringOpen(true)}
        createLabel="创建 Skill"
        onImportFolder={() => void handleImportSkillFolder()}
        busyId={busyId}
        hint="创建结构化 Skill 包或导入含 SKILL.md 的文件夹"
        rightAction={<HubBulkExpandButton command={bulkExpansion.command} onToggle={bulkExpansion.toggle} />}
      />
      {authoringOpen && (
        <HubAuthoringModal
          mode="skill"
          onClose={() => setAuthoringOpen(false)}
          onCreated={async (message, createdSkill) => {
            await refreshSkills();
            setToast({ kind: "ok", text: message });
            if (createdSkill) setDetailSkill(createdSkill);
          }}
        />
      )}
      {detailSkill && (
        <HubSkillDetailModal
          skill={detailSkill}
          onClose={() => setDetailSkill(null)}
          onApplied={async (message) => { await refreshSkills(); setToast({ kind: "ok", text: message }); }}
        />
      )}
      <HubDropOverlay visible={dragOver} text="松开以导入技能文件夹" />
      <HubToolbar
        left={
          <HubFilterPills
            pills={[
              { id: "local", label: "已安装", count: skills.length },
              { id: "mybuddy", label: "市场", count: marketSkills.length },
            ]}
            activeId={subTab}
            onChange={(id) => setSubTab(id as "local" | "mybuddy")}
          />
        }
      />

      {subTab === "local" && (
        <>
          <div className="skill-toolbar">
            <div className="skill-toolbar-titles">
              <span className="skill-toolbar-title">已安装</span>
              <span className="mcp-count">{skills.length}</span>
            </div>
          </div>
          {filteredInstalled.length === 0 ? (
            <HubEmpty icon="🧩" title="尚未安装技能" description="可从「市场」安装；「卸载」只移除本地副本，市场仍可再装" />
          ) : (
            <HubGrid density="compact">
              {filteredInstalled.map((skill) => (
                <HubCard
                  key={skill.id}
                  expansionCommand={bulkExpansion.command}
                  icon={skill.icon ? <span className="skill-card-icon">{skill.icon}</span> : <span>🧩</span>}
                  title={skill.name}
                  meta={
                    <div className="hub-card-meta-stack">
                      <span>{skill.command ? `/${skill.command} · ` : ""}{skill.builtin ? "用户技能" : skill.author ?? "—"}</span>
                      {skill.filePath && <span className="hub-card-path" title={skill.filePath}>{skill.filePath}</span>}
                    </div>
                  }
                  description={skill.description}
                  tags={[]}
                  density="compact"
                  highlight={true}
                  status={<HubStatusBadge label={skill.enabled ? "已启用" : "已停用"} tone={skill.enabled ? "positive" : "neutral"} />}
                  footer={
                    <HubActionsMenu
                      primary={
                        <button
                          type="button"
                          className={`switch ${skill.enabled ? "on" : ""}`}
                          title={skill.enabled ? "点击停用" : "点击启用"}
                          onClick={() => setSkillEnabled(skill.id, !skill.enabled)}
                          style={{ flexShrink: 0 }}
                        />
                      }
                      actions={[
                        {
                          label: "详情 / 测试",
                          onClick: () => setDetailSkill(skill),
                        },
                        {
                          label: busyId === `un-${skill.id}` ? "卸载中…" : "卸载",
                          danger: true,
                          onClick: () => void (async () => { setBusyId(`un-${skill.id}`); try { await uninstallSkill(skill.id); setToast({ kind: "ok", text: `已卸载「${skill.name}」，已退回市场` }); } catch (err) { setToast({ kind: "err", text: `卸载失败：${skillErr(err)}` }); } finally { setBusyId(null); } })(),
                        },
                      ]}
                    />
                  }
                >
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                    {skill.command && <span className="hub-card-tag">/{skill.command}</span>}
                    <SkillSourceBadge skill={skill} />
                  </div>
                </HubCard>
              ))}
            </HubGrid>
          )}
        </>
      )}
      {subTab === "mybuddy" && (
        <>
          <HubFilterPills
            pills={[
              { id: "全部", label: "全部", count: marketSkills.length },
              { id: "本地", label: "本地", count: marketLocalCount },
              { id: "MyBuddy", label: "MyBuddy", count: marketWbCount },
            ]}
            activeId={marketSource}
            onChange={(id) => setMarketSource(id as "全部" | "本地" | "MyBuddy")}
          />

          <div className="hub-section-note">
            「卸载」退回市场可再装；市场里的「删除」才永久移除该条目
          </div>
          {filteredMarket.length === 0 ? (
            <HubEmpty
              icon="🛍️"
              title={marketSource === "全部" ? "市场暂无更多技能" : `暂无「${marketSource}」技能`}
              description="市场为只读来源：安装是复制到 ~/.mybuddy/plugins/skills/，删除本地后可随时重新安装"
            />
          ) : (
            <HubGrid density="compact">
              {filteredMarket.map((skill) => {
                const installed = findInstalledSkill(skill.id, skill.name);
                const kind = marketSkillKind(skill);
                return (
                  <HubCard
                    key={skill.id}
                    expansionCommand={bulkExpansion.command}
                    icon={skill.icon ? <span className="skill-card-icon">{skill.icon}</span> : <span>🧩</span>}
                    title={skill.name}
                    meta={skill.author ?? "—"}
                    description={skill.description}
                    tags={[]}
                    density="compact"
                    highlight={!!installed}
                    status={
                      installed ? (
                        <HubStatusBadge label="已安装" tone="positive" />
                      ) : skill.version ? (
                        <HubStatusBadge label={`v${skill.version}`} tone="neutral" />
                      ) : (
                        <HubStatusBadge label={kind} tone="neutral" />
                      )
                    }
                    footer={
                      installed ? (
                        <HubActionsMenu
                          primary={
                            <button
                              type="button"
                              className="btn"
                              disabled={busyId === `un-${installed.id}`}
                              onClick={() => void (async () => { setBusyId(`un-${installed.id}`); try { await uninstallSkill(installed.id); setToast({ kind: "ok", text: `已卸载「${skill.name}」，已退回市场` }); } catch (err) { setToast({ kind: "err", text: `卸载失败：${skillErr(err)}` }); } finally { setBusyId(null); } })()}
                              title="卸载本地副本，退回市场"
                            >
                              {busyId === `un-${installed.id}` ? "卸载中…" : "卸载"}
                            </button>
                          }
                          actions={[
                            { label: busyId === `mkt-${skill.id}` ? "删除中…" : "永久删除", danger: true, onClick: () => void (async () => { setBusyId(`mkt-${skill.id}`); try { await deleteMarketSkill(skill.id); setToast({ kind: "ok", text: `已从市场删除「${skill.name}」` }); } catch (err) { setToast({ kind: "err", text: `删除失败：${err instanceof Error ? err.message : String(err)}` }); } finally { setBusyId(null); } })() },
                          ]}
                        />
                      ) : (
                        <HubActionsMenu
                          primary={
                            <button
                              type="button"
                              className="btn primary"
                              disabled={busyId === skill.id}
                              onClick={() => void (async () => { setBusyId(skill.id); try { await installSkill(skill.id); setToast({ kind: "ok", text: `已安装「${skill.name}」` }); } catch (err) { setToast({ kind: "err", text: `安装失败：${skillErr(err)}` }); } finally { setBusyId(null); } })()}
                              title="安装技能到本地"
                            >
                              {busyId === skill.id ? "安装中…" : "安装"}
                            </button>
                          }
                          actions={[{ label: busyId === `mkt-${skill.id}` ? "删除中…" : "永久删除", danger: true, onClick: () => void (async () => { setBusyId(`mkt-${skill.id}`); try { await deleteMarketSkill(skill.id); setToast({ kind: "ok", text: `已从市场删除「${skill.name}」` }); } catch (err) { setToast({ kind: "err", text: `删除失败：${err instanceof Error ? err.message : String(err)}` }); } finally { setBusyId(null); } })() }]}
                        />
                      )
                    }
                  >
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                      {skill.command && <span className="hub-card-tag">/{skill.command}</span>}
                      <span className="hub-card-tag">{kind}</span>
                    </div>
                  </HubCard>
                );
              })}
            </HubGrid>
          )}
        </>
      )}
    </div>
  );
}

function McpTab({ query }: { query: string }): React.JSX.Element {
  const [editor, setEditor] = useState<{ name: string | null } | null>(null);
  const [toolsServer, setToolsServer] = useState<string | null>(null);
  const focusName = useAppStore((s) => s.hubMcpFocusName);
  const [discovery, setDiscovery] = useState<McpDiscoveryDto | null>(null);
  const [servers, setServers] = useState<McpServerDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  /* -------- 运行时（Pi 原生 MCP，管理会话与任务会话独立） -------- */
  const [runtime, setRuntime] = useState<McpStatusSnapshotDto | null>(null);
  /** 授权弹窗：null 关闭；"waiting" 等待授权中；"done" 成功；"error" 失败 */
  const [authServer, setAuthServer] = useState<string | null>(null);
  const [authState, setAuthState] = useState<"waiting" | "done" | "error">("waiting");
  const [authUrl, setAuthUrl] = useState("");
  const [authInput, setAuthInput] = useState("");
  const [authError, setAuthError] = useState("");
  /** MCP 服务器发起的交互请求（sampling/elicitation） */
  const [uiReq, setUiReq] = useState<McpUiPromptDto | null>(null);
  const [uiValue, setUiValue] = useState("");
  const [busyAuth, setBusyAuth] = useState<string | null>(null);
  const bulkExpansion = useHubBulkExpansion();

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const [d, s, st] = await Promise.all([
        window.api?.mcp?.discover(),
        window.api?.mcp?.listServers(),
        window.api?.mcp?.status(),
      ]);
      if (!d || !s) return;
      setDiscovery(d);
      setServers(s);
      setSelected(new Set());
      setRuntime(st ?? null);
    } catch (err) {
      console.warn("[McpTab] 加载失败", err);
      setNotice({ kind: "err", text: "加载 MCP 配置失败" });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!focusName) return;
    const el = document.getElementById(`hub-mcp-${focusName}`);
    if (!el) return;
    requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, [focusName, servers]);

  // 订阅运行时状态 / 通知 / 交互请求
  useEffect(() => {
    const unsubStatus = window.api?.mcp?.onStatusEvent?.((snapshot) => { if (!snapshot.sessionId || snapshot.sessionId === "mcp-headless") setRuntime(snapshot); });
    const unsubNotify = window.api?.mcp?.onNotify?.((ev) => {
      setNotice({ kind: ev.type === "error" ? "err" : "ok", text: ev.message });
    });
    const unsubUi = window.api?.mcp?.onUiPrompt?.((req) => {
      setUiValue("");
      setUiReq(req);
    });
    void window.api?.mcp?.status?.().then((snapshot) => setRuntime(snapshot));
    return () => {
      unsubStatus?.();
      unsubNotify?.();
      unsubUi?.();
    };
  }, []);

  // A browser loopback callback finishes asynchronously, without authComplete being clicked.
  useEffect(() => {
    if (!authServer || authState !== 'waiting') return;
    const server = runtime?.servers.find(item => item.name === authServer);
    if (server?.status === 'connected' && server.hasCredentials) setAuthState('done');
  }, [runtime, authServer, authState]);

  const statusOf = (name: string): McpStatusSnapshotDto["servers"][number] | undefined =>
    runtime?.servers?.find((s) => s.name === name);

  const toggleSelect = (name: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const installSelected = async (): Promise<void> => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const result = await window.api?.mcp?.install([...selected]);
      if (!result) return;
      if (result.ok) {
        const added = result.added?.length ? `新增 ${result.added.length} 个` : "";
        const updated = result.removed?.length ? `更新 ${result.removed.length} 个` : "";
        setNotice({
          kind: "ok",
          text: `已写入 ${result.path}（${[added, updated].filter(Boolean).join("，") || "完成"}）`,
        });
        await refresh();
      } else {
        setNotice({ kind: "err", text: result.error ?? "安装失败" });
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleServer = async (server: McpServerDto): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.api?.mcp?.setServerEnabled(server.name, server.disabled);
      if (!result) return;
      if (result.ok) {
        setNotice({ kind: "ok", text: server.disabled ? `已启用 ${server.name}` : `已停用 ${server.name}` });
        await refresh();
      } else {
        setNotice({ kind: "err", text: result.error ?? "操作失败" });
      }
    } finally {
      setBusy(false);
    }
  };

  const removeServer = async (name: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.api?.mcp?.remove([name]);
      if (!result) return;
      if (result.ok) {
        setNotice({ kind: "ok", text: `已从 MyBuddy 移除 ${name}` });
        await refresh();
      } else {
        setNotice({ kind: "err", text: result.error ?? "移除失败" });
      }
    } finally {
      setBusy(false);
    }
  };

  /* -------- 运行时操作 -------- */

  const connectServer = async (name: string): Promise<void> => {
    setBusyAuth(name);
    try {
      const result = await window.api?.mcp?.connect(name);
      if (!result) return;
      if (result.ok) {
        setNotice({ kind: "ok", text: result.text || `已连接 ${name}` });
      } else {
        setNotice({ kind: "err", text: result.error ?? "连接失败" });
      }
    } finally {
      setBusyAuth(null);
    }
  };

  const startAuth = async (name: string): Promise<void> => {
    if (busyAuth) return;
    setBusyAuth(name);
    setAuthServer(name);
    setAuthState("waiting");
    setAuthUrl("");
    setAuthInput("");
    setAuthError("");
    try {
      const result = await window.api?.mcp?.authStart(name);
      if (!result) return;
      if (result.ok) {
        const details = result.details ?? {};
        if (details.authenticated === true) {
          setAuthState("done");
        } else {
          setAuthUrl((details.authorizationUrl as string) ?? "");
          setAuthState("waiting");
        }
      } else {
        setAuthState("error");
        setAuthError(result.error ?? "授权失败");
      }
    } finally {
      setBusyAuth(null);
    }
  };

  const completeAuth = async (): Promise<void> => {
    if (!authServer) return;
    setBusyAuth(authServer);
    try {
      const result = await window.api?.mcp?.authComplete(authServer, authInput);
      if (!result) return;
      if (result.ok) {
        setAuthState("done");
        setNotice({ kind: "ok", text: `OAuth 授权成功：${authServer}` });
        setTimeout(() => setAuthServer(null), 1200);
      } else {
        setAuthError(result.error ?? "授权未完成");
        setAuthState("error");
      }
    } finally {
      setBusyAuth(null);
    }
  };

  const logoutServer = async (name: string): Promise<void> => {
    setBusyAuth(name);
    try {
      const result = await window.api?.mcp?.logout(name);
      if (!result) return;
      if (result.ok) {
        setNotice({ kind: "ok", text: `已清除 ${name} 的 OAuth 凭证` });
      } else {
        setNotice({ kind: "err", text: result.error ?? "登出失败" });
      }
    } finally {
      setBusyAuth(null);
    }
  };

  const respondUi = (value: string | boolean): void => {
    if (!uiReq) return;
    void window.api?.mcp?.uiRespond?.(uiReq.requestId, value);
    setUiReq(null);
  };

  const cancelUi = (): void => {
    if (!uiReq) return;
    void window.api?.mcp?.uiCancel?.(uiReq.requestId);
    setUiReq(null);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.endpoint.toLowerCase().includes(q) ||
        s.sourcePath.toLowerCase().includes(q),
    );
  }, [servers, query]);

  const installed = filtered.filter((s) => s.installed);
  const available = filtered.filter((s) => !s.installed);

  const groups = useMemo(() => {
    const map = new Map<string, McpServerDto[]>();
    for (const server of available) {
      const list = map.get(server.sourceId) ?? [];
      list.push(server);
      map.set(server.sourceId, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [available]);

  const renderServerCard = (
    server: McpServerDto,
    corner: React.ReactNode,
    actions?: React.ReactNode,
  ): React.JSX.Element => {
    const status = server.installed ? statusOf(server.name) : undefined;
    const tone = status?.status === "connected" ? "positive" : status?.status === "needs-auth" ? "attention" : status?.status === "failed" ? "error" : "neutral";
    const label = server.disabled ? "已停用" : STATUS_LABEL[status?.status ?? "not-connected"] ?? status?.status ?? "未连接";
    const isInstalled = server.installed;
    return (
      <HubCard
        key={server.name}
        id={`hub-mcp-${server.name}`}
        focused={focusName === server.name}
        expansionCommand={bulkExpansion.command}
        icon={<span>🔌</span>}
        title={server.name}
        meta={
          <div className="hub-card-meta-stack">
            <span className="hub-card-path" title={server.sourcePath}>{server.sourcePath || server.sourceId}</span>
            <span>
              {server.transport || "未知传输"}
              {status ? ` · ${status.toolCount} 工具 · ${status.resourceCount ?? 0} 资源` : ""}
              {server.exposure ? ` · ${MCP_EXPOSURE_LABELS[server.exposure] ?? server.exposure}` : ""}
            </span>
          </div>
        }
        description={server.description || server.endpoint || "—"}
        tags={[]}
        density={isInstalled ? "normal" : "compact"}
        highlight={!!isInstalled && !server.disabled}
        status={
          <>
            <HubStatusBadge label={label} tone={tone as "positive" | "attention" | "neutral" | "error"} />
            {server.disabled && <HubStatusBadge label="已停用" tone="neutral" />}
          </>
        }
        footer={
          actions ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", width: "100%" }}>{actions}</div>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>{corner}</div>
          )
        }
      >
        {isInstalled ? <ManagedMcpRuntimeBar serverName={server.name} /> : null}
        {server.description && <div className="hub-card-path">{server.endpoint}</div>}
        {status?.error && <div className="mcp-config-error" role="alert">{status.error}</div>}
        {status?.exposure && status.exposure !== server.exposure && <div className="mcp-config-hint">管理会话提供方式：{MCP_EXPOSURE_LABELS[status.exposure] ?? status.exposure}</div>}
        {corner && actions ? <div style={{ marginTop: 4, display: "flex", alignItems: "center" }}>{corner}</div> : null}
      </HubCard>
    );
  };

  return (
    <div className="hub-tab-body hub-tab-body--mcp">
      <div className="mcp-toolbar">
        <span className="mcp-cwd-label">MyBuddy 全局配置</span>
        <span className="mcp-cwd-value" title={discovery?.appGlobalConfigPath ?? ""}>
          {discovery?.appGlobalConfigPath ?? ""}
        </span>
        <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
          刷新
        </button>
        <button type="button" className="btn primary" onClick={() => setEditor({ name: null })}>新增 MCP</button>
        <HubBulkExpandButton command={bulkExpansion.command} onToggle={bulkExpansion.toggle} />
      </div>
      {notice && <HubToast toast={{ kind: notice.kind === "err" ? "err" : "ok", text: notice.text }} />}
      <div className="mcp-native-summary">
        <HubStatusBadge label="Pi 原生 MCP" tone="neutral" />
        <span>{runtime?.connectedCount ?? 0} 个已连接 · {runtime?.totalTools ?? 0} 个工具 · {runtime?.totalResources ?? 0} 个资源</span>
        {runtime === null && <span>管理会话尚未就绪</span>}
      </div>
      {!!runtime?.errors?.length && <div className="mcp-config-error" role="alert">{runtime.errors.join("\n")}</div>}

      <HubHeader title="已安装到 MyBuddy" count={installed.length} description="支持本地程序、Streamable HTTP、OAuth 与工具提供方式配置" />
      {installed.length === 0 ? (
        <HubEmpty icon="🔌" title="还没有安装任何 MCP 服务器" description="点击“新增 MCP”配置服务器，或从下方来源导入；安装后即可在对话中调用" />
      ) : (
        <HubGrid density="normal">
          {installed.map((server) =>
            renderServerCard(
              server,
              <button
                type="button"
                className={`switch ${!server.disabled ? "on" : ""}`}
                disabled={busy}
                aria-label={server.disabled ? `启用 ${server.name}` : `停用 ${server.name}`}
                title={server.disabled ? "点击启用" : "点击停用"}
                onClick={() => void toggleServer(server)}
              />,
              <HubActionsMenu
                primary={
                  statusOf(server.name)?.status === "needs-auth" ? (
                    <button type="button" className="btn primary" disabled={busy || busyAuth === server.name} onClick={() => void startAuth(server.name)} title="OAuth 授权（浏览器）">
                      {busyAuth === server.name ? "授权中…" : "授权"}
                    </button>
                  ) : (
                    <button type="button" className="btn primary" disabled={server.disabled || busy || busyAuth === server.name} onClick={() => void connectServer(server.name)} title="连接/刷新服务器">
                      {busyAuth === server.name ? "连接中…" : "连接"}
                    </button>
                  )
                }
                actions={[
                  { label: "编辑配置", onClick: () => setEditor({ name: server.name }), disabled: busy },
                  { label: "查看工具", onClick: () => setToolsServer(server.name), disabled: busy || server.disabled },
                  ...(statusOf(server.name)?.status === "needs-auth"
                    ? [{ label: busyAuth === server.name ? "连接中…" : "连接", onClick: () => void connectServer(server.name), disabled: busy || busyAuth === server.name }]
                    : server.transport === "url"
                      ? [{ label: busyAuth === server.name ? "授权中…" : "授权", onClick: () => void startAuth(server.name), disabled: busy || busyAuth === server.name }]
                      : []),
                  { label: "清除凭证", onClick: () => void logoutServer(server.name), disabled: busyAuth === server.name },
                  { label: "移除", danger: true, dividerBefore: true, onClick: () => void removeServer(server.name), disabled: busy },
                ]}
              />
            ),
          )}
        </HubGrid>
      )}

      <HubHeader
        title="可从其他来源安装"
        count={available.length}
        description="来自其他来源的可用服务器"
        action={
          available.length > 0 ? (
            <div className="mcp-install-action">
              <span>已选 {selected.size} 个</span>
              <button
                type="button"
                className="btn primary"
                disabled={busy || selected.size === 0}
                onClick={() => void installSelected()}
              >
                {busy ? "处理中…" : "安装到 MyBuddy"}
              </button>
            </div>
          ) : undefined
        }
      />
      {available.length === 0 ? (
        <HubEmpty icon="✅" title="没有可安装的服务器" description="全部来源的服务器都已安装到 MyBuddy" />
      ) : (
        <>
          {groups.map(([sourceId, list]) => (
            <div key={sourceId} className="mcp-source-group">
              <div className="mcp-source-group-header">
                <span className="mcp-source-group-name">{sourceId}</span>
                <span className="mcp-source-group-count">{list.length} 个</span>
              </div>
              <HubGrid density="compact">
                {list.map((server) =>
                  renderServerCard(
                    server,
                    <label className="mcp-check" title="勾选后批量安装到 MyBuddy">
                      <input
                        type="checkbox"
                        checked={selected.has(server.name)}
                        onChange={() => toggleSelect(server.name)}
                      />
                    </label>,
                  ),
                )}
              </HubGrid>
            </div>
          ))}
        </>
      )}

      {editor && <McpConfigEditor key={editor.name ?? "new"} serverName={editor.name} onClose={() => setEditor(null)} onSaved={refresh} />}
      {toolsServer && <McpToolsDialog name={toolsServer} toolCount={statusOf(toolsServer)?.toolCount ?? 0} onClose={() => setToolsServer(null)} />}
      {/* OAuth 授权弹窗 */}
      {authServer && (
        <div className="modal-overlay" onClick={() => setAuthServer(null)}>
          <div className="mcp-auth-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mcp-auth-title">OAuth 授权 · {authServer}</div>
            {authState === "waiting" && (
              <>
                <div className="mcp-auth-hint">
                  已打开授权页面（未自动打开时可复制链接到浏览器）：
                </div>
                <div className="mcp-auth-url" title={authUrl}>
                  {authUrl || "正在获取授权链接…"}
                </div>
                <div className="mcp-auth-hint">
                  授权完成后本窗口会自动关闭。若浏览器未跳转回本地回调，请把地址栏完整 URL
                  粘贴到下方后点击“完成授权”：
                </div>
                <input
                  className="mcp-auth-input"
                  value={authInput}
                  onChange={(e) => setAuthInput(e.target.value)}
                  placeholder="http://localhost:端口/callback?code=...&state=..."
                  spellCheck={false}
                />
                <div className="mcp-auth-actions">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!authInput.trim() || busyAuth === authServer}
                    onClick={() => void completeAuth()}
                  >
                    {busyAuth === authServer ? "处理中…" : "完成授权"}
                  </button>
                  <button type="button" className="btn" onClick={() => setAuthServer(null)}>
                    关闭
                  </button>
                </div>
              </>
            )}
            {authState === "done" && (
              <div className="mcp-auth-done">✓ 授权成功，凭证已安全保存</div>
            )}
            {authState === "error" && (
              <div className="mcp-auth-error">授权失败：{authError || "未知错误"}</div>
            )}
          </div>
        </div>
      )}

      {/* MCP 服务器交互请求弹窗（sampling / elicitation） */}
      {uiReq && (
        <div className="modal-overlay" onClick={cancelUi}>
          <div className="mcp-auth-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mcp-auth-title">{uiReq.title || "MCP 服务器请求"}</div>
            {uiReq.message && <div className="mcp-auth-hint">{uiReq.message}</div>}
            {uiReq.kind === "confirm" && (
              <div className="mcp-auth-actions">
                <button type="button" className="btn primary" onClick={() => respondUi(true)}>
                  允许
                </button>
                <button type="button" className="btn" onClick={() => respondUi(false)}>
                  拒绝
                </button>
              </div>
            )}
            {uiReq.kind === "select" && (
              <div className="mcp-auth-select">
                {(uiReq.options ?? []).map((option) => (
                  <button
                    type="button"
                    key={option}
                    className="btn"
                    style={{ justifyContent: "flex-start" }}
                    onClick={() => respondUi(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
            {(uiReq.kind === "input" || uiReq.kind === "editor") && (
              <>
                <textarea
                  className="mcp-auth-input"
                  rows={uiReq.kind === "editor" ? 6 : 2}
                  value={uiValue}
                  onChange={(e) => setUiValue(e.target.value)}
                  placeholder={uiReq.placeholder ?? ""}
                />
                <div className="mcp-auth-actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => respondUi(uiValue)}
                  >
                    确定
                  </button>
                  <button type="button" className="btn" onClick={cancelUi}>
                    取消
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectorsTab({ query }: { query: string }): React.JSX.Element {
  const connectors = useAppStore((s) => s.connectors);
  const installConnector = useAppStore((s) => s.installConnector);
  const importConnectorByPath = useAppStore((s) => s.importConnectorByPath);
  const importConnectorZip = useAppStore((s) => s.importConnectorZip);
  const uninstallConnector = useAppStore((s) => s.uninstallConnector);
  const setConnectorEnabled = useAppStore((s) => s.setConnectorEnabled);
  const deleteMarketConnector = useAppStore((s) => s.deleteMarketConnector);
  const refreshConnectors = useAppStore((s) => s.refreshConnectors);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connToast, setConnToast] = useState<HubToastState | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** 子标签：已安装 | 市场 */
  const [subTab, setSubTab] = useState<"installed" | "market">("installed");
  const bulkExpansion = useHubBulkExpansion();

  useEffect(() => {
    void refreshConnectors();
  }, [refreshConnectors]);

  useEffect(() => {
    if (!connToast) return;
    const timer = setTimeout(() => setConnToast(null), 5000);
    return () => clearTimeout(timer);
  }, [connToast]);

  const q = query.trim().toLowerCase();
  const filtered = connectors.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
  );
  const installedConnectors = filtered.filter((c) => c.installed);
  const marketConnectors = filtered.filter((c) => !c.installed);

  const copyCommand = async (connector: LocalConnectorDto): Promise<void> => {
    if (!connector.initCommand) return;
    try {
      await navigator.clipboard.writeText(connector.initCommand);
      setCopiedId(connector.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* ignore */
    }
  };

  const visibleConnectors = subTab === "installed" ? installedConnectors : marketConnectors;

  const handleConnectorImport = async (path: string, kind: "zip" | "folder"): Promise<void> => {
    const busy = kind === "zip" ? "import-zip" : "import-folder";
    setBusyId(busy);
    try {
      const dto = kind === "zip" ? await importConnectorZip(path) : await importConnectorByPath(path);
      setSubTab("installed");
      setConnToast({ kind: "ok", text: `已导入并安装连接器「${dto.name}」` });
    } catch (err) {
      setConnToast({ kind: "err", text: `导入失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusyId(null);
    }
  };

  const pickConnectorZip = async (): Promise<void> => {
    const picked = await window.api?.pickZipFile?.();
    if (picked?.path) await handleConnectorImport(picked.path, "zip");
  };

  const pickConnectorFolder = async (): Promise<void> => {
    const picked = await window.api?.pickLocalFolder?.();
    if (picked?.path) await handleConnectorImport(picked.path, "folder");
  };

  const handleConnectorDrop = async (event: React.DragEvent): Promise<void> => {
    event.preventDefault();
    setDragOver(false);
    const file = Array.from(event.dataTransfer.files ?? [])[0];
    if (!file) return;
    const path = window.api?.getPathForFile?.(file) ?? (file as unknown as { path?: string }).path ?? "";
    if (!path) {
      setConnToast({ kind: "err", text: "无法读取拖入路径，请使用导入按钮" });
      return;
    }
    await handleConnectorImport(path, path.toLowerCase().endsWith(".zip") ? "zip" : "folder");
  };

  return (
    <div
      className={`hub-tab-body${dragOver ? " expert-drop-active" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
      onDragLeave={(event) => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setDragOver(false); }}
      onDrop={(event) => void handleConnectorDrop(event)}
    >
      <HubToast toast={connToast} />
      <HubImportBar
        onImportZip={() => void pickConnectorZip()}
        onImportFolder={() => void pickConnectorFolder()}
        busyId={busyId}
        hint="支持 MyBuddy 连接器 ZIP 或目录；导入后自动安装 Private Skills"
        rightAction={<HubBulkExpandButton command={bulkExpansion.command} onToggle={bulkExpansion.toggle} />}
      />
      <HubDropOverlay visible={dragOver} text="松开以导入连接器 ZIP / 文件夹" />
      <HubToolbar
        left={
          <HubFilterPills
            pills={[
              { id: "installed", label: "已安装", count: installedConnectors.length },
              { id: "market", label: "市场", count: marketConnectors.length },
            ]}
            activeId={subTab}
            onChange={(id) => setSubTab(id as "installed" | "market")}
          />
        }
      />
      {subTab === "market" && (
        <div className="hub-section-note">
          连接器 = 外部服务 CLI 通道。「卸载」退回市场可再装；市场里的「删除」才永久移除该连接器。
          CLI 本体请按卡片命令自行安装后再启用配套技能。
        </div>
      )}
      {subTab === "installed" && (
        <div className="hub-section-note">
          已安装列表：「卸载」只移除本地注册与配套技能，市场条目仍在可再安装。
        </div>
      )}
      <div className="skill-toolbar">
        <div className="skill-toolbar-titles">
          <span className="skill-toolbar-title">连接器市场</span>
          <span className="mcp-count">{connectors.length}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn" onClick={() => void refreshConnectors()}>
            刷新
          </button>
        </div>
      </div>
      {visibleConnectors.length === 0 ? (
        <HubEmpty
          icon="🔌"
          title={subTab === "installed" ? "暂无已安装连接器" : "暂无可用连接器"}
          description={subTab === "installed" ? "到「市场」标签选择连接器安装" : "本地市场（mybuddyskills-main/connectors）未发现连接器"}
        />
      ) : (
        <HubGrid density="compact">
          {visibleConnectors.map((connector) => (
            <HubCard
              key={connector.id}
              expansionCommand={bulkExpansion.command}
              icon={
                connector.iconPath ? (
                  <img src={`file://${connector.iconPath.replace(/\\/g, "/")}`} className="connector-icon" alt="" style={{ width: 22, height: 22, borderRadius: 6, objectFit: "cover" }} />
                ) : (
                  <span>🔌</span>
                )
              }
              title={connector.name}
              meta={
                <>
                  {connector.type ? `${connector.type} 通道` : "CLI 通道"}
                  {connector.version ? ` · v${connector.version}` : ""}
                  {connector.skillCount > 0 ? ` · ${connector.skillCount} 个技能` : ""}
                </>
              }
              description={`${connector.description || "（无描述）"} · ${connector.installed ? "技能已安装；CLI/登录未验证" : "安装仅添加配套技能，不验证 CLI/登录"}${connector.requiresAuth ? "；使用服务需登录" : ""}`}
              tags={[]}
              density="compact"
              highlight={!!connector.installed}
              status={<HubStatusBadge label={connector.installed ? (connector.enabled !== false ? "技能已启用" : "技能已停用") : "未安装"} tone={connector.installed ? (connector.enabled !== false ? "positive" : "neutral") : "neutral"} />}
              footer={
                connector.installed ? (
                  <HubActionsMenu
                    primary={
                      <button
                        type="button"
                        className="btn"
                        disabled={busyId === `en-${connector.id}`}
                        onClick={() =>
                          void (async () => {
                            setBusyId(`en-${connector.id}`);
                            try {
                              await setConnectorEnabled(connector.id, connector.enabled !== false ? false : true);
                              setConnToast({
                                kind: "ok",
                                text: connector.enabled !== false ? `已停用「${connector.name}」：配套技能不再进入会话` : `已启用「${connector.name}」配套技能；CLI/登录未验证`,
                              });
                            } catch (err) {
                              setConnToast({ kind: "err", text: `操作失败：${err instanceof Error ? err.message : String(err)}` });
                            } finally {
                              setBusyId(null);
                            }
                          })()
                        }
                        title={connector.enabled !== false ? "停用：私有技能不再进入候选装配" : "启用：可引用到任务"}
                      >
                        {busyId === `en-${connector.id}` ? "处理中…" : connector.enabled !== false ? "停用" : "启用"}
                      </button>
                    }
                    actions={
                      subTab === "installed"
                        ? [
                            {
                              label: busyId === connector.id ? "卸载中…" : "卸载",
                              danger: true,
                              onClick: () =>
                                void (async () => {
                                  setBusyId(connector.id);
                                  try {
                                    await uninstallConnector(connector.id);
                                    setConnToast({ kind: "ok", text: `已卸载「${connector.name}」，已退回市场` });
                                  } catch (err) {
                                    setConnToast({ kind: "err", text: `卸载失败：${err instanceof Error ? err.message : String(err)}` });
                                  } finally {
                                    setBusyId(null);
                                  }
                                })(),
                            },
                          ]
                        : [
                            { label: busyId === `un-${connector.id}` ? "卸载中…" : "卸载", onClick: () => void (async () => { setBusyId(`un-${connector.id}`); try { await uninstallConnector(connector.id); setConnToast({ kind: "ok", text: `已卸载「${connector.name}」，已退回市场` }); } catch (err) { setConnToast({ kind: "err", text: `卸载失败：${err instanceof Error ? err.message : String(err)}` }); } finally { setBusyId(null); } })() },
                            { label: busyId === `mkt-${connector.id}` ? "删除中…" : "永久删除", danger: true, dividerBefore: true, onClick: () => void (async () => { setBusyId(`mkt-${connector.id}`); try { await deleteMarketConnector(connector.id); setConnToast({ kind: "ok", text: `已从市场删除「${connector.name}」` }); } catch (err) { setConnToast({ kind: "err", text: `删除失败：${err instanceof Error ? err.message : String(err)}` }); } finally { setBusyId(null); } })() },
                          ]
                    }
                  />
                ) : (
                  <HubActionsMenu
                    primary={
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busyId === connector.id || connector.skillCount === 0}
                        title={connector.skillCount === 0 ? "该连接器无配套技能" : "安装配套技能并注册连接器"}
                        onClick={() => {
                          setBusyId(connector.id);
                          void installConnector(connector.id)
                            .then((names) => {
                              setConnToast({ kind: "ok", text: `已安装「${connector.name}」配套技能 ${names.length} 个；CLI/登录未验证` });
                              setBusyId(null);
                            })
                            .catch((err) => {
                              setConnToast({ kind: "err", text: `安装失败：${err instanceof Error ? err.message : String(err)}` });
                              setBusyId(null);
                            });
                        }}
                      >
                        {busyId === connector.id ? "安装中…" : "安装"}
                      </button>
                    }
                    actions={[{ label: busyId === `mkt-${connector.id}` ? "删除中…" : "永久删除", danger: true, onClick: () => void (async () => { setBusyId(`mkt-${connector.id}`); try { await deleteMarketConnector(connector.id); setConnToast({ kind: "ok", text: `已从市场删除「${connector.name}」` }); } catch (err) { setConnToast({ kind: "err", text: `删除失败：${err instanceof Error ? err.message : String(err)}` }); } finally { setBusyId(null); } })() }]}
                  />
                )
              }
            >
              {connector.examples?.length ? (
                <div className="expert-examples" style={{ marginTop: 6 }}>
                  {connector.examples.slice(0, 2).map((ex) => (
                    <div key={ex} className="expert-example" title={ex}>
                      💬 {ex}
                    </div>
                  ))}
                </div>
              ) : null}
              {connector.initCommand && (
                <div className="connector-init" style={{ marginTop: 6 }}>
                  <code>{connector.initCommand}</code>
                  <button type="button" className="btn" style={{ fontSize: 11, padding: "2px 6px" }} onClick={() => void copyCommand(connector)}>
                    {copiedId === connector.id ? "已复制" : "复制"}
                  </button>
                </div>
              )}
              {connector.installed && (connector.installedSkillNames?.length ?? 0) > 0 ? (
                <div className="expert-private-skills" style={{ marginTop: 6 }}>
                  <div className="expert-private-skills-title">
                    配套技能 <span className="hub-subtab-count">{connector.installedSkillNames.length}</span>
                  </div>
                  <div className="expert-skill-tags">
                    {connector.installedSkillNames.slice(0, 6).map((n) => (
                      <span key={n} className="expert-skill-tag" title={`连接器 ${connector.id} 私有技能`}>
                        {n}
                      </span>
                    ))}
                    {connector.installedSkillNames.length > 6 && (
                      <span className="expert-skill-tag expert-skill-tag--more">+{connector.installedSkillNames.length - 6}</span>
                    )}
                  </div>
                </div>
              ) : null}
            </HubCard>
          ))}
        </HubGrid>
      )}
    </div>
  );
}

interface Props {
  tab: HubTab;
}

export default function HubPage({ tab }: Props): React.JSX.Element {
  const setPage = useAppStore((s) => s.setPage);
  const [query, setQuery] = useState("");
  const [storage, setStorage] = useState<PluginStoragePathsDto | null>(null);
  const [directoryError, setDirectoryError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void window.api?.plugins?.paths().then(paths => { if (!cancelled) setStorage(paths); }).catch(error => { if (!cancelled) setDirectoryError(String(error)); });
    return () => { cancelled = true; };
  }, []);
  const openPluginDirectory = async (): Promise<void> => {
    try {
      if (!window.api) throw new Error("插件目录接口尚未就绪");
      const result = await window.api.plugins.openDirectory();
      setDirectoryError(result.ok ? "" : result.error ?? "无法打开插件目录");
    } catch (error) { setDirectoryError(String(error)); }
  };

  return (
    <div className="content-col hub-page">
      <div className="hub-page-chrome">
        <HubHeader title={TAB_LABEL[tab]} />
        <HubToolbar
          left={
            <HubFilterPills
              pills={HUB_TABS.map((t) => ({ id: t, label: TAB_LABEL[t] }))}
              activeId={tab}
              onChange={(id) => setPage(id as Page)}
            />
          }
          right={<HubSearch value={query} onChange={setQuery} placeholder={`搜索${TAB_LABEL[tab]}或描述`} />}
        />
        <div className="plugin-directory-bar">
          <span>插件目录</span><code title={storage?.root}>{storage?.root ?? "读取中…"}</code>
          <button className="btn" type="button" disabled={!storage} onClick={() => void openPluginDirectory()}>打开插件目录</button>
        </div>
        {directoryError && <div className="mcp-config-error" role="alert">{directoryError}</div>}
      </div>

      <div className="page-scroll">
        <div className="page-container hub-page-container">
          {tab === "experts" && <ExpertsTab query={query} />}
          {tab === "skills" && <SkillsTab query={query} />}
          {tab === "mcp" && <McpTab query={query} />}
          {tab === "connectors" && <ConnectorsTab query={query} />}
        </div>
      </div>
    </div>
  );
}
