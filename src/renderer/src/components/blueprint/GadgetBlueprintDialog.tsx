import { useId, useRef, useState } from "react";
import type { GadgetListItem } from "@shared/gadget-types";
import { IconShield } from "@/components/common/icons";
import BlueprintDialog from "./BlueprintDialog";

interface Props {
  gadget: Pick<GadgetListItem, "name" | "description">;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}

export default function GadgetBlueprintDialog({ gadget, onClose, onSave }: Props): React.JSX.Element {
  const formId = useId();
  const pending = useRef(false);
  const [name, setName] = useState(gadget.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <BlueprintDialog
      title="保存为 Blueprint"
      sourceName={gadget.name}
      kind="gadget"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="bp-button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" form={formId} className="bp-button bp-button--primary" disabled={busy || !name.trim()}>
            {busy ? "正在保存…" : "保存 Blueprint"}
          </button>
        </>
      }
    >
      <form id={formId} className="blueprint-gadget-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="blueprint-field">
          <span>Blueprint 名称</span>
          <input data-blueprint-initial-focus required maxLength={120} value={name} disabled={busy} onChange={(event) => { setName(event.target.value); setError(null); }} />
        </label>
        <section className="blueprint-gadget-source" aria-label="来源工具">
          <h3>将保存的工具</h3>
          <strong>{gadget.name}</strong>
          {gadget.description && <p>{gadget.description}</p>}
          <span>包含工具定义和源文件</span>
        </section>
        <p className="blueprint-capture-policy"><IconShield size={16} /><span>运行数据和凭据会被排除。</span></p>
        {error && <p className="blueprint-dialog-error" role="alert">{error}</p>}
      </form>
    </BlueprintDialog>
  );
}
