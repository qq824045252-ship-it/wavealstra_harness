import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AssemblyTraceDto,
  ExpertDto,
  McpServerDto,
  ModeArtifactPolicy,
  ModeBlockId,
  ModeMcpPolicy,
  ModePolicyDto,
  ModePresetDto,
  ModeProfileDto,
  ModeProfileSummaryDto,
  ModeSkillPolicy,
  ModelInfoDto,
  SkillDto,
  WelcomeMode,
} from "@shared/agent-ipc";
import {
  defaultModePresetId,
  isRetiredModePresetId,
  sanitizeModePresets,
  MODE_BLOCK_IDS,
  MODE_BLOCK_LABELS,
  WELCOME_MODE_LABELS,
  WELCOME_MODES,
  WORKING_ARTIFACT_DENY_DEFAULT,
  emptyModePolicy,
  normalizeArtifactExtension,
} from "@shared/mode-profile";
import {
  IconAlert,
  IconBlocks,
  IconCheck,
  IconCode,
  IconFile,
  IconFilter,
  IconFolder,
  IconList,
  IconRotate,
  IconShield,
  IconTarget,
} from "@/components/common/icons";
import WelcomeModeIcon from "@/components/common/WelcomeModeIcon";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { useAppStore } from "@/store/appStore";
import {
  PERMISSION_OPTIONS,
  applyPresetsToPolicy,
  buildModelSuggestionOptions,
  isModelSuggestionAvailable,
  isPresetDraftValid,
  isSeedPreset,
  normalizeArtifactPolicy,
  normalizeMcpPolicy,
  normalizePresetDraft,
  normalizeSkillPolicy,
  removePreset,
  suggestPresetId,
} from "@/lib/presetEditor";
import { previewBlockedHint } from "@/lib/modesPreviewGuard";
import { isRetiredDesignSkill, isRetiredManagedProvider } from "@shared/professional-tools";

type EditPane = ModeBlockId | "skills" | "mcp" | "artifacts" | "policy" | "presets";

const PANE_LABELS: Record<EditPane, string> = {
  ...MODE_BLOCK_LABELS,
  skills: "技能限制",
  mcp: "MCP 限制",
  artifacts: "产物显示过滤",
  presets: "预设 / Tags",
  policy: "策略 (JSON)",
};

const PANE_HINTS: Record<EditPane, string> = {
  goal: "场景目标与角色定位",
  workflow: "推荐工作步骤与节奏",
  delivery: "输出格式与交付物要求",
  forbid: "明确禁止或避免的行为",
  criteria: "完成与验收的判断标准",
  skills: "勾选已安装技能",
  mcp: "勾选 MCP 服务",
  artifacts: "本模式独立的产物黑白名单：按此过滤产物面板显示（如办公隐藏 .py/.ts 产物）；不影响文件写入，变更显示不受过滤影响",
  presets: "每个 Tag 的推荐专家/模型/权限/受管 MCP 与技能收窄策略",
  policy: "完整策略 JSON",
};

/** 黑名单侧常用建议（代码/脚本类） */
const ARTIFACT_DENY_SUGGESTIONS = [
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "go",
  "rs",
  "java",
  "cpp",
  "cs",
  "php",
  "rb",
  "sh",
  "ps1",
  "sql",
  "ipynb",
] as const;

/** 白名单侧常用建议（办公/设计交付类） */
const ARTIFACT_ALLOW_SUGGESTIONS = [
  "md",
  "txt",
  "csv",
  "json",
  "docx",
  "xlsx",
  "pptx",
  "pdf",
  "html",
  "svg",
  "png",
  "jpg",
  "drawio",
] as const;

type ArtifactAccessSubTab = "deny" | "allow";

type AccessSubTab = "allow" | "deny" | "sort";

interface CatalogItem {
  /** 写入 policy 的稳定键（技能 id / MCP name） */
  key: string;
  title: string;
  subtitle?: string;
  /** 列表中已不存在，仅出现在已保存策略里 */
  orphan?: boolean;
  disabled?: boolean;
}

function paneIcon(pane: EditPane, size = 15): ReactNode {
  switch (pane) {
    case "goal":
      return <IconTarget size={size} />;
    case "workflow":
      return <IconList size={size} />;
    case "delivery":
      return <IconFile size={size} />;
    case "forbid":
      return <IconShield size={size} />;
    case "criteria":
      return <IconCheck size={size} />;
    case "skills":
      return <IconFilter size={size} />;
    case "mcp":
      return <IconShield size={size} />;
    case "artifacts":
      return <IconFile size={size} />;
    case "presets":
      return <IconBlocks size={size} />;
    case "policy":
      return <IconCode size={size} />;
    default: {
      const _exhaustive: never = pane;
      return _exhaustive;
    }
  }
}

/** 单侧（黑或白）扩展名 chip 列表编辑 */
function ArtifactExtListEditor({
  tone,
  selected,
  onChange,
  suggestions,
  emptyText,
  placeholder,
}: {
  tone: "deny" | "allow";
  selected: string[];
  onChange: (next: string[]) => void;
  suggestions: readonly string[];
  emptyText: string;
  placeholder: string;
}): React.JSX.Element {
  const [input, setInput] = useState("");

  const addExt = (raw: string): void => {
    const parts = raw
      .split(/[\s,;|]+/)
      .map((s) => normalizeArtifactExtension(s))
      .filter(Boolean);
    if (!parts.length) return;
    const set = new Set(selected);
    const next = [...selected];
    for (const p of parts) {
      if (!set.has(p)) {
        set.add(p);
        next.push(p);
      }
    }
    onChange(next);
    setInput("");
  };

  const removeExt = (ext: string): void => {
    onChange(selected.filter((d) => d !== ext));
  };

  return (
    <div className={`modes-artifact-list modes-artifact-list--${tone}`}>
      <div className="modes-artifact-add">
        <input
          className="modes-catalog-search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addExt(input);
            }
          }}
          placeholder={placeholder}
          aria-label={tone === "deny" ? "添加黑名单扩展名" : "添加白名单扩展名"}
        />
        <button type="button" className="btn" disabled={!input.trim()} onClick={() => addExt(input)}>
          添加
        </button>
        {selected.length > 0 ? (
          <button type="button" className="btn btn-ghost" onClick={() => onChange([])}>
            清空本侧
          </button>
        ) : null}
      </div>
      <div className="modes-artifact-chips" aria-label={tone === "deny" ? "黑名单" : "白名单"}>
        {selected.length === 0 ? (
          <div className="modes-catalog-empty">{emptyText}</div>
        ) : (
          selected.map((ext) => (
            <button
              key={ext}
              type="button"
              className={`modes-artifact-chip modes-artifact-chip--${tone}`}
              title={`点击移除 .${ext}`}
              onClick={() => removeExt(ext)}
            >
              .{ext}
              <span aria-hidden="true">×</span>
            </button>
          ))
        )}
      </div>
      <div className="modes-artifact-suggest">
        <span className="modes-artifact-presets-label">快速添加</span>
        {suggestions.map((ext) => {
          const on = selected.includes(ext);
          return (
            <button
              key={ext}
              type="button"
              className={`modes-artifact-suggest-btn${on ? " is-on" : ""}`}
              disabled={on}
              onClick={() => addExt(ext)}
            >
              .{ext}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 产物扩展名：黑名单 / 白名单分 tab 独立编辑（与 MCP 限制同构）。
 * 不与其它模式共用名单；切换顶栏模式即编辑该模式自己的 policy。
 */
function ArtifactPolicyEditor({
  value,
  onChange,
  mode,
}: {
  value: ModeArtifactPolicy;
  onChange: (next: ModeArtifactPolicy) => void;
  mode: WelcomeMode;
}): React.JSX.Element {
  const [sub, setSub] = useState<ArtifactAccessSubTab>("deny");
  const deny = value.deny;
  const allow = value.allow;

  /** 填入当前模式出厂默认（只改对应侧，不动另一侧） */
  const fillSeedSide = (side: ArtifactAccessSubTab): void => {
    if (side === "deny") {
      const seed = mode === "working" ? WORKING_ARTIFACT_DENY_DEFAULT : [];
      const seedSet = new Set(seed);
      onChange({
        ...value,
        deny: [...seed],
        // 互斥：deny 优先
        allow: allow.filter((a) => !seedSet.has(a)),
      });
      return;
    }
    // 出厂白名单默认皆空；提供「清空白名单」语义即可
    onChange({ ...value, allow: [] });
  };

  const setDeny = (nextDeny: string[]): void => {
    const denyKeys = new Set(nextDeny);
    onChange({
      ...value,
      deny: nextDeny,
      allow: allow.filter((a) => !denyKeys.has(a)),
    });
  };

  const setAllow = (nextAllow: string[]): void => {
    const allowKeys = new Set(nextAllow);
    onChange({
      ...value,
      allow: nextAllow,
      deny: deny.filter((d) => !allowKeys.has(d)),
    });
  };

  return (
    <div className="modes-artifact-editor">
      <div className="modes-access-bar">
        <div className="modes-access-tabs" role="tablist" aria-label="产物名单">
          <button
            type="button"
            role="tab"
            aria-selected={sub === "deny"}
            className={`modes-access-tab${sub === "deny" ? " active" : ""}`}
            onClick={() => setSub("deny")}
          >
            黑名单
            {deny.length ? <span className="modes-access-tab-n">{deny.length}</span> : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sub === "allow"}
            className={`modes-access-tab${sub === "allow" ? " active" : ""}`}
            onClick={() => setSub("allow")}
          >
            白名单
            {allow.length ? <span className="modes-access-tab-n">{allow.length}</span> : null}
          </button>
        </div>
        <div className="modes-mcp-mode-toggle" role="group" aria-label="产物过滤强度">
          <button
            type="button"
            className={`modes-mcp-mode-btn${value.mode === "hard" ? " active" : ""}`}
            onClick={() => onChange({ ...value, mode: "hard" })}
            title="命中名单的产物在面板中隐藏（不影响文件写入）"
          >
            hard
          </button>
          <button
            type="button"
            className={`modes-mcp-mode-btn${value.mode === "soft" ? " active" : ""}`}
            onClick={() => onChange({ ...value, mode: "soft" })}
            title="命中名单的产物在面板中隐藏（soft/hard 行为一致，保留兼容）"
          >
            soft
          </button>
        </div>
      </div>
      <p className="modes-access-one-liner">
        {sub === "deny"
          ? value.mode === "hard"
            ? "黑名单：命中扩展名的产物不在面板显示。不影响文件写入。与白名单互斥（勾进一侧会从另一侧移除）。"
            : "黑名单（soft）：面板隐藏命中产物，不影响文件写入。"
          : value.mode === "hard"
            ? "白名单：有勾选时仅显示这些扩展名的产物；全空 = 不启用。不影响文件写入。与黑名单互斥。"
            : "白名单（soft）：仅显示这些扩展名的产物，不影响文件写入。"}
      </p>
      <div className="modes-artifact-presets" role="group" aria-label="本侧出厂">
        <span className="modes-artifact-presets-label">本模式本侧</span>
        <button type="button" className="btn btn-ghost" onClick={() => fillSeedSide(sub)}>
          {sub === "deny" ? "填入本模式出厂黑名单" : "清空本模式白名单"}
        </button>
      </div>
      {sub === "deny" ? (
        <ArtifactExtListEditor
          tone="deny"
          selected={deny}
          onChange={setDeny}
          suggestions={ARTIFACT_DENY_SUGGESTIONS}
          emptyText="本模式暂无黑名单。代码开发通常为空；办公可隐藏 .py 等产物。"
          placeholder="输入要过滤的扩展名，如 py 或 .ts（支持逗号批量）"
        />
      ) : (
        <ArtifactExtListEditor
          tone="allow"
          selected={allow}
          onChange={setAllow}
          suggestions={ARTIFACT_ALLOW_SUGGESTIONS}
          emptyText="本模式暂未启用白名单（全空 = 不限制）。可添加 md/docx 等仅允许项。"
          placeholder="输入仅允许的扩展名，如 md 或 .docx（支持逗号批量）"
        />
      )}
    </div>
  );
}

function formatPolicy(policy: ModePolicyDto): string {
  return JSON.stringify(policy, null, 2);
}

function SourceBadge({
  source,
  dirty,
}: {
  source: string | null;
  dirty: boolean;
}): React.JSX.Element | null {
  if (dirty) {
    return <span className="modes-badge modes-badge--dirty">未保存</span>;
  }
  if (!source) return null;
  const isUser = source.includes("用户");
  return (
    <span className={`modes-badge ${isUser ? "modes-badge--user" : "modes-badge--seed"}`}>
      {source}
    </span>
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function keySet(keys: string[]): Set<string> {
  return new Set(keys.map((k) => k.trim().toLowerCase()).filter(Boolean));
}

function hasKey(selected: string[], key: string): boolean {
  const k = key.toLowerCase();
  return selected.some((s) => s.toLowerCase() === k);
}

function toggleKey(selected: string[], key: string, on: boolean): string[] {
  if (on) {
    if (hasKey(selected, key)) return selected;
    return [...selected, key];
  }
  return selected.filter((s) => s.toLowerCase() !== key.toLowerCase());
}

/** 合并目录项 + 策略里已不在目录中的孤儿键 */
function mergeCatalog(items: CatalogItem[], selectedKeys: string[]): CatalogItem[] {
  const byKey = new Map(items.map((i) => [i.key.toLowerCase(), i]));
  const out = [...items];
  for (const raw of selectedKeys) {
    const k = raw.trim();
    if (!k) continue;
    if (!byKey.has(k.toLowerCase())) {
      out.push({
        key: k,
        title: k,
        subtitle: "已不在当前列表（历史策略）",
        orphan: true,
      });
    }
  }
  return out;
}

/**
 * 从已加载目录勾选；禁止手输。
 * selected 存 item.key（技能 id / MCP name）。
 */
function CatalogPickList({
  label,
  items,
  selected,
  onChange,
  tone = "default",
  loading,
  emptyText,
  searchPlaceholder,
  fill = false,
}: {
  label: string;
  items: CatalogItem[];
  selected: string[];
  onChange: (next: string[]) => void;
  tone?: "default" | "allow" | "deny";
  loading?: boolean;
  emptyText?: string;
  searchPlaceholder?: string;
  /** 占满剩余高度（单列表场景） */
  fill?: boolean;
}): React.JSX.Element {
  const [q, setQ] = useState("");
  const selectedSet = useMemo(() => keySet(selected), [selected]);
  const merged = useMemo(() => mergeCatalog(items, selected), [items, selected]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return merged;
    return merged.filter(
      (i) =>
        i.key.toLowerCase().includes(needle) ||
        i.title.toLowerCase().includes(needle) ||
        (i.subtitle ?? "").toLowerCase().includes(needle),
    );
  }, [merged, q]);

  const allKeys = filtered.map((i) => i.key);
  const allOn = allKeys.length > 0 && allKeys.every((k) => selectedSet.has(k.toLowerCase()));

  return (
    <div className={`modes-catalog modes-catalog--${tone}${fill ? " modes-catalog--fill" : ""}`}>
      <div className="modes-catalog-toolbar">
        <input
          className="modes-catalog-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={searchPlaceholder ?? "筛选…"}
          aria-label={`${label} 筛选`}
        />
        <span className="modes-catalog-count">
          {selected.length}/{items.length || 0}
        </span>
        <button
          type="button"
          className="btn btn-ghost modes-catalog-bulk"
          disabled={!allKeys.length || loading}
          onClick={() => {
            if (allOn) {
              const drop = keySet(allKeys);
              onChange(selected.filter((s) => !drop.has(s.toLowerCase())));
            } else {
              let next = [...selected];
              for (const k of allKeys) {
                if (!hasKey(next, k)) next.push(k);
              }
              onChange(next);
            }
          }}
        >
          {allOn ? "取消全选" : "全选"}
        </button>
        {selected.length > 0 ? (
          <button type="button" className="btn btn-ghost modes-catalog-bulk" onClick={() => onChange([])}>
            清空
          </button>
        ) : null}
      </div>
      <div className="modes-catalog-list" role="listbox" aria-label={label} aria-multiselectable>
        {loading ? <div className="modes-catalog-empty">加载中…</div> : null}
        {!loading && filtered.length === 0 ? (
          <div className="modes-catalog-empty">{emptyText ?? "暂无项目"}</div>
        ) : null}
        {!loading
          ? filtered.map((item) => {
              const checked = selectedSet.has(item.key.toLowerCase());
              return (
                <label
                  key={item.key}
                  className={`modes-catalog-row${checked ? " is-checked" : ""}${
                    item.orphan ? " is-orphan" : ""
                  }${item.disabled ? " is-disabled" : ""}`}
                  title={[item.title, item.subtitle].filter(Boolean).join(" — ")}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={item.disabled}
                    onChange={(e) => onChange(toggleKey(selected, item.key, e.target.checked))}
                  />
                  <span className="modes-catalog-body">
                    <span className="modes-catalog-title">
                      <span className="modes-catalog-title-text">{item.title}</span>
                      {item.orphan ? <span className="modes-catalog-badge">历史</span> : null}
                      {item.disabled ? <span className="modes-catalog-badge">停用</span> : null}
                    </span>
                    {item.subtitle ? (
                      <span className="modes-catalog-sub" title={item.subtitle}>
                        {item.subtitle}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })
          : null}
      </div>
    </div>
  );
}

/**
 * 单个 Tag/Preset 的可视化编辑器：推荐专家/建议模型/建议权限/受管 MCP +
 * promptAddon + skillPolicy + mcpPolicy。所有改动走 onChange 上抛，由父级持有列表草稿。
 */
function PresetEditor({
  general = false,
  preset,
  idLocked,
  onChange,
  skillItems,
  mcpItems,
  managedMcpItems,
  expertItems,
  modelCatalog,
  catalogLoading,
}: {
  general?: boolean;
  preset: ModePresetDto;
  /** 出厂 seed preset 的 id 不可改（避免破坏 defaultModePresetId 解析） */
  idLocked: boolean;
  onChange: (next: ModePresetDto) => void;
  skillItems: CatalogItem[];
  mcpItems: CatalogItem[];
  managedMcpItems: CatalogItem[];
  expertItems: CatalogItem[];
  modelCatalog: ModelInfoDto[];
  catalogLoading: boolean;
}): React.JSX.Element {
  const [skillSub, setSkillSub] = useState<AccessSubTab>("allow");
  const [mcpSub, setMcpSub] = useState<AccessSubTab>("allow");
  const p = normalizePresetDraft(preset);
  const patch = (part: Partial<ModePresetDto>): void => onChange({ ...preset, ...part });
  const skill = normalizeSkillPolicy(p.skillPolicy);
  const mcp = normalizeMcpPolicy(p.mcpPolicy);
  const permission = p.suggestedPermissionMode;
  const modelOptions = useMemo(
    () => buildModelSuggestionOptions(p.suggestedModelId, modelCatalog),
    [p.suggestedModelId, modelCatalog],
  );

  if (general) return (
    <div className="modes-preset-form-body">
      <label className="modes-preset-field"><span>名称</span><input value={p.label} onChange={e => patch({ label: e.target.value })} /></label>
      <label className="modes-preset-field"><span>ID</span><input value={p.id} disabled={idLocked} onChange={e => patch({ id: e.target.value.trim() })} /></label>
      <label className="modes-preset-field"><span>描述</span><input value={p.description ?? ""} onChange={e => patch({ description: e.target.value })} /></label>
      <label className="modes-preset-field"><span>工具模式</span>
        <select aria-label="工具模式" value={p.durableToolMode ?? "native"} onChange={e => patch({ durableToolMode: e.target.value as "native" | "codemode" })}>
          <option value="native">原生模式</option><option value="codemode">Code Mode</option>
        </select>
      </label>
      <label className="modes-preset-field"><span>提示词附加段</span><textarea rows={8} value={p.promptAddon ?? ""} onChange={e => patch({ promptAddon: e.target.value })} /></label>
      <label className="modes-preset-field"><span>建议模型</span>
        <select value={p.suggestedModelId ?? ""} onChange={e => patch({ suggestedModelId: e.target.value || null })}>
          {modelOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <CatalogPickList label="推荐专家" items={expertItems} selected={p.recommendedExpertIds ?? []} onChange={next => patch({ recommendedExpertIds: next })} loading={catalogLoading} emptyText="暂无专家" searchPlaceholder="筛选专家…" />
      <p>两种工具模式均由 Pi Durable 执行、持久化和恢复。Tag 只提供配置与提示词。</p>
    </div>
  );

  return (
    <div className="modes-preset-form-body">
      <div className="modes-preset-section">
        <div className="modes-preset-section-title">基本信息</div>
        <div className="modes-preset-grid">
          <label className="modes-preset-field">
            <span className="modes-preset-field-label">名称（必填）</span>
            <input
              value={p.label}
              onChange={(e) => patch({ label: e.target.value })}
              placeholder="如：机械 CAD"
            />
          </label>
          <label className="modes-preset-field">
            <span className="modes-preset-field-label">ID{idLocked ? "（出厂预设，不可改）" : ""}</span>
            <input
              value={p.id}
              disabled={idLocked}
              onChange={(e) =>
                patch({ id: e.target.value.trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5-]+/g, "-") })
              }
              placeholder="如：web-prototype"
            />
          </label>
        </div>
        <label className="modes-preset-field">
          <span className="modes-preset-field-label">描述</span>
          <input value={p.description ?? ""} onChange={(e) => patch({ description: e.target.value })} />
        </label>
        <label className="modes-preset-field">
          <span className="modes-preset-field-label">
            Prompt 附加段（promptAddon，仅新会话生效）
          </span>
          <textarea
            rows={3}
            value={p.promptAddon ?? ""}
            onChange={(e) => patch({ promptAddon: e.target.value })}
            placeholder="在系统提示词末尾追加的场景职责说明…"
          />
        </label>
      </div>

      <div className="modes-preset-section">
        <div className="modes-preset-section-title">推荐配置（仅建议，不覆盖用户显式选择）</div>
        <div className="modes-preset-grid">
          <div className="modes-preset-field">
            <span className="modes-preset-field-label">建议模型（suggestedModelId）</span>
            <div className="modes-preset-select-row">
              <select
                value={p.suggestedModelId ?? ""}
                onChange={(e) => patch({ suggestedModelId: e.target.value || null })}
                aria-label="建议模型"
              >
                {modelOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {p.suggestedModelId ? (
                <button type="button" className="btn btn-ghost" onClick={() => patch({ suggestedModelId: null })}>
                  清除
                </button>
              ) : null}
            </div>
            <div className="modes-preset-field-note">
              {p.suggestedModelId
                ? isModelSuggestionAvailable(p.suggestedModelId, modelCatalog)
                  ? "运行时：用户显式选择 > Tag 建议 > Mode 默认"
                  : "⚠ 该模型当前不可用，会话会安全降级到默认模型，不阻塞任务"
                : "无建议：跟随默认模型"}
            </div>
          </div>
          <div className="modes-preset-field">
            <span className="modes-preset-field-label">建议权限（suggestedPermissionMode）</span>
            <select
              value={permission ?? ""}
              onChange={(e) =>
                patch({
                  suggestedPermissionMode: e.target.value
                    ? (e.target.value as "default" | "readonly" | "auto")
                    : null,
                })
              }
              aria-label="建议权限"
            >
              {PERMISSION_OPTIONS.map((o) => (
                <option key={o.value ?? "__none"} value={o.value ?? ""}>
                  {o.label}
                </option>
              ))}
            </select>
            <div className="modes-preset-field-note">
              {permission
                ? PERMISSION_OPTIONS.find((o) => o.value === permission)?.hint
                : "无建议：不覆盖用户显式选择（继承 Mode）"}
            </div>
          </div>
        </div>
        <div className="modes-preset-field">
          <span className="modes-preset-field-label">
            推荐专家（recommendedExpertIds，多选；已卸载专家显示「历史」可清除）
          </span>
          <CatalogPickList
            label="推荐专家"
            items={expertItems}
            selected={p.recommendedExpertIds ?? []}
            onChange={(next) => patch({ recommendedExpertIds: next })}
            loading={catalogLoading}
            emptyText="暂无已安装专家（Hub → 专家）"
            searchPlaceholder="筛选专家…"
          />
          <div className="modes-preset-field-note">
            仅为「推荐」语义：未激活的专家不会自动加载；新任务展示推荐入口时以 effective policy 合成为准。
          </div>
        </div>
        <div className="modes-preset-field">
          <span className="modes-preset-field-label">
            受管 MCP / 专业工具（providerMcpIds，多选；未配置/停用会使该 Tag 置灰）
          </span>
          <CatalogPickList
            label="受管 MCP"
            items={managedMcpItems}
            selected={p.providerMcpIds ?? []}
            onChange={(next) => patch({ providerMcpIds: next })}
            loading={catalogLoading}
            emptyText="暂无受管 MCP（Penpot / Draw.io AI）"
            searchPlaceholder="筛选 MCP…"
          />
          <div className="modes-preset-field-note">
            与下方「MCP 限制」不同：这里声明的是 Tag 依赖的受管服务（如 drawio-ai / penpot），
            用于可用性判断；「MCP 限制」才是会话级 allow/deny 白黑名单。
          </div>
        </div>
      </div>

      <div className="modes-preset-section">
        <div className="modes-preset-section-title">技能策略（skillPolicy，与 Mode 合成收窄）</div>
        <div className="modes-access-bar modes-access-bar--inline">
          <div className="modes-access-tabs" role="tablist" aria-label="预设技能策略">
            <button
              type="button"
              role="tab"
              aria-selected={skillSub === "deny"}
              className={`modes-access-tab${skillSub === "deny" ? " active" : ""}`}
              onClick={() => setSkillSub("deny")}
            >
              限制
              {skill.hide.length ? <span className="modes-access-tab-n">{skill.hide.length}</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={skillSub === "allow"}
              className={`modes-access-tab${skillSub === "allow" ? " active" : ""}`}
              onClick={() => setSkillSub("allow")}
            >
              白名单
              {skill.allow.length ? <span className="modes-access-tab-n">{skill.allow.length}</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={skillSub === "sort"}
              className={`modes-access-tab${skillSub === "sort" ? " active" : ""}`}
              onClick={() => setSkillSub("sort")}
            >
              排序
              {skill.prefer.length + skill.demote.length ? (
                <span className="modes-access-tab-n">{skill.prefer.length + skill.demote.length}</span>
              ) : null}
            </button>
          </div>
        </div>
        {skillSub === "deny" ? (
          <CatalogPickList
            label="预设技能限制"
            tone="deny"
            items={skillItems}
            selected={skill.hide}
            onChange={(next) => {
              const hideKeys = keySet(next);
              patch({ skillPolicy: normalizeSkillPolicy({ ...skill, hide: next, allow: skill.allow.filter((a) => !hideKeys.has(a.toLowerCase())) }) });
            }}
            loading={catalogLoading}
            emptyText="暂无已安装技能"
            searchPlaceholder="筛选技能…"
          />
        ) : null}
        {skillSub === "allow" ? (
          <CatalogPickList
            label="预设技能白名单"
            tone="allow"
            items={skillItems}
            selected={skill.allow}
            onChange={(next) => {
              const allowKeys = keySet(next);
              patch({ skillPolicy: normalizeSkillPolicy({ ...skill, allow: next, hide: skill.hide.filter((h) => !allowKeys.has(h.toLowerCase())) }) });
            }}
            loading={catalogLoading}
            emptyText="暂无已安装技能"
            searchPlaceholder="筛选技能…"
          />
        ) : null}
        {skillSub === "sort" ? (
          <div className="modes-access-sort">
            <CatalogPickList
              label="预设技能推荐"
              items={skillItems}
              selected={skill.prefer}
              onChange={(next) => patch({ skillPolicy: normalizeSkillPolicy({ ...skill, prefer: next }) })}
              loading={catalogLoading}
              emptyText="暂无已安装技能"
              searchPlaceholder="筛选…"
            />
            <CatalogPickList
              label="预设技能降权"
              items={skillItems}
              selected={skill.demote}
              onChange={(next) => patch({ skillPolicy: normalizeSkillPolicy({ ...skill, demote: next }) })}
              loading={catalogLoading}
              emptyText="暂无已安装技能"
              searchPlaceholder="筛选…"
            />
          </div>
        ) : null}
      </div>

      <div className="modes-preset-section">
        <div className="modes-preset-section-title">MCP 策略（mcpPolicy，与 Mode 合成收窄）</div>
        <div className="modes-access-bar modes-access-bar--inline">
          <div className="modes-access-tabs" role="tablist" aria-label="预设 MCP 策略">
            <button
              type="button"
              role="tab"
              aria-selected={mcpSub === "deny"}
              className={`modes-access-tab${mcpSub === "deny" ? " active" : ""}`}
              onClick={() => setMcpSub("deny")}
            >
              限制
              {mcp.deny.length ? <span className="modes-access-tab-n">{mcp.deny.length}</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mcpSub === "allow"}
              className={`modes-access-tab${mcpSub === "allow" ? " active" : ""}`}
              onClick={() => setMcpSub("allow")}
            >
              白名单
              {mcp.allow.length ? <span className="modes-access-tab-n">{mcp.allow.length}</span> : null}
            </button>
          </div>
          <div className="modes-mcp-mode-toggle" role="group" aria-label="预设 MCP 强度">
            <button
              type="button"
              className={`modes-mcp-mode-btn${mcp.mode === "hard" ? " active" : ""}`}
              onClick={() => patch({ mcpPolicy: { ...mcp, mode: "hard" } })}
              title="本会话不加载"
            >
              hard
            </button>
            <button
              type="button"
              className={`modes-mcp-mode-btn${mcp.mode === "soft" ? " active" : ""}`}
              onClick={() => patch({ mcpPolicy: { ...mcp, mode: "soft" } })}
              title="仅标记"
            >
              soft
            </button>
          </div>
        </div>
        {mcpSub === "deny" ? (
          <CatalogPickList
            label="预设 MCP 限制"
            tone="deny"
            items={mcpItems}
            selected={mcp.deny}
            onChange={(next) => {
              const denyKeys = keySet(next);
              patch({ mcpPolicy: { ...mcp, deny: next, allow: mcp.allow.filter((a) => !denyKeys.has(a.toLowerCase())) } });
            }}
            loading={catalogLoading}
            emptyText="暂无 MCP"
            searchPlaceholder="筛选 MCP…"
          />
        ) : (
          <CatalogPickList
            label="预设 MCP 白名单"
            tone="allow"
            items={mcpItems}
            selected={mcp.allow}
            onChange={(next) => {
              const allowKeys = keySet(next);
              patch({ mcpPolicy: { ...mcp, allow: next, deny: mcp.deny.filter((d) => !allowKeys.has(d.toLowerCase())) } });
            }}
            loading={catalogLoading}
            emptyText="暂无 MCP"
            searchPlaceholder="筛选 MCP…"
          />
        )}
      </div>
    </div>
  );
}

export default function ModesTab(): React.JSX.Element {
  const [mode, setMode] = useState<WelcomeMode>("working");
  const [pane, setPane] = useState<EditPane>("goal");
  useEffect(() => {
    if (mode === "general" && ["skills", "mcp", "artifacts", "policy"].includes(pane)) setPane("goal");
  }, [mode, pane]);
  const [profile, setProfile] = useState<ModeProfileDto | null>(null);
  const visiblePresetCount = sanitizeModePresets(mode, profile?.policy.presets ?? []).length;
  const [draft, setDraft] = useState("");
  const [skillDraft, setSkillDraft] = useState<ModeSkillPolicy>(emptyModePolicy().skillPolicy);
  const [mcpDraft, setMcpDraft] = useState<ModeMcpPolicy>(emptyModePolicy().mcpPolicy);
  const [artifactDraft, setArtifactDraft] = useState<ModeArtifactPolicy>(
    emptyModePolicy().artifactPolicy,
  );
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [trace, setTrace] = useState<AssemblyTraceDto | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [skillFilterOn, setSkillFilterOn] = useState(true);
  const [summaries, setSummaries] = useState<ModeProfileSummaryDto[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<SkillDto[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<McpServerDto[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [skillSub, setSkillSub] = useState<AccessSubTab>("deny");
  const [mcpSub, setMcpSub] = useState<AccessSubTab>("deny");
  const [expertCatalog, setExpertCatalog] = useState<ExpertDto[]>([]);
  const [modelCatalog, setModelCatalog] = useState<ModelInfoDto[]>([]);
  /** Tag/Preset 列表草稿（pane === "presets" 时持有；保存时整体写回 policy.presets） */
  const [presetList, setPresetList] = useState<ModePresetDto[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  /** 待确认操作：统一走 ConfirmDialog（新风格），替代原生 window.confirm */
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: "switch-pane"; next: EditPane }
    | { kind: "switch-mode"; next: WelcomeMode }
    | { kind: "reset-current" }
    | { kind: "reset-all" }
    | { kind: "delete-preset" }
    | null
  >(null);

  const refreshCatalogs = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const [skills, servers, experts, models] = await Promise.all([
        window.api?.agent?.listSkills?.() ?? Promise.resolve([] as SkillDto[]),
        window.api?.mcp?.listServers?.() ?? Promise.resolve([] as McpServerDto[]),
        window.api?.agent?.listExperts?.() ?? Promise.resolve([] as ExpertDto[]),
        window.api?.agent?.listModels?.() ?? Promise.resolve([] as ModelInfoDto[]),
      ]);
      setSkillCatalog(Array.isArray(skills) ? skills : []);
      setMcpCatalog(Array.isArray(servers) ? servers : []);
      setExpertCatalog(Array.isArray(experts) ? experts : []);
      setModelCatalog(Array.isArray(models) ? models : []);
    } catch (err) {
      setErrorMsg(errText(err));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const skillItems: CatalogItem[] = useMemo(
    () =>
      skillCatalog
        .filter((s) => !isRetiredDesignSkill(s.id || s.name))
        .map((s) => ({
          key: s.id || s.name,
          title: s.name || s.id,
          subtitle: [s.enabled === false ? "已停用" : null, s.description, s.author]
            .filter(Boolean)
            .join(" · "),
          disabled: s.enabled === false,
        })),
    [skillCatalog],
  );

  const mcpItems: CatalogItem[] = useMemo(
    () =>
      mcpCatalog.map((s) => ({
        key: s.name,
        title: s.name,
        // 完整信息留给悬停 title；过长 endpoint 由 CSS ellipsis 截断，避免撑出横向滚动
        subtitle: [
          s.installed ? "已安装" : "候选",
          s.disabled ? "全局停用" : null,
          s.transport,
          s.endpoint,
          s.sourceId,
        ]
          .filter(Boolean)
          .join(" · "),
        disabled: s.disabled,
      })),
    [mcpCatalog],
  );

  /** 受管 runtime 名单：已下线桌面软件（blender 等）不进 Tag 的 providerMcpIds 勾选。 */
  const managedMcpItems: CatalogItem[] = useMemo(
    () => mcpItems.filter((item) => !isRetiredManagedProvider(item.key)),
    [mcpItems],
  );

  const expertItems: CatalogItem[] = useMemo(
    () =>
      expertCatalog.map((e) => ({
        key: e.id,
        title: e.name,
        // 描述可能很长，完整串靠 CSS 截断 + 行 title 悬停查看
        subtitle: [e.enabled === false ? "已停用" : "已安装", e.author, e.description]
          .filter(Boolean)
          .join(" · "),
        disabled: e.enabled === false,
      })),
    [expertCatalog],
  );

  const applyProfileToDraft = (p: ModeProfileDto, nextPane: EditPane): void => {
    if (nextPane === "policy") {
      setDraft(formatPolicy(p.policy));
    } else if (nextPane === "skills") {
      const skill = normalizeSkillPolicy(p.policy.skillPolicy);
      setSkillDraft({
        ...skill,
        prefer: skill.prefer.filter((id) => !isRetiredDesignSkill(id)),
        demote: skill.demote.filter((id) => !isRetiredDesignSkill(id)),
        hide: skill.hide.filter((id) => !isRetiredDesignSkill(id)),
        allow: skill.allow.filter((id) => !isRetiredDesignSkill(id)),
      });
    } else if (nextPane === "mcp") {
      setMcpDraft(normalizeMcpPolicy(p.policy.mcpPolicy));
    } else if (nextPane === "artifacts") {
      setArtifactDraft(normalizeArtifactPolicy(p.policy.artifactPolicy));
    } else if (nextPane === "presets") {
      const presets = sanitizeModePresets(
        mode,
        (p.policy.presets ?? [])
          .filter((item) => !isRetiredModePresetId(mode, item.id))
          .map((item) => {
            const draft = normalizePresetDraft(item);
            return {
              ...draft,
              providerMcpIds: (draft.providerMcpIds ?? []).filter((id) => !isRetiredManagedProvider(id)),
            };
          }),
      );
      setPresetList(presets);
      const preferred = defaultModePresetId(mode);
      setSelectedPresetId((cur) => {
        if (cur && presets.some((x) => x.id === cur)) return cur;
        if (presets.some((x) => x.id === preferred)) return preferred;
        return presets[0]?.id ?? null;
      });
    } else {
      setDraft(p.blocks.find((b) => b.id === nextPane)?.content ?? "");
    }
  };

  const refreshSummaries = useCallback(async () => {
    try {
      const list = await window.api?.agent?.listModeProfiles?.();
      if (list) setSummaries(list);
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async (id: WelcomeMode, nextPane: EditPane) => {
    setLoading(true);
    setErrorMsg("");
    try {
      const p = await window.api?.agent?.getModeProfile?.(id);
      if (!p) {
        setErrorMsg("无法加载模式配置（主进程未就绪）");
        setProfile(null);
        return;
      }
      setProfile(p);
      applyProfileToDraft(p, nextPane);
      setDirty(false);
    } catch (err) {
      setErrorMsg(errText(err));
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(mode, pane);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    void window.api?.agent?.getAppSettings?.().then((s) => {
      if (s && typeof s.skillModeFilterEnabled === "boolean") {
        setSkillFilterOn(s.skillModeFilterEnabled);
      }
    });
    void refreshSummaries();
    void refreshCatalogs();
  }, [refreshSummaries, refreshCatalogs]);

  useEffect(() => {
    if (pane === "skills" || pane === "mcp" || pane === "presets") {
      void refreshCatalogs();
    }
  }, [pane, refreshCatalogs]);

  const applyPaneSwitch = (next: EditPane): void => {
    setPane(next);
    if (profile) applyProfileToDraft(profile, next);
    setDirty(false);
    setHint("");
    setErrorMsg("");
  };

  const selectPane = (next: EditPane): void => {
    if (!profile) {
      setPane(next);
      return;
    }
    if (dirty) {
      setPendingConfirm({ kind: "switch-pane", next });
      return;
    }
    applyPaneSwitch(next);
  };

  const selectMode = (id: WelcomeMode): void => {
    if (id === mode) return;
    if (dirty) {
      setPendingConfirm({ kind: "switch-mode", next: id });
      return;
    }
    setMode(id);
    setHint("");
    setErrorMsg("");
  };

  const currentSource = useMemo(() => {
    if (!profile) return null;
    if (
      pane === "policy" ||
      pane === "skills" ||
      pane === "mcp" ||
      pane === "artifacts" ||
      pane === "presets"
    ) {
      return profile.hasUserOverride ? "可能含用户覆盖" : "出厂默认";
    }
    return profile.blocks.find((b) => b.id === pane)?.source === "user" ? "用户覆盖" : "出厂默认";
  }, [profile, pane]);

  const isBlockPane = MODE_BLOCK_IDS.includes(pane as ModeBlockId);
  /** 非文案块（能力面/高级） */
  const isPolicyPane = pane === "policy";
  /** 打开文件按钮只对文案块与 policy.json 有意义 */
  const canOpenFile = isBlockPane || isPolicyPane;

  const draftChars = useMemo(() => {
    if (pane === "skills") {
      return JSON.stringify(skillDraft).length;
    }
    if (pane === "mcp") {
      return JSON.stringify(mcpDraft).length;
    }
    if (pane === "artifacts") {
      return JSON.stringify(artifactDraft).length;
    }
    if (pane === "presets") {
      return JSON.stringify(presetList).length;
    }
    return draft.length;
  }, [pane, draft, skillDraft, mcpDraft, artifactDraft, presetList]);

  const save = async (): Promise<void> => {
    if (!profile) return;
    setSaving(true);
    setErrorMsg("");
    setHint("");
    try {
      let next: ModeProfileDto | undefined;
      if (pane === "policy") {
        let parsed: ModePolicyDto;
        try {
          parsed = JSON.parse(draft) as ModePolicyDto;
        } catch {
          throw new Error("策略 JSON 无法解析，请检查语法");
        }
        next = await window.api?.agent?.saveModePolicy?.(mode, parsed);
      } else if (pane === "skills") {
        const merged: ModePolicyDto = {
          ...profile.policy,
          skillPolicy: normalizeSkillPolicy(skillDraft),
          mcpPolicy: normalizeMcpPolicy(profile.policy.mcpPolicy),
        };
        next = await window.api?.agent?.saveModePolicy?.(mode, merged);
      } else if (pane === "mcp") {
        const merged: ModePolicyDto = {
          ...profile.policy,
          skillPolicy: normalizeSkillPolicy(profile.policy.skillPolicy),
          mcpPolicy: normalizeMcpPolicy(mcpDraft),
        };
        next = await window.api?.agent?.saveModePolicy?.(mode, merged);
      } else if (pane === "artifacts") {
        const merged: ModePolicyDto = {
          ...profile.policy,
          artifactPolicy: normalizeArtifactPolicy(artifactDraft),
        };
        next = await window.api?.agent?.saveModePolicy?.(mode, merged);
      } else if (pane === "presets") {
        // 整体写回 presets 数组（含推荐专家/模型/权限/受管 MCP），base 字段原样保留
        next = await window.api?.agent?.saveModePolicy?.(mode, applyPresetsToPolicy(profile.policy, presetList));
      } else {
        next = await window.api?.agent?.saveModeBlock?.(mode, pane, draft);
      }
      if (!next) throw new Error("保存失败");
      setProfile(next);
      applyProfileToDraft(next, pane);
      setDirty(false);
      setHint("已保存。将在新任务中生效（已有对话不会自动重载场景模板）。");
      void refreshSummaries();
    } catch (err) {
      setErrorMsg(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const resetCurrent = async (): Promise<void> => {
    if (!profile) return;
    setSaving(true);
    setErrorMsg("");
    try {
      // skills / mcp / artifacts / presets 是 policy 的一部分，恢复整份 policy（与 JSON 策略一致）
      const next =
        pane === "policy" ||
        pane === "skills" ||
        pane === "mcp" ||
        pane === "artifacts" ||
        pane === "presets"
          ? await window.api?.agent?.resetModePolicy?.(mode)
          : await window.api?.agent?.resetModeBlock?.(mode, pane);
      if (!next) throw new Error("恢复失败");
      setProfile(next);
      applyProfileToDraft(next, pane);
      setDirty(false);
      setHint(
        pane === "skills" || pane === "mcp" || pane === "artifacts" || pane === "presets"
          ? "已恢复本模式全部策略（含技能/MCP/产物/工具/场景/预设）为出厂默认。"
          : "已恢复为出厂默认。",
      );
      void refreshSummaries();
    } catch (err) {
      setErrorMsg(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const resetAll = async (): Promise<void> => {
    setSaving(true);
    setErrorMsg("");
    try {
      const next = await window.api?.agent?.resetModeProfile?.(mode);
      if (!next) throw new Error("恢复失败");
      setProfile(next);
      applyProfileToDraft(next, pane);
      setDirty(false);
      setHint("已恢复本模式全部为出厂默认。");
      void refreshSummaries();
    } catch (err) {
      setErrorMsg(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const openDir = async (): Promise<void> => {
    try {
      const dir = await window.api?.agent?.openModesDir?.(mode);
      setHint(dir ? `已打开目录：${dir}` : "已请求打开目录");
    } catch (err) {
      setErrorMsg(errText(err));
    }
  };

  const currentFilePath = useMemo(() => {
    if (!profile) return null;
    if (pane === "policy") return profile.policyPath ?? null;
    if (pane === "skills" || pane === "mcp" || pane === "artifacts" || pane === "presets") return null;
    return profile.blocks.find((b) => b.id === pane)?.filePath ?? null;
  }, [profile, pane]);

  const openCurrentFile = async (): Promise<void> => {
    if (pane === "skills" || pane === "mcp" || pane === "artifacts" || pane === "presets") {
      await openDir();
      return;
    }
    // 文案块必须开 .md；策略才开 policy.json
    const target: ModeBlockId | "policy" = pane === "policy" ? "policy" : pane;
    if (!window.api?.agent?.openModeFile) {
      setErrorMsg("主进程未提供 openModeFile，请重启应用后再试");
      return;
    }
    try {
      const path = await window.api.agent.openModeFile(mode, target);
      const name = path?.split(/[/\\]/).pop() ?? "";
      setHint(
        path
          ? `已打开文案文件：${name}（${path}）`
          : "已请求打开文件",
      );
    } catch (err) {
      setErrorMsg(errText(err));
    }
  };

  /** 展示用相对路径 */
  const displayFilePath = useMemo(() => {
    if (!currentFilePath) return null;
    const home = currentFilePath.match(/^[A-Za-z]:\\Users\\[^\\]+\\(.*)$/);
    if (home) return `~\\${home[1].replace(/\\/g, "/")}`;
    const unix = currentFilePath.match(/^\/Users\/[^/]+\/(.*)$/);
    if (unix) return `~/${unix[1]}`;
    return currentFilePath;
  }, [currentFilePath]);

  const previewAssembly = async (): Promise<void> => {
    setErrorMsg("");
    // P2：未保存修改时预览只反映已保存配置 —— 禁用并提示，避免 UI 误导
    const blockedHint = previewBlockedHint(dirty);
    if (blockedHint) {
      setHint(blockedHint);
      return;
    }
    try {
      // P3-1：预览携带当前编辑的 Tag/preset + 当前任务上下文（cwd/专家/连接器），
      // 与真实 createSession 尽量同源；设置页无任务时至少带 modePresetId。
      const activeTaskId = useAppStore.getState().activeTaskId;
      const activeTask = activeTaskId
        ? useAppStore.getState().tasks.find((t) => t.id === activeTaskId)
        : undefined;
      const t = await window.api?.agent?.assembleModePreview?.({
        welcomeMode: mode,
        modePresetId: selectedPreset?.id ?? selectedPresetId,
        expertId: activeTask?.expertId ?? null,
        connectorIds: activeTask?.connectorIds,
        cwd: activeTask?.cwd,
      });
      if (!t) throw new Error("预览失败");
      setTrace(t);
      setPreviewOpen(true);
      const mcpHidden = t.mcpFilter?.hidden?.length ?? 0;
      const scopeNote = selectedPreset?.id
        ? `Tag「${selectedPreset.label}」`
        : "基础 Mode 策略（未选 Tag）";
      setHint(
        `装配预览（${scopeNote}，仅新任务生效）：约 ${t.totalChars} 字 · 技能隐藏 ${t.skillFilter.hidden.length} · MCP 隐藏 ${mcpHidden}${t.warnings.length > 0 ? ` · 警告 ${t.warnings.length} 条` : ""}`,
      );
    } catch (err) {
      setErrorMsg(errText(err));
    }
  };

  const toggleSkillFilter = async (on: boolean): Promise<void> => {
    setSkillFilterOn(on);
    try {
      await window.api?.agent?.updateAppSettings?.({ skillModeFilterEnabled: on });
      setHint(on ? "已开启：技能按场景过滤" : "已关闭：技能不按场景过滤");
    } catch (err) {
      setErrorMsg(errText(err));
    }
  };

  const markSkillDirty = (next: ModeSkillPolicy): void => {
    setSkillDraft(next);
    setDirty(true);
    setHint("");
  };

  const markMcpDirty = (next: ModeMcpPolicy): void => {
    setMcpDraft(next);
    setDirty(true);
    setHint("");
  };

  const markArtifactDirty = (next: ModeArtifactPolicy): void => {
    setArtifactDraft(normalizeArtifactPolicy(next));
    setDirty(true);
    setHint("");
  };

  const markPresetsDirty = (next: ModePresetDto[]): void => {
    setPresetList(next);
    setDirty(true);
    setHint("");
  };

  const selectedPreset = useMemo(
    () => presetList.find((p) => p.id === selectedPresetId) ?? null,
    [presetList, selectedPresetId],
  );

  const updateSelectedPreset = (next: ModePresetDto): void => {
    const idx = presetList.findIndex((p) => p.id === selectedPresetId);
    if (idx < 0) return;
    // id 冲突保护：与其它 preset 重名时拒绝（savePolicy 的 validatePolicy 会拒绝重复 id）
    if (
      next.id.trim() &&
      next.id !== selectedPresetId &&
      presetList.some((p) => p.id === next.id)
    ) {
      return;
    }
    const out = [...presetList];
    out[idx] = next;
    if (next.id !== selectedPresetId) setSelectedPresetId(next.id);
    markPresetsDirty(out);
  };

  const addPreset = (): void => {
    const id = suggestPresetId("新预设", presetList);
    markPresetsDirty([...presetList, normalizePresetDraft({ id, label: "新预设" })]);
    setSelectedPresetId(id);
  };

  const deleteSelectedPreset = (): void => {
    if (!selectedPreset) return;
    // 出厂预设不可删除：ModeProfileStore 读时会把缺失 seed 合并还原，删除只会造成“假删除”
    if (isSeedPreset(mode, selectedPreset.id)) {
      setHint(`「${selectedPreset.label}」是出厂预设（seed），不可删除；内容可编辑。`);
      return;
    }
    setPendingConfirm({ kind: "delete-preset" });
  };

  const applyDeleteSelectedPreset = (): void => {
    if (!selectedPreset) return;
    const rest = removePreset(presetList, selectedPreset.id);
    markPresetsDirty(rest);
    setSelectedPresetId(rest[0]?.id ?? null);
  };

  /** 白名单与限制互斥：勾进一边则从另一边移除 */
  const setSkillAllow = (allow: string[]): void => {
    const allowKeys = keySet(allow);
    markSkillDirty({
      ...skillDraft,
      allow,
      hide: skillDraft.hide.filter((h) => !allowKeys.has(h.toLowerCase())),
    });
  };
  const setSkillHide = (hide: string[]): void => {
    const hideKeys = keySet(hide);
    markSkillDirty({
      ...skillDraft,
      hide,
      allow: skillDraft.allow.filter((a) => !hideKeys.has(a.toLowerCase())),
    });
  };
  const setSkillPrefer = (prefer: string[]): void => {
    markSkillDirty({ ...skillDraft, prefer });
  };
  const setSkillDemote = (demote: string[]): void => {
    markSkillDirty({ ...skillDraft, demote });
  };
  const setMcpAllow = (allow: string[]): void => {
    const allowKeys = keySet(allow);
    markMcpDirty({
      ...mcpDraft,
      allow,
      deny: mcpDraft.deny.filter((d) => !allowKeys.has(d.toLowerCase())),
    });
  };
  const setMcpDeny = (deny: string[]): void => {
    const denyKeys = keySet(deny);
    markMcpDirty({
      ...mcpDraft,
      deny,
      allow: mcpDraft.allow.filter((a) => !denyKeys.has(a.toLowerCase())),
    });
  };

  const showEditor = Boolean(profile) && !loading;

  return (
    <div className={`modes-tab${previewOpen ? " modes-tab--preview-open" : ""}`}>
      <header className="modes-header">
        <p className="modes-header-desc">
          文案与策略落在 <code>~/.mybuddy/modes/&lt;模式&gt;/</code>
          （<code>goal.md</code> 等 + <code>policy.json</code>），可直接用外部编辑器改。
          <strong>仅对新任务生效</strong>。
        </p>
      </header>

      <div className="modes-switcher" role="tablist" aria-label="模式与提示词">
        {WELCOME_MODES.map((id) => {
          const active = mode === id;
          const fromSummary = summaries.find((s) => s.id === id)?.hasUserOverride;
          const hasOverride =
            fromSummary ?? (profile?.id === id ? profile.hasUserOverride : false);
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`modes-switch-item modes-switch-item--${id}${active ? " active" : ""}`}
              onClick={() => selectMode(id)}
            >
              <WelcomeModeIcon mode={id} size={16} />
              <span className="modes-switch-label">{WELCOME_MODE_LABELS[id]}</span>
              {hasOverride ? <span className="modes-override-dot" title="含用户自定义" /> : null}
            </button>
          );
        })}
      </div>

      {errorMsg ? (
        <div className="modes-banner modes-banner--err" role="alert">
          <IconAlert size={14} />
          <span>{errorMsg}</span>
        </div>
      ) : null}

      {hint ? (
        <div className="modes-banner modes-banner--ok" role="status">
          <IconCheck size={14} />
          <span>{hint}</span>
        </div>
      ) : null}

      {loading && !profile ? <div className="modes-empty">加载中…</div> : null}

      {!loading && !profile ? (
        <div className="modes-empty">
          未能加载场景资料。
          <button type="button" className="btn" style={{ marginLeft: 10 }} onClick={() => void load(mode, pane)}>
            重试
          </button>
        </div>
      ) : null}

      {showEditor && profile ? (
        <>
          <div className="modes-toolbar">
            <div className="modes-meta">
              <span className="modes-meta-chip">v{profile.version}</span>
              <span className="modes-meta-chip">{profile.totalChars} 字</span>
              <span
                className={`modes-meta-chip ${
                  profile.hasUserOverride ? "modes-meta-chip--user" : "modes-meta-chip--seed"
                }`}
              >
                {profile.hasUserOverride ? "已自定义" : "出厂默认"}
              </span>
            </div>
            <div className="modes-toolbar-actions">
              <label className="modes-switch" title="按场景隐藏/排序已安装技能">
                <input
                  type="checkbox"
                  checked={skillFilterOn}
                  onChange={(e) => void toggleSkillFilter(e.target.checked)}
                />
                <span className="modes-switch-track" aria-hidden="true" />
                <span className="modes-switch-text">技能过滤</span>
              </label>
              <div className="modes-toolbar-sep" aria-hidden="true" />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void previewAssembly()}
                disabled={dirty}
                title={dirty ? (previewBlockedHint(dirty) ?? "有未保存修改") : "预览当前模式装配（基于已保存配置）"}
              >
                预览装配
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void openDir()} title="打开本模式文件夹">
                <IconFolder size={14} />
                文件夹
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setPendingConfirm({ kind: "reset-all" })}
                disabled={saving}
              >
                <IconRotate size={14} />
                全部恢复
              </button>
            </div>
          </div>

          <div className="modes-main">
          <div className="modes-workspace">
            <nav className="modes-nav" aria-label="场景块">
              <div className="modes-nav-group">
                <div className="modes-nav-label">文案</div>
                {MODE_BLOCK_IDS.map((id) => {
                  const isUser = profile.blocks.find((b) => b.id === id)?.source === "user";
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`modes-nav-item${pane === id ? " active" : ""}`}
                      onClick={() => selectPane(id)}
                    >
                      <span className="modes-nav-icon">{paneIcon(id)}</span>
                      <span className="modes-nav-text">{MODE_BLOCK_LABELS[id]}</span>
                      {isUser ? <span className="modes-override-dot" title="用户覆盖" /> : null}
                    </button>
                  );
                })}
              </div>
              <div className="modes-nav-group">
                <div className="modes-nav-label">能力面</div>
                {mode !== "general" && <>
                <button
                  type="button"
                  className={`modes-nav-item${pane === "skills" ? " active" : ""}`}
                  onClick={() => selectPane("skills")}
                >
                  <span className="modes-nav-icon">{paneIcon("skills")}</span>
                  <span className="modes-nav-text">技能限制</span>
                </button>
                <button
                  type="button"
                  className={`modes-nav-item${pane === "mcp" ? " active" : ""}`}
                  onClick={() => selectPane("mcp")}
                >
                  <span className="modes-nav-icon">{paneIcon("mcp")}</span>
                  <span className="modes-nav-text">MCP 限制</span>
                </button>
                <button
                  type="button"
                  className={`modes-nav-item${pane === "artifacts" ? " active" : ""}`}
                  onClick={() => selectPane("artifacts")}
                >
                  <span className="modes-nav-icon">{paneIcon("artifacts")}</span>
                  <span className="modes-nav-text">产物限制</span>
                  {(profile.policy.artifactPolicy?.deny?.length ?? 0) +
                  (profile.policy.artifactPolicy?.allow?.length ?? 0) ? (
                    <span className="modes-nav-tag">
                      {(profile.policy.artifactPolicy?.deny?.length ?? 0) +
                        (profile.policy.artifactPolicy?.allow?.length ?? 0)}
                    </span>
                  ) : null}
                </button>
                </>}
                <button
                  type="button"
                  className={`modes-nav-item${pane === "presets" ? " active" : ""}`}
                  onClick={() => selectPane("presets")}
                >
                  <span className="modes-nav-icon">{paneIcon("presets")}</span>
                  <span className="modes-nav-text">预设 / Tags</span>
                  {visiblePresetCount ? <span className="modes-nav-tag">{visiblePresetCount}</span> : null}
                </button>
              </div>
              {mode !== "general" && <div className="modes-nav-group">
                <div className="modes-nav-label">高级</div>
                <button
                  type="button"
                  className={`modes-nav-item${pane === "policy" ? " active" : ""}`}
                  onClick={() => selectPane("policy")}
                >
                  <span className="modes-nav-icon">{paneIcon("policy")}</span>
                  <span className="modes-nav-text">策略</span>
                  <span className="modes-nav-tag">JSON</span>
                </button>
              </div>}
            </nav>

            <div
              className={`modes-editor${
                pane === "skills" || pane === "mcp" || pane === "artifacts"
                  ? " modes-editor--access"
                  : pane === "presets"
                    ? " modes-editor--presets"
                    : ""
              }`}
            >
              <div className="modes-editor-head">
                <div className="modes-editor-title-row">
                  <div className="modes-editor-title">
                    <span className="modes-editor-icon">{paneIcon(pane, 16)}</span>
                    <div className="modes-editor-title-text">
                      <div className="modes-editor-name">{PANE_LABELS[pane]}</div>
                      {!isPolicyPane ? (
                        <div className="modes-editor-hint">{PANE_HINTS[pane]}</div>
                      ) : null}
                    </div>
                  </div>
                  <div className="modes-editor-status">
                    <SourceBadge source={currentSource} dirty={dirty} />
                    {canOpenFile ? (
                      <span className="modes-char-count">{draftChars} 字</span>
                    ) : null}
                  </div>
                </div>
                <div className="modes-editor-actions">
                  {canOpenFile ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={saving || loading}
                      onClick={() => void openCurrentFile()}
                      title={currentFilePath ?? "打开磁盘文件"}
                    >
                      <IconFile size={14} />
                      打开文件
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={saving || loading}
                    onClick={() => setPendingConfirm({ kind: "reset-current" })}
                  >
                    <IconRotate size={14} />
                    恢复
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={saving || loading || !dirty}
                    onClick={() => void save()}
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>

              {displayFilePath && canOpenFile ? (
                <div className="modes-file-bar" title={currentFilePath ?? undefined}>
                  <IconFile size={12} />
                  <code className="modes-file-path">{displayFilePath}</code>
                  <button type="button" className="btn btn-ghost modes-file-open" onClick={() => void openCurrentFile()}>
                    打开
                  </button>
                </div>
              ) : null}

              {pane === "presets" ? (
                <div className="modes-preset-layout">
                  <div className="modes-preset-rail">
                    <div className="modes-preset-rail-head">
                      <span className="modes-preset-rail-title">Tag / 预设</span>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={saving}
                        onClick={addPreset}
                        title="新增一个自定义 Tag">
                        ＋ 新增
                      </button>
                    </div>
                    <div className="modes-preset-rail-list">
                      {presetList.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`modes-preset-rail-item${p.id === selectedPresetId ? " active" : ""}`}
                          onClick={() => setSelectedPresetId(p.id)}
                        >
                          <span className="modes-preset-rail-name">{p.label}</span>
                          <span className="modes-preset-rail-id">{p.id}</span>
                        </button>
                      ))}
                      {presetList.length === 0 ? (
                        <div className="modes-catalog-empty">暂无预设，点「＋ 新增」创建</div>
                      ) : null}
                    </div>
                  </div>
                  <div className="modes-preset-form">
                    {selectedPreset ? (
                      <>
                        <div className="modes-preset-form-head">
                          <span className="modes-preset-form-name">{selectedPreset.label}</span>
                          <span className="modes-preset-form-id">{selectedPreset.id}</span>
                          {!isPresetDraftValid(selectedPreset) ? (
                            <span className="modes-badge modes-badge--dirty">需名称与 ID</span>
                          ) : null}
                          <button
                            type="button"
                            className="btn btn-ghost danger-ghost"
                            disabled={saving || isSeedPreset(mode, selectedPreset.id)}
                            title={
                              isSeedPreset(mode, selectedPreset.id)
                                ? "出厂预设不可删除（读时会被还原）；自定义预设可删除"
                                : undefined
                            }
                            onClick={() => void deleteSelectedPreset()}
                          >
                            {isSeedPreset(mode, selectedPreset.id) ? "出厂预设（不可删）" : "删除此预设"}
                          </button>
                        </div>
                        <PresetEditor
                          general={mode === "general"}
                          preset={selectedPreset}
                          idLocked={isSeedPreset(mode, selectedPreset.id)}
                          onChange={updateSelectedPreset}
                          skillItems={skillItems}
                          mcpItems={mcpItems}
                          managedMcpItems={managedMcpItems}
                          expertItems={expertItems}
                          modelCatalog={modelCatalog}
                          catalogLoading={catalogLoading}
                        />
                      </>
                    ) : (
                      <div className="modes-catalog-empty">选择左侧预设开始编辑</div>
                    )}
                  </div>
                </div>
              ) : null}

              {pane === "skills" ? (
                <div className="modes-access-panel">
                  <div className="modes-access-bar">
                    <div className="modes-access-tabs" role="tablist" aria-label="技能策略">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={skillSub === "deny"}
                        className={`modes-access-tab${skillSub === "deny" ? " active" : ""}`}
                        onClick={() => setSkillSub("deny")}
                      >
                        限制
                        {skillDraft.hide.length ? (
                          <span className="modes-access-tab-n">{skillDraft.hide.length}</span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={skillSub === "allow"}
                        className={`modes-access-tab${skillSub === "allow" ? " active" : ""}`}
                        onClick={() => setSkillSub("allow")}
                      >
                        白名单
                        {skillDraft.allow.length ? (
                          <span className="modes-access-tab-n">{skillDraft.allow.length}</span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={skillSub === "sort"}
                        className={`modes-access-tab${skillSub === "sort" ? " active" : ""}`}
                        onClick={() => setSkillSub("sort")}
                      >
                        排序
                        {skillDraft.prefer.length + skillDraft.demote.length ? (
                          <span className="modes-access-tab-n">
                            {skillDraft.prefer.length + skillDraft.demote.length}
                          </span>
                        ) : null}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost modes-catalog-reload"
                      onClick={() => void refreshCatalogs()}
                      disabled={catalogLoading}
                    >
                      {catalogLoading ? "…" : "刷新"}
                    </button>
                  </div>
                  <p className="modes-access-one-liner">
                    {skillSub === "deny"
                      ? "勾选后对本模式隐藏。需开启顶部「技能过滤」。"
                      : skillSub === "allow"
                        ? "有勾选时仅这些技能可见；全不勾 = 不限制白名单。"
                        : "软排序：推荐靠前、降权靠后，不隐藏。"}
                  </p>
                  {skillSub === "deny" ? (
                    <CatalogPickList
                      label="限制"
                      tone="deny"
                      items={skillItems}
                      selected={skillDraft.hide}
                      onChange={setSkillHide}
                      loading={catalogLoading}
                      emptyText="暂无已安装技能（Hub → 技能）"
                      searchPlaceholder="筛选技能…"
                      fill
                    />
                  ) : null}
                  {skillSub === "allow" ? (
                    <CatalogPickList
                      label="白名单"
                      tone="allow"
                      items={skillItems}
                      selected={skillDraft.allow}
                      onChange={setSkillAllow}
                      loading={catalogLoading}
                      emptyText="暂无已安装技能（Hub → 技能）"
                      searchPlaceholder="筛选技能…"
                      fill
                    />
                  ) : null}
                  {skillSub === "sort" ? (
                    <div className="modes-access-sort">
                      <CatalogPickList
                        label="推荐"
                        items={skillItems}
                        selected={skillDraft.prefer}
                        onChange={setSkillPrefer}
                        loading={catalogLoading}
                        emptyText="暂无已安装技能"
                        searchPlaceholder="筛选…"
                      />
                      <CatalogPickList
                        label="降权"
                        items={skillItems}
                        selected={skillDraft.demote}
                        onChange={setSkillDemote}
                        loading={catalogLoading}
                        emptyText="暂无已安装技能"
                        searchPlaceholder="筛选…"
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {pane === "mcp" ? (
                <div className="modes-access-panel">
                  <div className="modes-access-bar">
                    <div className="modes-access-tabs" role="tablist" aria-label="MCP 策略">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={mcpSub === "deny"}
                        className={`modes-access-tab${mcpSub === "deny" ? " active" : ""}`}
                        onClick={() => setMcpSub("deny")}
                      >
                        限制
                        {mcpDraft.deny.length ? (
                          <span className="modes-access-tab-n">{mcpDraft.deny.length}</span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={mcpSub === "allow"}
                        className={`modes-access-tab${mcpSub === "allow" ? " active" : ""}`}
                        onClick={() => setMcpSub("allow")}
                      >
                        白名单
                        {mcpDraft.allow.length ? (
                          <span className="modes-access-tab-n">{mcpDraft.allow.length}</span>
                        ) : null}
                      </button>
                    </div>
                    <div className="modes-mcp-mode-toggle" role="group" aria-label="MCP 强度">
                      <button
                        type="button"
                        className={`modes-mcp-mode-btn${mcpDraft.mode === "hard" ? " active" : ""}`}
                        onClick={() => markMcpDirty({ ...mcpDraft, mode: "hard" })}
                        title="本会话不加载"
                      >
                        hard
                      </button>
                      <button
                        type="button"
                        className={`modes-mcp-mode-btn${mcpDraft.mode === "soft" ? " active" : ""}`}
                        onClick={() => markMcpDirty({ ...mcpDraft, mode: "soft" })}
                        title="仅标记"
                      >
                        soft
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost modes-catalog-reload"
                      onClick={() => void refreshCatalogs()}
                      disabled={catalogLoading}
                    >
                      {catalogLoading ? "…" : "刷新"}
                    </button>
                  </div>
                  <p className="modes-access-one-liner">
                    {mcpSub === "deny"
                      ? mcpDraft.mode === "hard"
                        ? "勾选的 MCP 不会加载到本会话。"
                        : "soft：仍加载，仅记录限制。"
                      : "有勾选时仅这些 MCP 进入本会话；全不勾 = 不限制白名单。"}
                  </p>
                  {mcpSub === "deny" ? (
                    <CatalogPickList
                      label="限制"
                      tone="deny"
                      items={mcpItems}
                      selected={mcpDraft.deny}
                      onChange={setMcpDeny}
                      loading={catalogLoading}
                      emptyText="暂无 MCP（Hub → MCP 安装）"
                      searchPlaceholder="筛选 MCP…"
                      fill
                    />
                  ) : (
                    <CatalogPickList
                      label="白名单"
                      tone="allow"
                      items={mcpItems}
                      selected={mcpDraft.allow}
                      onChange={setMcpAllow}
                      loading={catalogLoading}
                      emptyText="暂无 MCP（Hub → MCP 安装）"
                      searchPlaceholder="筛选 MCP…"
                      fill
                    />
                  )}
                </div>
              ) : null}

              {pane === "artifacts" ? (
                <div className="modes-access-panel">
                  <ArtifactPolicyEditor
                    value={artifactDraft}
                    onChange={markArtifactDirty}
                    mode={mode}
                  />
                </div>
              ) : null}

              {isBlockPane || isPolicyPane ? (
                <textarea
                  className={`modes-textarea${pane === "policy" ? " modes-textarea--code" : ""}`}
                  value={draft}
                  spellCheck={pane !== "policy"}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDirty(true);
                    setHint("");
                  }}
                  placeholder={
                    pane === "policy"
                      ? "skillPolicy / mcpPolicy / artifactPolicy / toolPolicy / scenes 等 JSON…"
                      : "在此编辑场景说明（Markdown）…"
                  }
                />
              ) : null}
            </div>
          </div>

          {previewOpen && trace ? (
            <section className="modes-preview">
              <div className="modes-preview-head">
                <div className="modes-preview-title">
                  <strong>装配检视</strong>
                  <span className="modes-meta-chip">
                    {trace.totalChars} 字 · {trace.segments.length} 段
                  </span>
                  <span className="modes-meta-chip">
                    技能可见 {trace.skillFilter.visible.length} / 隐藏 {trace.skillFilter.hidden.length}
                  </span>
                  {trace.mcpFilter ? (
                    <span className="modes-meta-chip">
                      MCP 启用 {trace.mcpFilter.enabled.length} / 隐藏 {trace.mcpFilter.hidden.length}
                    </span>
                  ) : null}
                </div>
                <div className="modes-preview-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(trace.appendParts.join("\n\n---\n\n"));
                      setHint("已复制装配全文");
                    }}
                  >
                    复制全文
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setPreviewOpen(false)}>
                    收起
                  </button>
                </div>
              </div>
              {trace.warnings.length > 0 ||
              (trace.mcpFilter?.hidden?.length ?? 0) > 0 ||
              (trace.skillFilter.allow?.length ?? 0) > 0 ||
              (trace.skillFilter.hide?.length ?? 0) > 0 ||
              (trace.mcpFilter && trace.mcpPolicy) ? (
                <details className="modes-preview-meta">
                  <summary>
                    <IconAlert size={13} />
                    <span>
                      策略与过滤摘要
                      {trace.warnings.length > 0 ? ` · ${trace.warnings.length} 条警告` : ""}
                    </span>
                  </summary>
                  <div className="modes-preview-meta-body">
                    {trace.warnings.length > 0 ? (
                      <div className="modes-banner modes-banner--warn">
                        <IconAlert size={14} />
                        <span>{trace.warnings.join("；")}</span>
                      </div>
                    ) : null}
                    {(trace.mcpFilter?.hidden?.length ?? 0) > 0 ||
                    (trace.skillFilter.allow?.length ?? 0) > 0 ||
                    (trace.skillFilter.hide?.length ?? 0) > 0 ||
                    (trace.mcpFilter && trace.mcpPolicy) ? (
                      <div className="modes-access-summary">
                        {trace.skillFilter.allow?.length ? (
                          <div>技能白名单：{trace.skillFilter.allow.join(", ")}</div>
                        ) : null}
                        {trace.skillFilter.hide?.length ? (
                          <div>技能限制：{trace.skillFilter.hide.join(", ")}</div>
                        ) : null}
                        {trace.mcpPolicy ? (
                          <div>
                            MCP 策略 {trace.mcpPolicy.mode}
                            {trace.mcpPolicy.allow.length
                              ? ` · allow ${trace.mcpPolicy.allow.join(", ")}`
                              : ""}
                            {trace.mcpPolicy.deny.length
                              ? ` · deny ${trace.mcpPolicy.deny.join(", ")}`
                              : ""}
                          </div>
                        ) : null}
                        {trace.mcpFilter?.hidden?.length ? (
                          <div>MCP 本会话隐藏：{trace.mcpFilter.hidden.join(", ")}</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}
              <div className="modes-preview-segments">
                {trace.segments.map((s) => (
                  <details key={s.id} className="modes-preview-seg">
                    <summary>
                      <span className="modes-preview-seg-title">{s.title}</span>
                      <span className="modes-meta-chip">{s.source}</span>
                      <span className="modes-meta-chip">{s.chars} 字</span>
                    </summary>
                    <pre>{s.content}</pre>
                  </details>
                ))}
              </div>
            </section>
          ) : null}
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={pendingConfirm?.kind === "switch-pane"}
        title="放弃未保存修改？"
        body="当前有未保存修改，切换页签将丢弃这些修改。"
        confirmLabel="放弃修改"
        danger
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const target = pendingConfirm;
          setPendingConfirm(null);
          if (target?.kind === "switch-pane") applyPaneSwitch(target.next);
        }}
      />
      <ConfirmDialog
        open={pendingConfirm?.kind === "switch-mode"}
        title="放弃未保存修改？"
        body="当前有未保存修改，切换模式将丢弃这些修改。"
        confirmLabel="放弃修改"
        danger
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const target = pendingConfirm;
          setPendingConfirm(null);
          if (target?.kind === "switch-mode") {
            setMode(target.next);
            setHint("");
            setErrorMsg("");
          }
        }}
      />
      <ConfirmDialog
        open={pendingConfirm?.kind === "reset-current"}
        title={`将「${WELCOME_MODE_LABELS[mode]}」的「${PANE_LABELS[pane]}」恢复为出厂默认？`}
        body="恢复后当前配置会被出厂默认覆盖，此操作不可撤销。"
        confirmLabel="恢复默认"
        danger
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          setPendingConfirm(null);
          void resetCurrent();
        }}
      />
      <ConfirmDialog
        open={pendingConfirm?.kind === "reset-all"}
        title={`将「${WELCOME_MODE_LABELS[mode]}」全部文案与策略恢复为出厂默认？`}
        body="用户覆盖文件将被删除，此操作不可撤销。"
        confirmLabel="全部恢复"
        danger
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          setPendingConfirm(null);
          void resetAll();
        }}
      />
      <ConfirmDialog
        open={pendingConfirm?.kind === "delete-preset"}
        title={selectedPreset ? `删除预设「${selectedPreset.label}」（${selectedPreset.id}）？` : "删除预设？"}
        body="该预设将从当前模式的预设列表中移除，保存后生效。"
        confirmLabel="删除"
        danger
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          setPendingConfirm(null);
          applyDeleteSelectedPreset();
        }}
      />
    </div>
  );
}
