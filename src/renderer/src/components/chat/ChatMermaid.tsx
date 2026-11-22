import { useEffect, useState } from "react";
import { isChatMermaid, renderMermaidImage } from "@/lib/mermaidImage";

export default function ChatMermaid({ code, loading }: { code: string; loading?: boolean }) {
  const [rendered, setRendered] = useState<{ code: string; url?: string }>();
  const supported = !loading && isChatMermaid(code);
  useEffect(() => {
    if (!supported) return;
    let current = true;
    void renderMermaidImage(code).then(url => { if (current) setRendered({ code, url }); },
      () => { if (current) setRendered({ code }); });
    return () => { current = false; };
  }, [supported, code]);
  const url = supported && rendered?.code === code ? rendered.url : undefined;
  if (!url) return <div className="md-pre"><span className="md-pre-lang">mermaid</span>
    <pre><code>{code}</code></pre>
  </div>;
  return <figure className="chat-mermaid">
    <img src={url} alt="Mermaid 图" />
    <details><summary>查看图示源码</summary><pre><code>{code}</code></pre></details>
  </figure>;
}
