import { useEffect, useRef, useState } from "react";
import CodeView from "@/components/artifact/CodeView";
import MarkdownArtifactView from "@/components/artifact/MarkdownArtifactView";
import { useAppStore } from "@/store/appStore";
import { previewManifestFor, type WorkFile } from "./BotWorkResult";

const languageFor = (name: string): string => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "text";
  return ({ md: "markdown", py: "python", js: "javascript", ts: "typescript", sh: "bash", htm: "html", yml: "yaml" } as Record<string, string>)[ext] ?? ext;
};

/** The saved identity is independent of the selected ordinary Task and mutable source path. */
export default function WorkFilePreview({ file, target, onClose }: { file: WorkFile; target: string; onClose: () => void }): React.JSX.Element {
  const html = /\.html?$/i.test(file.name);
  const markdown = /\.md$/i.test(file.name);
  const supported = /\.(?:txt|md|json|jsonl|csv|tsv|xml|ya?ml|log|py|js|ts|tsx|jsx|css|html?|svg|sh)$/i.test(file.name);
  const [content, setContent] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<{ url: string; token: string }>();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [expanded, setExpanded] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let current = true;
    let token: string | undefined;
    setError(""); setContent(undefined); setPrepared(undefined); setWarnings([]); setTruncated(false);
    if (supported) {
      if (html) {
        const api = window.api?.savedArtifact;
        if (!api) setError("网页预览接口尚未加载，请重启 MyBuddy 后重试");
        else void api.prepare({ snapshotPath: target, name: file.name, manifestPath: previewManifestFor(file) }).then(result => {
          if (!current) { void api.release(result.token).catch(() => {}); return; }
          token = result.token; setPrepared(result); setContent(result.source); setWarnings(result.warnings);
        }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); });
      } else if (!window.api?.readWorkspaceFile) setError("文件读取接口不可用");
      else void window.api.readWorkspaceFile(target, "", true).then(result => {
        if (!current) return;
        setContent(result.content); setTruncated(result.truncated === true);
      }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); });
    }
    return () => { current = false; if (token) void window.api?.savedArtifact?.release(token).catch(() => {}); };
  }, [target, supported, html, file.name, file.previewManifestPath, file.artifact?.previewManifestPath, attempt]);

  useEffect(() => {
    if (!prepared) return;
    const receive = (event: MessageEvent): void => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== new URL(prepared.url).origin || !event.data || event.data.token !== prepared.token) return;
      if (event.data.type === "mybuddy:saved-artifact-error" && typeof event.data.message === "string") {
        const message = event.data.message.slice(0, 500);
        setWarnings(previous => previous.includes(message) ? previous : [...previous.slice(-19), message]);
      }
      if (event.data.type !== "mybuddy:saved-artifact-link" || typeof event.data.url !== "string" || !/^https?:\/\//i.test(event.data.url)) return;
      if (!window.api?.browser?.open) { setNotice("内置浏览器暂不可用，请重启 MyBuddy 后重试"); return; }
      window.api.browser.open(event.data.url);
      useAppStore.getState().setBrowserUrl(event.data.url);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [prepared]);

  const openSystem = async (): Promise<void> => {
    try {
      if (!window.api?.openFolder) throw new Error("系统打开接口不可用");
      await window.api.openFolder(target);
      setNotice("已请求系统应用打开；无法确认是否出现窗口。若未打开，请检查系统默认应用或定位保存文件。");
    } catch (reason) { setNotice(`无法打开文件：${reason instanceof Error ? reason.message : String(reason)}`); }
  };
  const toggleExpanded = (): void => {
    // Resize in-place rather than reparenting the document or changing chat history.
    setExpanded(value => !value);
  };
  let formatted = content ?? "";
  if (/\.json$/i.test(file.name) && content && !truncated) {
    try { formatted = JSON.stringify(JSON.parse(content), null, 2); } catch { /* Preserve invalid JSON verbatim. */ }
  }
  const plain = /\.(txt|log|csv|tsv)$/i.test(file.name);
  return <section className={`bot-work-file-preview${expanded ? " is-expanded" : ""}`} aria-label={`文件预览：${file.name}`}>
    <header className="bot-work-file-preview-header">
      <div><strong>{file.name}</strong><span className="bot-work-file-version-label">保存版本 · 只读</span></div>
      <div className="bot-work-file-preview-actions">
        <button type="button" aria-expanded={expanded} onClick={toggleExpanded}>{expanded ? "收起查看" : "展开查看"}</button>
        <button type="button" onClick={onClose}>关闭预览</button>
      </div>
    </header>
    {(html || markdown) && <div className="bot-work-file-preview-tabs" role="group" aria-label="查看方式">
      <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>预览</button>
      <button type="button" aria-pressed={mode === "source"} onClick={() => setMode("source")}>源码</button>
    </div>}
    <details className="bot-work-file-version"><summary>版本信息</summary><p>读取版本：{target}</p>
      {file.artifact && <><p>SHA-256：{file.artifact.digest}</p><p>保存时间：{Number.isFinite(file.artifact.registeredAt) ? new Date(file.artifact.registeredAt).toLocaleString() : "未记录"}</p></>}
      <p>此处查看交付时的保存版本，不修改原文件或历史成果。页面内操作仅用于本次预览，重新打开后重置。</p>
    </details>
    {!supported ? <p role="status">此格式暂不支持内置预览。可尝试系统应用打开，或定位保存文件。</p>
      : error ? <><p role="alert">无法读取文件：{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试读取</button></>
      : content === undefined ? <p role="status">正在读取文件…</p>
      : <>
        {warnings.length > 0 && <div className="bot-work-file-warnings" role="status">{warnings.map(message => <p key={message}>{message}</p>)}</div>}
        <div className="bot-work-file-preview-body">
          {content.length === 0 ? <p>文件为空。</p>
            : html && prepared ? <>
              <iframe ref={iframe} title={`${file.name} 保存版本`} src={prepared.url} sandbox="allow-scripts allow-same-origin" hidden={mode !== "preview"} onError={() => setError("网页加载失败，请重试读取")} />
              {mode === "source" && <CodeView content={content} language="html" readOnly />}
            </>
            : markdown && mode === "preview" ? <MarkdownArtifactView content={content} />
            : plain ? <pre tabIndex={0}>{content}</pre>
            : <CodeView content={mode === "source" ? content : formatted} language={languageFor(file.name)} readOnly />}
        </div>
        {truncated && <p role="status">仅显示文件前 256 KiB 的文本；完整文件保留在上述路径。</p>}
      </>}
    <footer className="bot-work-file-preview-actions">
      <button type="button" onClick={() => void openSystem()}>尝试用系统应用打开</button>
      <button type="button" onClick={() => {
        if (!window.api?.showItemInFolder) { setNotice("定位文件接口不可用"); return; }
        void window.api.showItemInFolder(target).catch(reason => setNotice(`无法定位文件：${String(reason)}`));
      }}>定位保存文件</button>
    </footer>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
