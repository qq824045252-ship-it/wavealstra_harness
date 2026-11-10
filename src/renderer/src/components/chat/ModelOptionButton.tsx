import type { ReactNode } from "react";
import { IconCheck } from "@/components/common/icons";

/** Shared model row: ordinary chat and Bot keep the same spacing and truncation. */
export function ModelOptionButton({name, icon, selected, onClick, title, role}: {
  name: string; icon?: ReactNode; selected?: boolean; onClick: () => void; title?: string; role?: "option";
}) {
  return <button type="button" className={`model-option${selected ? " active" : ""}`} title={title}
    role={role} aria-selected={role === "option" ? Boolean(selected) : undefined} onClick={onClick}>
    {icon}<span className="model-option-name">{name}</span>
    {selected && <IconCheck size={14} className="model-option-check" />}
  </button>;
}
