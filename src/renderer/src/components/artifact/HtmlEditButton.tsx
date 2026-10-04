import { useEffect, useState } from "react";
import type { HtmlEditTarget } from "@shared/html-edit";

export default function HtmlEditButton({ target, artifactId, modelId }: { target: HtmlEditTarget; artifactId?: string; modelId?: string }): React.JSX.Element {
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => window.api?.htmlEdit?.onState(state => {
    if (state.target === target) { setActive(state.active); if (state.message) setMessage(state.message); }
  }), [target]);
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(""), 5000); return () => window.clearTimeout(timer); }, [message]);
  const toggle = async (): Promise<void> => {
    const api = window.api?.htmlEdit;
    if (!api) { setError("编辑功能尚未加载，请重启 MyBuddy"); return; }
    setBusy(true); setError("");
    try {
      if (active) await api.stop();
      else {
        const result = await api.start({ target, artifactId, modelId });
        if (!result.ok) setError(result.error || "编辑器打开失败");
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className={`icon-btn${active ? " active" : ""}`} title={error || (active ? "完成 HTML 编辑（保留草稿）" : "编辑页面文案与格式")} aria-label={active ? "完成 HTML 编辑" : "编辑 HTML"} disabled={busy} onClick={() => void toggle()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z"/></svg>
    </button>
    {error && <span role="alert" style={{ fontSize: 12, maxWidth: 220 }} onClick={() => setError("")}>{error}</span>}
    {message && <span role="status" style={{ fontSize: 12 }}>{message}</span>}
  </>;
}
