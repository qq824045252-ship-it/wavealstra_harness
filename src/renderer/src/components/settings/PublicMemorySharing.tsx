import { useState } from "react";
import type { MemoryRecordDto } from "@shared/memory-kernel";

/** Sharing is explicit; legacy global records are not silently made public. */
export default function PublicMemorySharing({ memory, disabled, onChanged }: {
  memory: MemoryRecordDto; disabled?: boolean; onChanged: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shared = memory.metadata?.publicShared === true;
  return <div className="settings-row-desc">
    <span>{shared ? "已明确共享：Bot 和团队可读取" : "未共享：不会供 Bot 和团队自动读取"}</span>{" "}
    <button type="button" className="btn" disabled={disabled || busy} onClick={() => {
      if (!window.api?.memory) { setError("记忆服务未连接"); return; }
      setBusy(true); setError("");
      void window.api.memory.update({ id: memory.id, metadata: { ...memory.metadata, publicShared: !shared },
        changedBy: "manual", changeReason: shared ? "撤回公共共享" : "明确共享为公共记忆" })
        .then(onChanged).catch(e => setError(String(e))).finally(() => setBusy(false));
    }}>{shared ? "撤回共享" : "共享为公共记忆"}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
