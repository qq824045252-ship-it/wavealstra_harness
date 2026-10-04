import { useEffect, useMemo, useState } from "react";
import type { BlueprintDescriptor, ResolvedBlueprint } from "@shared/blueprint-types";
import type { TemplateCapabilityRegistries } from "@shared/project-template";
import { blueprintSummaryParts } from "@/lib/blueprintUi";
import { buildCapabilityRegistries } from "@/lib/projectCreate";
import { useAppStore } from "@/store/appStore";

type Choice = "folder" | "blank" | string;
type PickedFolder = { path: string; name: string };

export default function CreateWorkspaceDialog({ open, onClose, parentId = null, parentName }: { open: boolean; onClose: () => void; parentId?: string | null; parentName?: string }): React.JSX.Element | null {
  const [name, setName] = useState("");
  const [choice, setChoice] = useState<Choice>("folder");
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [blueprints, setBlueprints] = useState<BlueprintDescriptor[]>([]);
  const [resolved, setResolved] = useState<Record<string, ResolvedBlueprint>>({});
  const [registries, setRegistries] = useState<TemplateCapabilityRegistries>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setChoice("folder");
    setFolder(null);
    setError(null);
    setBusy(false);
    const api = window.api;
    if (!api?.blueprint) return;
    const store = useAppStore.getState();
    void Promise.all([
      api.blueprint.list(),
      Promise.allSettled([api.mcp.listServers(), store.refreshExperts(), store.refreshSkills(), store.refreshConnectors()]),
    ]).then(async ([items, capabilityResults]) => {
      const workspaceItems = items.filter((item) => item.kind !== "gadget");
      setBlueprints(workspaceItems);
      const serverResult = capabilityResults[0];
      const servers = serverResult.status === "fulfilled" ? serverResult.value : [];
      const latest = useAppStore.getState();
      const nextRegistries = buildCapabilityRegistries({
        experts: latest.experts,
        skills: latest.skills,
        connectors: latest.connectors,
        mcps: servers.map((server) => ({ id: server.name, installed: server.installed, disabled: server.disabled })),
      });
      setRegistries(nextRegistries);
      const entries = await Promise.all(workspaceItems.map(async (item) => [item.id, await api.blueprint.resolve(item.id, nextRegistries)] as const));
      setResolved(Object.fromEntries(entries));
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [open]);

  const selected = useMemo(() => blueprints.find((item) => item.id === choice), [blueprints, choice]);

  const pickFolder = async (): Promise<void> => {
    setError(null);
    const picked = await window.api?.pickLocalFolder?.();
    if (!picked) return;
    setFolder(picked);
    setChoice("folder");
    if (!name.trim()) setName(picked.name);
  };

  const create = async (): Promise<void> => {
    const trimmed = name.trim();
    setBusy(true);
    setError(null);
    try {
      const store = useAppStore.getState();
      if (choice === "folder") {
        if (!folder) throw new Error("请先选择一个本地文件夹");
        const effectiveName = trimmed || folder.name;
        const id = await store.addSpaceFromPath(folder.path, effectiveName, parentId);
        store.openWorkspaceDetail(id);
      } else if (choice === "blank") {
        if (!trimmed) throw new Error("请输入工作空间名称");
        const id = await store.addSpace(parentId, trimmed);
        if (!id) throw new Error("创建工作空间失败");
        store.openWorkspaceDetail(id);
      } else {
        if (!trimmed) throw new Error("请输入工作空间名称");
        const result = await window.api!.blueprint.instantiate({ blueprintId: choice, rootName: trimmed, registries });
        await store.refreshSpaces();
        const rootId = Object.values(result.workspaceIdsByKey)[0];
        if (rootId) store.openWorkspaceDetail(rootId);
      }
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <div className="workspace-create-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="workspace-create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-workspace-title">
        <header>
          <div>
            <h2 id="create-workspace-title">{parentId ? "新建子工作空间" : "新建工作空间"}</h2>
            <p>{parentId ? `添加到「${parentName ?? "当前工作空间"}」：选择本地文件夹，或创建纯逻辑子空间。` : "直接选择本地文件夹，或创建一个纯逻辑工作空间。"}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </header>

        <div className="workspace-create-options workspace-create-primary-options">
          <label className={`workspace-create-option ${choice === "folder" ? "selected" : ""}`}>
            <input type="radio" checked={choice === "folder"} onChange={() => setChoice("folder")} />
            <span><strong>使用本地文件夹</strong><small>选择文件夹后直接创建并绑定，不需要二次设置。</small></span>
          </label>
          {choice === "folder" && (
            <div className="workspace-create-folder-row">
              <div className="workspace-create-folder-value" title={folder?.path ?? ""}>
                <strong>{folder ? folder.name : "尚未选择文件夹"}</strong>
                <span>{folder?.path ?? "选择现有项目或资料目录作为工作空间根目录"}</span>
              </div>
              <button type="button" className="btn btn--primary" onClick={() => void pickFolder()} disabled={busy}>
                {folder ? "重新选择" : "选择文件夹"}
              </button>
            </div>
          )}

          <label className={`workspace-create-option ${choice === "blank" ? "selected" : ""}`}>
            <input type="radio" checked={choice === "blank"} onChange={() => setChoice("blank")} />
            <span><strong>空白工作空间</strong><small>仅创建 MyBuddy 内部空间，暂不绑定本地目录。</small></span>
          </label>
        </div>

        <label className="workspace-create-name">
          名称
          <input
            value={name}
            onChange={(event) => { setName(event.target.value); setError(null); }}
            placeholder={choice === "folder" ? "默认使用所选文件夹名称，可修改" : "工作空间名称"}
          />
        </label>

        {parentId == null && blueprints.length > 0 && (
          <div className="workspace-create-options workspace-create-blueprints">
            <div className="workspace-create-subtitle">从 Blueprint 创建</div>
            {blueprints.map((item) => (
              <label key={item.id} className={`workspace-create-option ${choice === item.id ? "selected" : ""}`}>
                <input type="radio" checked={choice === item.id} onChange={() => { setChoice(item.id); if (!name.trim()) setName(item.name); }} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description || blueprintSummaryParts(item.definition).join(" · ") || "可复用的工作空间结构"}</small>
                  {resolved[item.id]?.warnings.map((warning) => <em key={warning}>⚠ {warning}</em>)}
                </span>
              </label>
            ))}
          </div>
        )}

        {parentId == null && selected && <div className="workspace-create-preview">包含：{blueprintSummaryParts(selected.definition).join(" · ") || "可复用的工作空间结构"}。运行状态、历史记录和凭证不会复制。</div>}
        {error && <div className="workspace-create-error">{error}</div>}
        <footer>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn btn--primary" onClick={() => void create()} disabled={busy || (choice === "folder" && !folder)}>
            {busy ? "创建中…" : choice === "folder" ? "创建并绑定" : "创建工作空间"}
          </button>
        </footer>
      </section>
    </div>
  );
}
