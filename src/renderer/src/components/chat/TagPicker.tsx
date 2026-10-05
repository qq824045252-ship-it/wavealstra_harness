import { useEffect, useMemo, useRef, useState } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useAppStore } from "@/store/appStore";
import { IconCheck, IconChevronDown, IconSearch } from "@/components/common/icons";
import { applyModeProfileResponse, emptyModeTagOptionLabel } from "@/lib/projectWorkspace";
import { buildPresetBarChips, isTaskModeLocked } from "@/lib/modePresetBar";
import { defaultModePresetId } from "@shared/mode-profile";
import type { ModePresetDto, McpServerDto } from "@shared/agent-ipc";

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

export default function TagPicker({ open, onToggle, onClose }: Props): React.JSX.Element {
  const welcomeMode = useAppStore((state) => state.welcomeMode);
  const modePresetId = useAppStore((state) => state.modePresetId);
  const setModePreset = useAppStore((state) => state.setModePreset);
  const task = useAppStore((state) => state.tasks.find((item) => item.id === state.activeTaskId));
  const [presets, setPresets] = useState<ModePresetDto[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerDto[]>([]);
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLDivElement>(null);
  useDismissOnClickOutside(open, onClose, anchorRef);

  useEffect(() => {
    const requested = welcomeMode;
    let cancelled = false;
    void window.api?.agent?.getModeProfile?.(requested).then((profile) => {
      if (cancelled) return;
      const next = profile?.policy?.presets ?? [];
      setPresets(next);
      const selected = task?.modePresetId ?? modePresetId ?? defaultModePresetId(requested);
      const resolved = applyModeProfileResponse({
        requestedMode: requested,
        currentMode: requested,
        presets: next,
        currentPresetId: selected,
        fallbackPresetId: defaultModePresetId(requested),
      });
      if (!resolved.ignore && resolved.modePresetId && resolved.modePresetId !== selected) {
        setModePreset(resolved.modePresetId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [welcomeMode]);

  const needsProviderCheck = presets.some((preset) => (preset.providerMcpIds?.length ?? 0) > 0);
  useEffect(() => {
    if (!needsProviderCheck) {
      setMcpServers([]);
      return;
    }
    void window.api?.mcp?.listServers?.().then((list) => setMcpServers(list ?? []));
  }, [needsProviderCheck]);

  const availableMcpServerNames = useMemo(
    () => new Set(mcpServers.filter((server) => server.installed && !server.disabled).map((server) => server.name)),
    [mcpServers],
  );
  const selectedPresetId = task?.modePresetId ?? modePresetId;
  const chips = useMemo(
    () =>
      buildPresetBarChips({
        presets,
        selectedPresetId,
        availableMcpServerNames,
        locked: welcomeMode !== "bot" && isTaskModeLocked(task),
      }),
    [presets, selectedPresetId, availableMcpServerNames, task, welcomeMode],
  );
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return chips.filter(
      (chip) =>
        !normalized ||
        chip.label.toLowerCase().includes(normalized) ||
        (chip.description?.toLowerCase().includes(normalized) ?? false),
    );
  }, [chips, query]);
  const selected = chips.find((chip) => chip.selected);

  const pick = (id: string): void => {
    setModePreset(id);
    onClose();
  };

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <div className="input-popup-anchor workspace-picker-anchor" ref={anchorRef}>
      <button
        type="button"
        className="pill-select as-btn workspace-trigger"
        title={selected?.title ?? selected?.description ?? "选择标签"}
        onClick={onToggle}
      >
        {selected?.label ?? emptyModeTagOptionLabel()}
        <IconChevronDown size={12} className={open ? "chevron-up" : ""} />
      </button>
      {open && (
        <div className="workspace-popup" onClick={(event) => event.stopPropagation()}>
          <div className="workspace-popup-search">
            <IconSearch size={14} />
            <input
              placeholder="搜索标签"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="workspace-popup-list">
            {visible.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className={`workspace-popup-item ${chip.selected ? "active" : ""}`}
                disabled={chip.disabled}
                title={chip.title ?? chip.description}
                onClick={() => {
                  if (!chip.disabled) pick(chip.id);
                }}
              >
                <span className="workspace-popup-main">
                  <span className="workspace-popup-name">{chip.label}</span>
                  {chip.description && (
                    <span className="workspace-popup-path">{chip.description}</span>
                  )}
                </span>
                {chip.selected && <IconCheck size={14} />}
              </button>
            ))}
            {visible.length === 0 && (
              <div className="workspace-popup-empty">
                {presets.length === 0 ? emptyModeTagOptionLabel() : "无匹配标签"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
