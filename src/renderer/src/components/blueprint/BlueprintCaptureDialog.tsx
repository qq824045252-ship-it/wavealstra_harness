import { useId, useRef, useState } from "react";
import type { BlueprintCaptureOptions, BlueprintDefinition, BlueprintDescriptor } from "@shared/blueprint-types";
import { IconFolder, IconShield } from "@/components/common/icons";
import BlueprintDefinitionPreview from "./BlueprintDefinitionPreview";
import BlueprintDialog from "./BlueprintDialog";

interface Props {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  onSaved: (blueprint: BlueprintDescriptor) => void;
}

type Operation = "preview" | "save";

export default function BlueprintCaptureDialog({ workspaceId, workspaceName, onClose, onSaved }: Props): React.JSX.Element {
  const formId = useId();
  const previewHeadingId = useId();
  const pending = useRef(false);
  const [name, setName] = useState(`${workspaceName} Blueprint`);
  const [description, setDescription] = useState("");
  const [includeChildren, setIncludeChildren] = useState(true);
  const [includeTasks, setIncludeTasks] = useState(true);
  const [includeGadgets, setIncludeGadgets] = useState(true);
  const [includeContext, setIncludeContext] = useState(false);
  const [selectedFilesText, setSelectedFilesText] = useState("");
  const [preview, setPreview] = useState<BlueprintDefinition | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = (apply: () => void): void => {
    apply();
    setPreview(null);
    setError(null);
  };

  const run = async (operation: Operation): Promise<void> => {
    if (pending.current) return;
    const blueprint = window.api?.blueprint;
    const options: BlueprintCaptureOptions = {
      name: name.trim(),
      description: description.trim() || undefined,
      includeChildren,
      includeTasks,
      includeGadgets,
      includeContext,
      selectedFiles: selectedFilesText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    };
    if (!options.name) { setError("请输入 Blueprint 名称"); return; }
    if (!blueprint) { setError("Blueprint 能力尚未加载，请重启 MyBuddy"); return; }
    const confirmedDefinition = operation === "save" ? preview : null;
    if (operation === "save" && !confirmedDefinition) { setError("请先生成预览并确认要保存的结构"); return; }

    pending.current = true;
    setBusy(operation);
    setError(null);
    try {
      if (confirmedDefinition) {
        const saved = await blueprint.capture({ workspaceId, options, confirmedDefinition });
        onSaved(saved);
      } else {
        setPreview(null);
        setPreview(await blueprint.previewCapture({ workspaceId, options }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  const scopeOptions: { label: string; checked: boolean; set: (enabled: boolean) => void }[] = [
    { label: "子工作区", checked: includeChildren, set: setIncludeChildren },
    { label: "任务定义", checked: includeTasks, set: setIncludeTasks },
    { label: "Gadget 定义", checked: includeGadgets, set: setIncludeGadgets },
    { label: "工作区上下文", checked: includeContext, set: setIncludeContext },
  ];

  return (
    <BlueprintDialog
      title="创建 Blueprint"
      sourceName={workspaceName}
      kind="workspace"
      busy={busy !== null}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="bp-button" disabled={busy !== null} onClick={onClose}>取消</button>
          <button type="submit" form={formId} className={`bp-button${preview ? "" : " bp-button--primary"}`} disabled={busy !== null || !name.trim()}>
            {busy === "preview" ? "正在生成…" : preview ? "重新预览" : "生成预览"}
          </button>
          <button type="button" className={`bp-button${preview ? " bp-button--primary" : ""}`} disabled={!preview || busy !== null} onClick={() => void run("save")}>
            {busy === "save" ? "正在保存…" : "保存 Blueprint"}
          </button>
        </>
      }
    >
      <div className="blueprint-capture-body">
        <form id={formId} className="blueprint-capture-fields" onSubmit={(event) => { event.preventDefault(); void run("preview"); }}>
          <fieldset className="blueprint-fields" disabled={busy !== null}>
            <legend>基本信息</legend>
            <label className="blueprint-field">
              <span>名称</span>
              <input data-blueprint-initial-focus required maxLength={120} value={name} onChange={(event) => change(() => setName(event.target.value))} />
            </label>
            <label className="blueprint-field">
              <span>描述 <small>可选</small></span>
              <input value={description} onChange={(event) => change(() => setDescription(event.target.value))} />
            </label>
          </fieldset>
          <fieldset className="blueprint-fields" disabled={busy !== null}>
            <legend>包含内容</legend>
            <div className="blueprint-scope-options">
              {scopeOptions.map((option) => (
                <label className="blueprint-scope-option" key={option.label}>
                  <input type="checkbox" checked={option.checked} onChange={(event) => change(() => option.set(event.target.checked))} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            <label className="blueprint-field">
              <span>模板文件 <small>可选</small></span>
              <textarea
                rows={3}
                aria-describedby={`${formId}-paths`}
                value={selectedFilesText}
                onChange={(event) => change(() => setSelectedFilesText(event.target.value))}
              />
              <small id={`${formId}-paths`}>每行输入一个相对工作区路径</small>
            </label>
          </fieldset>
          <p className="blueprint-capture-policy"><IconShield size={16} /><span>请只选择可复用的模板材料。任务历史、运行数据、缓存和凭据会被排除。</span></p>
          {error && <p className="blueprint-dialog-error" role="alert">{error}</p>}
        </form>
        <section className="blueprint-definition-pane" aria-labelledby={previewHeadingId} aria-busy={busy === "preview"}>
          <header className="blueprint-definition-header">
            <h3 id={previewHeadingId}>结构预览</h3>
            <span className={preview ? "blueprint-preview-ready" : undefined} role="status">
              {busy === "preview" ? "正在生成" : preview ? "待确认" : "未生成"}
            </span>
          </header>
          {preview ? <BlueprintDefinitionPreview definition={preview} /> : (
            <div className="blueprint-preview-empty">
              <span><IconFolder size={23} /></span>
              <p>{busy === "preview" ? "正在读取工作区结构…" : "生成预览后，可核对实际包含的工作区、任务、Gadget 和文件。"}</p>
            </div>
          )}
        </section>
      </div>
    </BlueprintDialog>
  );
}
