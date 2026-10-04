import { IconSearch } from "@/components/common/icons";

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
};

export function HubSearch({ value, onChange, placeholder }: Props) {
  return (
    <label className="hub-search">
      <IconSearch size={14} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {value && (
        <button type="button" className="hub-search-clear" onClick={() => onChange("")} aria-label="清空搜索">
          ×
        </button>
      )}
    </label>
  );
}
