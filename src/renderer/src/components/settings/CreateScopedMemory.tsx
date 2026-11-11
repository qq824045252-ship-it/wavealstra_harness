import { useState } from "react";
import type { MemoryScopeType } from "@shared/memory-kernel";
import { useTextPrompt } from "@/components/common/useTextPrompt";

export default function CreateScopedMemory({ scopeType, scopeId, onChanged }: {
  scopeType: MemoryScopeType; scopeId?: string; onChanged: () => Promise<void>;
}): React.JSX.Element {
  const { requestText, textPromptDialog } = useTextPrompt();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create(): Promise<void> {
    const content = await requestText({ title: scopeType === "global" ? "新增公共记忆" : "新增记忆",
      description: scopeType === "global" ? "保存后将明确共享，供 Bot 和团队读取。" : "只保存到当前归属。",
      label: "要记住的内容", multiline: true, allowEmpty: false, maxLength: 12000, confirmLabel: "保存" });
    if (content === null) return;
    const api = window.api?.memory;
    if (!api) { setError("记忆服务未连接"); return; }
    setBusy(true); setError("");
    try {
      await api.create({ kind: "fact", title: content.trim().slice(0, 120), content, explicit: true,
        sourceType: "manual", scopeType, scopeId, metadata: scopeType === "global" ? { publicShared: true } : {} });
      await onChanged();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <><button type="button" className="btn" disabled={busy} onClick={() => void create()}>新增记忆</button>
    {error && <span role="alert">{error}</span>}{textPromptDialog}</>;
}
