import { useEffect, useRef, useState } from "react";
import { useTaskBrowserTabs } from "@/lib/useTaskBrowserTabs";

export default function BrowserTaskSpace({ taskId, onClose }: { taskId: string; onClose: () => void }): React.JSX.Element {
  const browser = window.api?.browser;
  const tabs = useTaskBrowserTabs(taskId);
  const [tabId, setTabId] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [image, setImage] = useState<{ id: string; url: string }>();
  const [error, setError] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const controlled = tabs.find(tab => tab.control);
  const selected = controlled ?? tabs.find(tab => tab.id === tabId) ?? tabs.at(-1);
  const interactive = selected?.control && selected.control !== "pending";
  const selectedId = selected?.id;

  useEffect(() => {
    if (!browser || !selectedId || !interactive) return;
    const node = host.current;
    if (!node) return;
    const report = () => {
      const { x, y, width, height } = node.getBoundingClientRect();
      browser.setRect({ x, y, width, height });
    };
    browser.selectTab(selectedId);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    window.addEventListener("resize", report);
    return () => { observer.disconnect(); window.removeEventListener("resize", report); browser.hide(); };
  }, [browser, interactive, selectedId]);

  useEffect(() => {
    setError(false);
    setImage(undefined);
    if (!browser?.previewTaskTab || !selectedId || selected?.loading || !selected?.url || selected.control) return;
    let disposed = false;
    let url: string | undefined;
    void browser.previewTaskTab(taskId, selectedId).then(bytes => {
      if (disposed || !bytes) return;
      url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      setImage({ id: selectedId, url });
    }, () => { if (!disposed) setError(true); });
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [browser, taskId, selectedId, selected?.url, selected?.loading, selected?.control, refresh]);

  return (
    <div className="browser-view browser-space-content">
      {tabs.length > 0 && <div className="browser-tabs" role="tablist" aria-label="任务 Space 标签页">
        {tabs.map(tab => <div className={`browser-tab${tab.id === selectedId ? " active" : ""}`} key={tab.id}>
          <button type="button" role="tab" aria-selected={tab.id === selectedId} disabled={Boolean(controlled && tab.id !== controlled.id)}
            title={tab.url} onClick={() => setTabId(tab.id)}>{tab.title || tab.url || "新标签页"}</button>
        </div>)}
      </div>}
      <div className="browser-space-controls">
        {selected && <span role="status">{selected.control === "pending" ? "等待当前操作完成" : interactive ? "人工控制" : "AI 控制"}</span>}
        {selected && !selected.control && <>
          <button className="btn" type="button" onClick={() => setRefresh(value => value + 1)}>刷新预览</button>
          <button className="btn" type="button" onClick={() => browser?.takeControl(taskId, selected.id)}>接管</button>
        </>}
        {(selected?.control === "manual" || selected?.control === "pending" || selected?.control === "login") &&
          <button className="btn" type="button" onClick={() => browser?.returnControl(taskId, selected.id)}>
            {selected.control === "login" ? "已登录" : selected.control === "pending" ? "取消接管" : "交回 AI"}
          </button>}
        <button className="btn browser-space-dismiss" type="button" aria-label="收起浏览器（保留标签页）" onClick={onClose}>收起</button>
      </div>
      {selected?.control === "login" && <div className="artifact-browser-notice" role="status">
        {selected.loginRetry ? "还没有检测到登录成功。完成后再点「已登录」。" :
          ({ password: "请在网页中输入密码", qr: "请扫码登录", code: "请在网页中填写验证码" }[selected.loginChallenge ?? "password"]) + "，然后点「已登录」。"}
      </div>}
      {selected?.control === "handoff" && <div className="artifact-browser-notice" role="status">完成网页验证后，在对话中确认。</div>}
      {interactive ? <div className="browser-wcv-host" ref={host} /> :
        <div className="browser-space-preview">
          {image && image.id === selectedId && !selected?.control ? <img src={image.url} alt="任务浏览器页面预览" /> :
            <span>{!selected ? "AI 打开网页后会出现在这里" : error ? "预览暂不可用，可以刷新重试" :
              selected.control === "pending" ? "正在等待接管" : selected.url ? "正在获取页面预览" : "标签页尚未打开网页"}</span>}
        </div>}
    </div>
  );
}
