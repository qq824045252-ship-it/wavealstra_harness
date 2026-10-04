import { useCallback, useEffect, useState } from "react";
import type { BlueprintDescriptor, ResolvedBlueprint } from "@shared/blueprint-types";
import type { TemplateCapabilityRegistries } from "@shared/project-template";
import { buildCapabilityRegistries } from "@/lib/projectCreate";
import { blueprintSummaryParts } from "@/lib/blueprintUi";
import { useTextPrompt } from "@/components/common/useTextPrompt";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { useAppStore } from "@/store/appStore";

function blueprintApi(): NonNullable<typeof window.api>["blueprint"] {
  const api = window.api?.blueprint;
  if (!api) throw new Error("Blueprint 能力尚未加载，请重启 MyBuddy");
  return api;
}

export default function BlueprintLibrary({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const [items, setItems] = useState<BlueprintDescriptor[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BlueprintDescriptor | null>(null);
  const [registries, setRegistries] = useState<TemplateCapabilityRegistries | undefined>();
  const [resolvedById, setResolvedById] = useState<Record<string, ResolvedBlueprint>>({});
  const { requestText, textPromptDialog } = useTextPrompt();

  const reload = useCallback(async () => setItems(await blueprintApi().list()), []);
  useEffect(() => { void reload().catch((error) => setMessage(String(error))); }, [reload]);
  useEffect(() => {
    const api = window.api?.blueprint;
    if (!api) return;
    return api.onChanged(() => { void reload().catch((error) => setMessage(String(error))); });
  }, [reload]);
  useEffect(() => {
    const store = useAppStore.getState();
    const api = window.api;
    if (!api) { setMessage("MyBuddy API 尚未加载，请重启应用"); return; }
    void Promise.allSettled([
      api.mcp.listServers(),
      store.refreshExperts(),
      store.refreshSkills(),
      store.refreshConnectors(),
    ]).then(([serversResult, ...refreshResults]) => {
      const servers = serversResult.status === "fulfilled" ? serversResult.value : [];
      const latest = useAppStore.getState();
      setRegistries(buildCapabilityRegistries({
        experts: latest.experts,
        skills: latest.skills,
        connectors: latest.connectors,
        mcps: servers.map((server) => ({ id: server.name, installed: server.installed, disabled: server.disabled })),
      }));
      const failures = [serversResult, ...refreshResults].filter((result) => result.status === "rejected");
      if (failures.length) setMessage("部分能力清单加载失败；相关能力会保守显示为缺失");
    });
  }, []);
  useEffect(() => {
    if (!registries || items.length === 0) { setResolvedById({}); return; }
    let cancelled = false;
    void Promise.all(items.map(async (item) => [item.id, await blueprintApi().resolve(item.id, registries)] as const))
      .then((entries) => { if (!cancelled) setResolvedById(Object.fromEntries(entries)); })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [items, registries]);

  const instantiate = async (item: BlueprintDescriptor): Promise<void> => {
    if (!registries) { setMessage("能力清单仍在加载，请稍候"); return; }
    const rootName = item.kind === "gadget" ? undefined : await requestText({
      title: "从 Blueprint 新建",
      label: "新工作空间名称",
      initialValue: item.name,
      maxLength: 120,
      confirmLabel: "新建",
    });
    if (item.kind !== "gadget" && !rootName?.trim()) return;
    try {
      setBusy(item.id);
      const result = await blueprintApi().instantiate({
        blueprintId: item.id,
        ...(rootName ? { rootName: rootName.trim() } : {}),
        ...(item.kind === "gadget" ? { gadgetScope: { type: "global" as const } } : {}),
        registries,
      });
      setMessage(`实例化完成：${Object.keys(result.workspaceIdsByKey).length} 个空间、${Object.keys(result.taskIdsByKey).length} 个任务、${Object.keys(result.gadgetIdsByKey).length} 个 Gadget${result.warnings.length ? `；${result.warnings.join("；")}` : ""}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (item: BlueprintDescriptor): Promise<void> => {
    try {
      setBusy(item.id);
      await blueprintApi().delete(item.id);
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const rename = async (item: BlueprintDescriptor): Promise<void> => {
    const name = await requestText({
      title: "重命名 Blueprint",
      label: "Blueprint 名称",
      initialValue: item.name,
      maxLength: 120,
      confirmLabel: "保存",
    });
    if (!name?.trim()) return;
    try {
      setBusy(item.id);
      await blueprintApi().update({ blueprintId: item.id, name: name.trim() });
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`blueprint-library${compact ? " blueprint-library--compact" : ""}`}>
      <div className="gadget-section-head"><div><h2>Blueprints</h2>{!compact && <p>可重复实例化的工作结构、配置和方法。</p>}</div></div>
      {message && <div className="blueprint-message">{message}<button type="button" onClick={() => setMessage(null)}>×</button></div>}
      {items.length === 0 ? <div className="gadget-empty">还没有 Blueprint。可从 Workspace 或 Gadget 保存。</div> : (
        <div className="blueprint-list">
          {items.map((item) => (
            <article key={item.id} className="blueprint-card">
              <div className="blueprint-card-main">
                <div><strong>{item.name}</strong><span className="blueprint-kind">{item.kind}</span></div>
                {item.description && <p>{item.description}</p>}
                <div className="blueprint-summary">包含：{blueprintSummaryParts(item.definition).join(" · ") || "可重复使用的工作方法"}</div>
                {resolvedById[item.id]?.warnings.length ? (
                  <div className="blueprint-warnings">{resolvedById[item.id].warnings.map((warning) => <div key={warning}>⚠ {warning}</div>)}</div>
                ) : null}
              </div>
              <div className="gadget-card-actions">
                <button className="btn btn--primary" disabled={busy === item.id || !registries} onClick={() => void instantiate(item)}>New from Blueprint</button>
                <button className="btn btn--ghost" disabled={busy === item.id} onClick={() => void rename(item)}>重命名</button>
                <button className="btn btn--ghost gadget-danger" disabled={busy === item.id} onClick={() => setPendingDelete(item)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除 Blueprint「${pendingDelete?.name ?? ""}」？`}
        body="删除后该 Blueprint 不可恢复；已实例化资源不会被删除。"
        confirmLabel="删除"
        danger
        onCancel={() => !busy && setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void remove(target);
        }}
      />
      {textPromptDialog}
    </section>
  );
}
