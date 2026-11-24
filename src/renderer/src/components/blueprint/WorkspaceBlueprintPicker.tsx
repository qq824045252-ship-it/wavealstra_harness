import { useId } from "react";
import type { BlueprintDescriptor, ResolvedBlueprint } from "@shared/blueprint-types";
import { blueprintSummaryParts } from "@/lib/blueprintUi";
import { IconFolderKanban, IconShield } from "@/components/common/icons";
import BlueprintDefinitionPreview from "./BlueprintDefinitionPreview";

interface Props {
  items: BlueprintDescriptor[];
  selectedId: string;
  resolved: Record<string, ResolvedBlueprint>;
  loading: boolean;
  busy: boolean;
  onSelect: (item: BlueprintDescriptor) => void;
}

export default function WorkspaceBlueprintPicker({ items, selectedId, resolved, loading, busy, onSelect }: Props): React.JSX.Element | null {
  const group = useId();
  const previewHeading = useId();
  const selected = items.find((item) => item.id === selectedId);
  const warnings = selected ? resolved[selected.id]?.warnings : undefined;
  if (!items.length && !loading) return null;

  return (
    <section className="workspace-blueprint-picker" aria-labelledby={`${group}-heading`}>
      <h3 id={`${group}-heading`}><IconFolderKanban size={16} />从 Blueprint 创建</h3>
      {items.length > 0 ? (
        <div className="workspace-blueprint-picker-body">
          <fieldset className="workspace-blueprint-choices" disabled={busy}>
            <legend>选择模板</legend>
            {items.map((item) => (
              <label key={item.id} className="workspace-blueprint-choice">
                <input type="radio" name={group} checked={selectedId === item.id} onChange={() => onSelect(item)} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description || blueprintSummaryParts(item.definition).join(" · ") || "工作空间模板"}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <section className="workspace-blueprint-preview" aria-labelledby={previewHeading}>
            <h4 id={previewHeading}>结构预览</h4>
            {selected ? (
              <>
                <BlueprintDefinitionPreview key={selected.id} definition={selected.definition} />
                {loading && warnings === undefined && <p className="workspace-blueprint-status" role="status">正在检查模板所需的能力…</p>}
                {warnings && warnings.length > 0 && (
                  <ul className="workspace-blueprint-warnings" aria-label="模板提示">
                    {warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                )}
                <p className="blueprint-capture-policy"><IconShield size={16} /><span>运行状态、历史记录和凭证不会复制。</span></p>
              </>
            ) : <p className="workspace-blueprint-status">选择模板以查看创建的内容。</p>}
          </section>
        </div>
      ) : <p className="workspace-blueprint-status" role="status">正在查找可用模板…</p>}
    </section>
  );
}
