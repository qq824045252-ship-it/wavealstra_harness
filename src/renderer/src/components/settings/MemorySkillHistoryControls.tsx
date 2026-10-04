import { useEffect, useRef, useState } from "react";

export function useSkillHistorySelection(items: readonly { id: string }[], active: boolean) {
  const [keys, setKeys] = useState<Set<string>>(() => new Set());
  const selectedIds = active ? items.filter((item) => keys.has(item.id)).map((item) => item.id) : [];
  useEffect(() => {
    const visible = new Set(active ? items.map((item) => item.id) : []);
    setKeys((previous) => {
      const retained = new Set([...previous].filter((id) => visible.has(id)));
      return retained.size === previous.size ? previous : retained;
    });
  }, [items, active]);
  return {
    selectedIds,
    total: active ? items.length : 0,
    has: (id: string) => active && keys.has(id),
    clear: () => setKeys(new Set()),
    selectAll: (checked: boolean) => setKeys(checked && active ? new Set(items.map((item) => item.id)) : new Set()),
    toggle: (id: string) => setKeys((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    }),
  };
}

export default function MemorySkillHistoryControls({ selection, disabled, kind, onDeleteSelected, onDeleteAll }: {
  selection: ReturnType<typeof useSkillHistorySelection>;
  disabled: boolean;
  kind: "candidate" | "revision";
  onDeleteSelected: () => void;
  onDeleteAll: () => void;
}): React.JSX.Element {
  const allRef = useRef<HTMLInputElement | null>(null);
  const count = selection.selectedIds.length;
  const allSelected = selection.total > 0 && count === selection.total;
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = count > 0 && !allSelected;
  }, [count, allSelected]);
  return <div className="memory-toolbar memory-skill-history-toolbar" data-history-kind={kind}>
    <label className="memory-select-all">
      <input ref={allRef} type="checkbox" checked={allSelected} disabled={disabled || selection.total === 0} onChange={(event) => selection.selectAll(event.currentTarget.checked)} />
      全选当前历史
    </label>
    <span className="memory-count">已选 {count} 条</span>
    <div className="memory-toolbar-actions">
      <button type="button" className="btn" disabled={disabled || count === 0} onClick={selection.clear}>清空选择</button>
      <button type="button" className="btn danger" disabled={disabled || count === 0} onClick={onDeleteSelected}>删除选中（{count}）</button>
      <button type="button" className="btn danger" disabled={disabled} onClick={onDeleteAll}>清空{kind === "candidate" ? "技能" : "修订"}历史</button>
    </div>
  </div>;
}
