import { useState } from "react";
import { cadCraftExtension, type CadCraftSource } from "@shared/cadcraft";

export default function CadCraftDocumentView({ name, source }: { name: string; source: CadCraftSource }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");

  async function openCopy(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const api = window.api?.cadCraft;
      if (!api) throw new Error("CADCraft 接口暂不可用，请重启 MyBuddy");
      const result = await api.openCopy(source);
      if (!result.canceled) setPath(result.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <section className="bot-work-file-preview" aria-label={name}>
    <p>CADCraft 将在独立窗口编辑{cadCraftExtension(name) === "dwg" ? " DWG " : " "}副本。</p>
    <div className="bot-work-file-preview-actions">
      <button type="button" disabled={busy} onClick={() => void openCopy()}>
        {busy ? "正在准备图纸…" : "在 CADCraft 中编辑副本"}
      </button>
      {path && <button type="button" onClick={() => {
        void window.api?.showItemInFolder(path).catch(() => setError("无法定位编辑副本"));
      }}>定位编辑副本</button>}
    </div>
    {path && <p role="status">编辑副本已创建，保存操作在 CADCraft 窗口完成。</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
