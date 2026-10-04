type Pill = { id: string; label: string; count?: number; extraCount?: number; extraLabel?: string };

type Props = {
  pills: Pill[];
  activeId: string;
  onChange: (id: string) => void;
};

export function HubFilterPills({ pills, activeId, onChange }: Props) {
  return (
    <div className="hub-filter-pills">
      {pills.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`pill ${p.id === activeId ? "dark" : ""}`}
          onClick={() => onChange(p.id)}
        >
          {p.label}
          {typeof p.count === "number" && <span className="hub-subtab-count">{p.count}</span>}
          {typeof p.extraCount === "number" && p.extraCount > 0 && (
            <span className="hub-subtab-count hub-subtab-installed" title={p.extraLabel ?? "已安装"}>
              {p.extraLabel ? `${p.extraLabel} ${p.extraCount}` : `已装 ${p.extraCount}`}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
