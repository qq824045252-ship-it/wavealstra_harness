import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import MemoryKernelExplorer from "./MemoryKernelExplorer";
import MemorySkillPanel from "./MemorySkillPanel";
import "./Memory.css";
import type {
  MemoryGatewayAccessGrantDto,
  MemoryGatewayAccessMode,
  MemoryGatewayGrantScopeType,
  MemoryGatewayStatusDto,
} from "@shared/memory-gateway";

const MEMORY_SUBTABS = [
  { id: "browse", label: "记忆" },
  { id: "skills", label: "技能学习" },
  { id: "settings", label: "设置" },
  { id: "access", label: "外部访问" },
] as const;

type MemorySubTab = (typeof MEMORY_SUBTABS)[number]["id"];

const GRANT_SCOPE_LABEL: Record<MemoryGatewayGrantScopeType, string> = {
  all: "全部上下文",
  global: "仅全局",
  project: "项目",
  workspace: "工作空间",
  task: "任务",
};

function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? "on" : ""}`}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!on);
      }}
    />
  );
}

function Row({
  label,
  desc,
  children,
}: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">{label}</div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function isCliAutoGrant(grant: MemoryGatewayAccessGrantDto): boolean {
  // CLI grants are always bound to a concrete workspace/task; a manual grant named alike but
  // scoped all/global/project stays in the manual list.
  return grant.name.startsWith("MyBuddy CLI Memory")
    && (grant.scopeType === "workspace" || grant.scopeType === "task")
    && Boolean(grant.scopeId);
}

export default function MemoryTab(): React.JSX.Element {
  const spaces = useAppStore((s) => s.spaces);
  const projects = useAppStore((s) => s.projects);
  const tasks = useAppStore((s) => s.tasks);
  const [subTab, setSubTab] = useState<MemorySubTab>("browse");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [focusMemoryId, setFocusMemoryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const settingsReadVersion = useRef(0);
  const settingsSaving = useRef(false);
  const [status, setStatus] = useState("");
  const [confirmRevokeCli, setConfirmRevokeCli] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<MemoryGatewayStatusDto | null>(null);
  const [gatewayGrants, setGatewayGrants] = useState<MemoryGatewayAccessGrantDto[]>([]);
  const [gatewayPortDraft, setGatewayPortDraft] = useState("3351");
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const [grantName, setGrantName] = useState("");
  const [grantMode, setGrantMode] = useState<MemoryGatewayAccessMode>("read");
  const [grantScopeType, setGrantScopeType] = useState<MemoryGatewayGrantScopeType>("all");
  const [grantScopeId, setGrantScopeId] = useState("");
  const [issuedSecret, setIssuedSecret] = useState<{ name: string; token: string } | null>(null);

  const visibleSpaces = useMemo(
    () => spaces.filter((space) => !Boolean((space as { effectiveArchived?: boolean }).effectiveArchived ?? space.archived)),
    [spaces],
  );
  const cliGrants = useMemo(() => gatewayGrants.filter(isCliAutoGrant), [gatewayGrants]);
  const manualGrants = useMemo(() => gatewayGrants.filter((grant) => !isCliAutoGrant(grant)), [gatewayGrants]);

  const loadExternalAccess = useCallback(async (): Promise<void> => {
    const [nextStatus, grants] = await Promise.all([
      window.api?.memoryGateway?.status?.(),
      window.api?.memoryGateway?.listGrants?.(),
    ]);
    if (nextStatus) {
      setGatewayStatus(nextStatus);
      setGatewayPortDraft(String(nextStatus.port));
    }
    setGatewayGrants(grants ?? []);
  }, []);

  useEffect(() => {
    if (settingsSaving.current) return;
    const request = ++settingsReadVersion.current;
    let cancelled = false;
    void window.api?.agent?.getAppSettings?.().then((settings) => {
      if (settings && !cancelled && request === settingsReadVersion.current) setEnabled(settings.memoryEnabled !== false);
    }).catch((error) => { if (!cancelled && request === settingsReadVersion.current) setStatus(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [subTab]);

  // Gateway 状态可能在设置页打开期间被环境/其他入口改变，回到外部访问页时重拉一次。
  useEffect(() => {
    if (subTab === "access") void loadExternalAccess().catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, [subTab, loadExternalAccess]);

  const persistEnabled = async (v: boolean): Promise<void> => {
    if (settingsSaving.current || enabled === null) return;
    settingsSaving.current = true;
    settingsReadVersion.current += 1;
    const previous = enabled;
    setEnabled(v);
    setBusy(true);
    try {
      await window.api?.agent?.updateAppSettings?.({ memoryEnabled: v });
      setStatus(v ? "记忆已开启：新对话会自动提取并加载记忆" : "记忆已关闭：不会提取或加载，已有内容仍保留");
    } catch (error) {
      setEnabled(previous);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      settingsSaving.current = false;
      setBusy(false);
    }
  };

  const configureGateway = async (patch: { enabled?: boolean; writeEnabled?: boolean; port?: number }): Promise<void> => {
    setGatewayBusy(true);
    try {
      const next = await window.api?.memoryGateway?.configure?.(patch);
      if (next) {
        setGatewayStatus(next);
        setGatewayPortDraft(String(next.port));
      }
      setStatus("外部 Agent Memory 访问设置已更新");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      await loadExternalAccess();
    } finally {
      setGatewayBusy(false);
    }
  };

  const grantScopeChoices = useMemo(() => {
    if (grantScopeType === "project") return projects.map((item) => ({ id: item.id, label: item.name }));
    if (grantScopeType === "workspace") return visibleSpaces.map((item) => ({ id: item.id, label: item.name }));
    if (grantScopeType === "task") return tasks.map((item) => ({ id: item.id, label: item.title }));
    return [] as Array<{ id: string; label: string }>;
  }, [grantScopeType, projects, tasks, visibleSpaces]);

  useEffect(() => {
    if (grantScopeType === "all" || grantScopeType === "global") { setGrantScopeId(""); return; }
    if (!grantScopeChoices.some((item) => item.id === grantScopeId)) setGrantScopeId(grantScopeChoices[0]?.id ?? "");
  }, [grantScopeChoices, grantScopeId, grantScopeType]);

  const createGatewayGrant = async (): Promise<void> => {
    if (!grantName.trim()) return;
    setGatewayBusy(true);
    try {
      const issued = await window.api?.memoryGateway?.createGrant?.({
        name: grantName.trim(),
        mode: grantMode,
        scopeType: grantScopeType,
        scopeId: grantScopeType === "all" || grantScopeType === "global" ? undefined : grantScopeId,
      });
      if (issued) {
        setIssuedSecret({ name: issued.grant.name, token: issued.token });
        setGrantName("");
        await loadExternalAccess();
        setStatus("授权已创建。Token 只显示这一次，请立即复制保存。");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setGatewayBusy(false);
    }
  };

  const rotateGatewayGrant = async (grant: MemoryGatewayAccessGrantDto): Promise<void> => {
    setGatewayBusy(true);
    try {
      const issued = await window.api?.memoryGateway?.rotateGrant?.(grant.id);
      if (issued) {
        setIssuedSecret({ name: issued.grant.name, token: issued.token });
        await loadExternalAccess();
        setStatus("Token 已轮换，旧 Token 已立即失效。新 Token 只显示这一次。");
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setGatewayBusy(false); }
  };

  const toggleGatewayGrant = async (grant: MemoryGatewayAccessGrantDto): Promise<void> => {
    setGatewayBusy(true);
    try {
      await window.api?.memoryGateway?.updateGrant?.({ id: grant.id, enabled: !grant.enabled });
      await loadExternalAccess();
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setGatewayBusy(false); }
  };

  const deleteGatewayGrant = async (grant: MemoryGatewayAccessGrantDto): Promise<void> => {
    setGatewayBusy(true);
    try {
      await window.api?.memoryGateway?.deleteGrant?.(grant.id);
      await loadExternalAccess();
      setStatus(`已撤销 ${grant.name} 的外部 Memory 访问`);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setGatewayBusy(false); }
  };

  const revokeCliGrants = async (): Promise<void> => {
    setGatewayBusy(true);
    try {
      for (const grant of cliGrants) {
        await window.api?.memoryGateway?.deleteGrant?.(grant.id);
      }
      await loadExternalAccess();
      setStatus(`已撤销 ${cliGrants.length} 个 CLI 自动授权`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setConfirmRevokeCli(false);
      setGatewayBusy(false);
    }
  };

  const copyText = async (text: string, message: string): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setStatus(message); }
    catch { setStatus("复制失败，请手动复制"); }
  };

  const grantScopeText = (grant: MemoryGatewayAccessGrantDto): string => {
    const typeLabel = GRANT_SCOPE_LABEL[grant.scopeType] ?? grant.scopeType;
    if (!grant.scopeId) return typeLabel;
    if (grant.scopeType === "project") return `${typeLabel} · ${projects.find((item) => item.id === grant.scopeId)?.name ?? grant.scopeId}`;
    if (grant.scopeType === "workspace") return `${typeLabel} · ${spaces.find((item) => item.id === grant.scopeId)?.name ?? grant.scopeId}`;
    if (grant.scopeType === "task") return `${typeLabel} · ${tasks.find((item) => item.id === grant.scopeId)?.title ?? grant.scopeId}`;
    return `${typeLabel} · ${grant.scopeId}`;
  };

  const renderGrantCard = (grant: MemoryGatewayAccessGrantDto): React.JSX.Element => (
    <div key={grant.id} className="memory-note-card">
      <div className="memory-note-content">
        <strong>{grant.name}</strong>
        <div className="settings-row-desc">{grant.mode === "read-write" ? "读写" : "只读"} · {grantScopeText(grant)}</div>
      </div>
      <div className="memory-note-footer">
        <span className="settings-row-desc">{grant.enabled ? "已启用" : "已停用"}</span>
        <div className="memory-note-actions">
          <button type="button" className="btn" disabled={gatewayBusy} onClick={() => void toggleGatewayGrant(grant)}>{grant.enabled ? "停用" : "启用"}</button>
          <button type="button" className="btn" disabled={gatewayBusy} onClick={() => void rotateGatewayGrant(grant)}>轮换 Token</button>
          <button type="button" className="btn danger" disabled={gatewayBusy} onClick={() => void deleteGatewayGrant(grant)}>撤销</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="memory-tab">
      <div className="ext-subnav" role="tablist" aria-label="记忆子页">
        {MEMORY_SUBTABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={subTab === tab.id}
            className={`ext-subnav-btn ${subTab === tab.id ? "active" : ""}`}
            onClick={() => {
              setSubTab(tab.id);
              if (tab.id === "browse") setFocusMemoryId(null);
              setStatus("");
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {status && subTab !== "browse" && subTab !== "skills" ? <div className="memory-status" role="status">{status}</div> : null}

      {subTab === "browse" && <MemoryKernelExplorer focusMemoryId={focusMemoryId} />}

      {subTab === "skills" && <MemorySkillPanel onOpenMemory={(id) => { setFocusMemoryId(id); setSubTab("browse"); }} />}

      {subTab === "settings" && (
        <div className="memory-tab-scroll">
          <div className="settings-row-desc" style={{ marginBottom: 12 }}>
            MyBuddy 可从对话中记住稳定偏好和约定，并在后续回答中使用。相关内容会发送给你选择的模型；开启外部访问后，获得授权的应用也可在授权范围内读取。
          </div>
          <Row
            label="使用记忆"
            desc="每轮成功结束后在后台提炼，并在后续对话中使用相关记忆。关闭后停止提炼和加载，已有记录仍可查看。"
          >
            <Toggle label="使用记忆" on={enabled === true} disabled={busy || enabled === null} onChange={(value) => void persistEnabled(value)} />
          </Row>
          {enabled === false && (
            <div className="memory-disabled-notice">记忆当前已停用。已有记录不会删除，你仍可在「记忆」页查看和整理。</div>
          )}

          <div className="memory-panel">
            <div className="memory-panel-head">
              <div>
                <div className="settings-section-title">记忆管理</div>
                <div className="settings-row-desc">
                  在「记忆」页查看、编辑或删除各个范围的记忆。删除条目不可撤销；原始对话、技能文件和审核快照仍保留，失效的派生内容不会用于记忆上下文。
                </div>
              </div>
            </div>
            <button type="button" className="btn" onClick={() => { setFocusMemoryId(null); setSubTab("browse"); }}>管理记忆</button>
          </div>
        </div>
      )}

      {subTab === "access" && (
        <div className="memory-tab-scroll">
        <div className="memory-panel" style={{ marginTop: 0 }}>
          <div className="memory-panel-head">
            <div>
              <div className="settings-section-title">外部 Agent Memory 访问</div>
              <div className="settings-row-desc">通过本机 MCP / HTTP 让外部 Agent 使用同一套 Memory Kernel。服务只监听 127.0.0.1；每个 Agent 使用独立授权 Token。</div>
            </div>
            <span className="memory-count">{gatewayStatus?.running ? "运行中" : "已停止"}</span>
          </div>
          <Row label="启用 Memory Gateway" desc={gatewayStatus?.environmentOverrides.enabled ? "当前由 MYBUDDY_MEMORY_GATEWAY_ENABLED 环境变量覆盖" : "默认关闭；启用后仍需要创建独立访问授权。"}>
            <Toggle label="启用外部记忆访问" on={gatewayStatus?.configuredEnabled === true} disabled={gatewayBusy || !gatewayStatus || gatewayStatus.environmentOverrides.enabled} onChange={(value) => void configureGateway({ enabled: value })} />
          </Row>
          <Row label="允许外部写入" desc={gatewayStatus?.environmentOverrides.writeEnabled ? "当前由 MYBUDDY_MEMORY_GATEWAY_WRITE 环境变量覆盖" : "这是总闸；同时还要求具体授权为“读写”。默认关闭。"}>
            <Toggle label="允许外部写入" on={gatewayStatus?.writeEnabled === true} disabled={gatewayBusy || !gatewayStatus || gatewayStatus.environmentOverrides.writeEnabled} onChange={(value) => void configureGateway({ writeEnabled: value })} />
          </Row>
          <div className="settings-row">
            <div className="settings-row-info"><div className="settings-row-label">监听端口</div><div className="settings-row-desc">固定绑定 127.0.0.1，端口范围 1024–65535；修改端口会安全切换，失败自动回滚。</div></div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input className="settings-input" style={{ width: 92 }} value={gatewayPortDraft} disabled={gatewayBusy || gatewayStatus?.environmentOverrides.port} onChange={(e) => setGatewayPortDraft(e.target.value.replace(/\D/g, "").slice(0, 5))} />
              <button type="button" className="btn" disabled={gatewayBusy || gatewayStatus?.environmentOverrides.port || Number(gatewayPortDraft) === gatewayStatus?.port || Number(gatewayPortDraft) < 1024 || Number(gatewayPortDraft) > 65535} onClick={() => void configureGateway({ port: Number(gatewayPortDraft) })}>应用</button>
            </div>
          </div>
          {gatewayStatus && (
            <div className="memory-digest-card" style={{ display: "grid", gap: 8 }}>
              <div className="settings-row-desc">MCP：<code>{gatewayStatus.mcpUrl}</code> <button type="button" className="btn" onClick={() => void copyText(gatewayStatus.mcpUrl, "MCP 地址已复制")}>复制</button></div>
              <div className="settings-row-desc">HTTP：<code>{gatewayStatus.httpBaseUrl}</code></div>
              {!gatewayStatus.memoryEnabled && <div className="memory-disabled-notice">MyBuddy 总记忆开关已关闭：Gateway 即使运行，也不会向任何外部 Agent 暴露 Memory 工具或内容。</div>}
            </div>
          )}

          <div className="memory-panel-head" style={{ marginTop: 14 }}>
            <div><div className="settings-section-title">访问授权</div><div className="settings-row-desc">Token 明文不落盘；创建或轮换后只显示一次。删除或停用授权会立即拒绝该 Token。</div></div>
            <span className="memory-count">{manualGrants.length} 个</span>
          </div>
          {gatewayStatus?.grantStoreError && (
            <div className="memory-disabled-notice">授权文件异常，Gateway 将拒绝启动：{gatewayStatus.grantStoreError}</div>
          )}
          <div className="memory-add-row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input className="settings-input" style={{ minWidth: 150 }} placeholder="名称，如 ChatGPT / ERP" value={grantName} onChange={(e) => setGrantName(e.target.value)} />
            <select className="settings-input" value={grantMode} onChange={(e) => setGrantMode(e.target.value as MemoryGatewayAccessMode)}><option value="read">只读</option><option value="read-write">读写</option></select>
            <select className="settings-input" value={grantScopeType} onChange={(e) => setGrantScopeType(e.target.value as MemoryGatewayGrantScopeType)}>
              <option value="all">全部上下文</option><option value="global">仅全局</option><option value="project">指定项目</option><option value="workspace">指定工作空间</option><option value="task">指定任务</option>
            </select>
            {grantScopeChoices.length > 0 && <select className="settings-input" value={grantScopeId} onChange={(e) => setGrantScopeId(e.target.value)}>{grantScopeChoices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}
            <button type="button" className="btn primary" disabled={gatewayBusy || !grantName.trim() || ((grantScopeType !== "all" && grantScopeType !== "global") && !grantScopeId)} onClick={() => void createGatewayGrant()}>创建授权</button>
          </div>
          {issuedSecret && gatewayStatus && (
            <div className="memory-disabled-notice" style={{ display: "grid", gap: 8 }}>
              <strong>{issuedSecret.name} · 新 Token（仅显示一次）</strong>
              <code style={{ wordBreak: "break-all", userSelect: "all" }}>{issuedSecret.token}</code>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn primary" onClick={() => void copyText(issuedSecret.token, "Token 已复制")}>复制 Token</button>
                <button type="button" className="btn" onClick={() => void copyText(JSON.stringify({ url: gatewayStatus.mcpUrl, headers: { Authorization: `Bearer ${issuedSecret.token}` } }, null, 2), "MCP 配置已复制")}>复制 MCP 配置</button>
                <button type="button" className="btn" onClick={() => setIssuedSecret(null)}>我已保存</button>
              </div>
            </div>
          )}
          <div className="memory-note-list">
            {manualGrants.map(renderGrantCard)}
            {manualGrants.length === 0 && <div className="memory-empty">暂无手动授权。Gateway 启用后也不会自动把 owner Token 暴露给外部 Agent。</div>}
          </div>

          {cliGrants.length > 0 ? (
            <details className="memory-cli-grants">
              <summary>
                CLI 自动授权 {cliGrants.length} 个
                <span className="settings-row-desc">工作空间终端会按需签发，一般不用手动管理。</span>
              </summary>
              <div className="memory-cli-grants-actions">
                <button type="button" className="btn danger" disabled={gatewayBusy} onClick={() => setConfirmRevokeCli(true)}>全部撤销</button>
              </div>
              <div className="memory-note-list">
                {cliGrants.map(renderGrantCard)}
              </div>
            </details>
          ) : null}
        </div>
        </div>
      )}


      <ConfirmDialog
        open={confirmRevokeCli}
        title={`撤销 ${cliGrants.length} 个 CLI 自动授权？`}
        body="撤销后，对应工作空间 / 任务里的外部 CLI 需要重新连接才会再次签发授权。"
        confirmLabel="全部撤销"
        danger
        onCancel={() => setConfirmRevokeCli(false)}
        onConfirm={() => void revokeCliGrants()}
      />
    </div>
  );
}
