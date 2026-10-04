import { useMemo, useState } from "react";
import type { BlueprintCaptureOptions, BlueprintDefinition, BlueprintDescriptor, WorkspaceBlueprintNode } from "@shared/blueprint-types";
import { blueprintSummaryParts } from "@/lib/blueprintUi";

interface Props {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  onSaved: (blueprint: BlueprintDescriptor) => void;
}

function workspacePreview(node: WorkspaceBlueprintNode, depth = 0): React.JSX.Element[] {
  return [
    <div key={node.key} className="blueprint-preview-row" style={{ paddingLeft: depth * 16 }}>
      <strong>{node.name}</strong>
      <span>{node.tasks?.length ? `${node.tasks.length} tasks` : ""}{node.gadgets?.length ? ` · ${node.gadgets.length} gadgets` : ""}</span>
    </div>,
    ...(node.children ?? []).flatMap((child) => workspacePreview(child, depth + 1)),
  ];
}

export default function BlueprintCaptureDialog({ workspaceId, workspaceName, onClose, onSaved }: Props): React.JSX.Element {
  const blueprint = window.api?.blueprint;
  const [name, setName] = useState(`${workspaceName} Blueprint`);
  const [description, setDescription] = useState("");
  const [includeChildren, setIncludeChildren] = useState(true);
  const [includeTasks, setIncludeTasks] = useState(true);
  const [includeGadgets, setIncludeGadgets] = useState(true);
  const [includeContext, setIncludeContext] = useState(false);
  const [selectedFilesText, setSelectedFilesText] = useState("");
  const [preview, setPreview] = useState<BlueprintDefinition | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo<BlueprintCaptureOptions>(() => ({
    name: name.trim(),
    description: description.trim() || undefined,
    includeChildren,
    includeTasks,
    includeGadgets,
    includeContext,
    selectedFiles: selectedFilesText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
  }), [name, description, includeChildren, includeTasks, includeGadgets, includeContext, selectedFilesText]);

  const invalidate = (change: () => void): void => {
    change();
    setPreview(null);
    setError(null);
  };

  const loadPreview = async (): Promise<void> => {
    if (!options.name) { setError("Blueprint 名称不能为空"); return; }
    if (!blueprint) { setError("Blueprint 能力尚未加载，请重启 MyBuddy"); return; }
    try {
      setBusy("preview");
      setPreview(await blueprint.previewCapture({ workspaceId, options }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    if (!preview) { setError("请先预览并确认提取后的结构定义"); return; }
    if (!blueprint) { setError("Blueprint 能力尚未加载，请重启 MyBuddy"); return; }
    try {
      setBusy("save");
      const saved = await blueprint.capture({ workspaceId, options, confirmedDefinition: preview });
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="blueprint-capture-overlay" role="dialog" aria-modal="true" aria-label="Create Blueprint">
      <div className="blueprint-capture-dialog">
        <header>
          <div><h2>Create Blueprint</h2><p>Capture a reusable method and structure, not a Workspace snapshot.</p></div>
          <button type="button" className="btn btn--ghost" disabled={busy !== null} onClick={onClose}>Close</button>
        </header>
        <div className="blueprint-capture-form">
          <label><span>Name</span><input value={name} onChange={(event) => invalidate(() => setName(event.target.value))} /></label>
          <label><span>Description</span><input value={description} onChange={(event) => invalidate(() => setDescription(event.target.value))} /></label>
          <div className="blueprint-capture-options">
            <label><input type="checkbox" checked={includeChildren} onChange={(event) => invalidate(() => setIncludeChildren(event.target.checked))} />Workspace structure</label>
            <label><input type="checkbox" checked={includeTasks} onChange={(event) => invalidate(() => setIncludeTasks(event.target.checked))} />Task definitions</label>
            <label><input type="checkbox" checked={includeGadgets} onChange={(event) => invalidate(() => setIncludeGadgets(event.target.checked))} />Gadget definitions</label>
            <label><input type="checkbox" checked={includeContext} onChange={(event) => invalidate(() => setIncludeContext(event.target.checked))} />Context structure</label>
          </div>
          <label>
            <span>Selected files (one relative Workspace path per line)</span>
            <textarea value={selectedFilesText} placeholder={"README.template.md\nconfig/example.json"} onChange={(event) => invalidate(() => setSelectedFilesText(event.target.value))} />
          </label>
          <div className="blueprint-capture-warning">Blueprint = a reusable work method, not a Workspace snapshot. Runtime data, workspace history, credentials, sessions, caches, build output, and current business data are not included.</div>
        </div>
        {error && <div className="gadget-error" role="alert">{error}</div>}
        <section className="blueprint-capture-preview">
          <div className="blueprint-capture-preview-head"><strong>Preview</strong><span>{preview ? "Ready to confirm" : "Not generated"}</span></div>
          {preview ? (
            <div className="blueprint-preview">
              <div className="blueprint-preview-summary">包含：{blueprintSummaryParts(preview).join(" · ") || "可重复使用的工作方法"}</div>
              {preview.kind === "workspace" && workspacePreview(preview.workspace)}
              {preview.kind === "composite" && preview.workspace && workspacePreview(preview.workspace)}
              {preview.kind === "gadget" && <div className="blueprint-preview-row"><strong>{preview.gadget.name}</strong><span>Gadget definition</span></div>}
              {options.selectedFiles?.length ? <div className="blueprint-preview-files"><strong>模板文件</strong>{options.selectedFiles.map((file) => <span key={file}>{file}</span>)}</div> : null}
            </div>
          ) : <div className="gadget-empty">Generate a preview to review the structure, tasks, Gadgets, and selected files before saving.</div>}
        </section>
        <footer>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void loadPreview()}>{busy === "preview" ? "Generating…" : "Generate Preview"}</button>
          <button type="button" className="btn btn--primary" disabled={!preview || busy !== null} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save Blueprint"}</button>
        </footer>
      </div>
    </div>
  );
}
