import { UiIcon, type UiIconName } from "@mybuddy/shared/icons";
import { DesktopSectionRow, DesktopSectionSidebar } from "@/components/desktop/DesktopSection";
import { APP_VERSION } from "@shared/app-version";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import { useAppStore, type SettingsTab } from "@/store/appStore";
import type {
  FileBackupInfoDto,
  ModelInfoDto,
} from "@shared/agent-ipc";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import {
  IconClock,
  IconFile,
  IconFolder,
  IconGrid,
  IconPlus,
  IconRefresh,
  IconShare,
  IconShield,
  IconX,
} from "@/components/common/icons";
import "./RecordManagement.css";
import ModelsTab from "./ModelsTab";
import WeixinGatewaySettings from "./WeixinGatewaySettings";
import QQGatewaySettings from "./QQGatewaySettings";
import GatewayBlock from "./GatewayChannelSettings";
import BusinessGatewayRegistration from "./BusinessGatewayRegistration";
import SubagentSettingsTab from "./SubagentSettingsTab";
import ModesTab from "./ModesTab";
import MemoryTab from "./MemoryTab";
import MaterialRetrievalTab from "./MaterialRetrievalTab";
import DotsSettingsTab from "./DotsSettingsTab";
import NativeHooksTab from "./NativeHooksTab";
import NativeImprovementTab from "./NativeImprovementTab";
import CapabilitiesTab from "./CapabilitiesTab";
import RemoteAccessTab from "./RemoteAccessTab";
import ArchivesTab from "./ArchivesTab";
import PythonRuntimeTab from "./PythonRuntimeTab";
import AcpTab from "./AcpTab";
import type { UserFontDto } from "@shared/agent-ipc";
import CompactionSettingsControl from "./CompactionSettingsControl";
import DesktopAppearanceControls from "./DesktopAppearanceControls";
import { CODE_THEME_OPTIONS, DEFAULT_CODE_THEME, normalizeCodeTheme, type CodeThemeId } from "@shared/code-theme";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
  type NotificationPreferencesDto,
} from "@shared/notification";
import {
  applyFontSettings,
  ensureAllUserFontsLoaded,
  ensureUserFontLoaded,
  getAppliedFontSettings,
  READING_FONT_FAMILY,
  resolveFontSettings,
  unloadUserFont,
  userFontCssFamily,
  type AppliedFontSettings,
} from "@/lib/fontSettings";
import { type DesktopAppearance } from "@shared/desktop-theme";
import {
  DEFAULT_NAVIGATION_FONT,
  NAVIGATION_FONT_ROLES,
  NAVIGATION_FONT_WEIGHTS,
  REPLY_FONT_WEIGHTS,
  REPLY_LINE_HEIGHTS,
  REPLY_PARAGRAPH_GAPS,
  UI_FONT_WEIGHTS,
  type NavigationFont,
  type NavigationFontRole,
  type ReplyLayout,
} from "@shared/typography";

const TABS: Array<{ id: SettingsTab; glyph: UiIconName; label: string }> = [
  { id: "system", glyph: "settings", label: "系统设置" },
  { id: "extensions", glyph: "tools", label: "工具能力" },
  { id: "modes", glyph: "modes", label: "模式与提示词" },
  { id: "personalize", glyph: "personalize", label: "个性化" },
  { id: "memory", glyph: "memory", label: "记忆" },
  { id: "materialRetrieval", glyph: "retrieval", label: "资料检索" },
  { id: "dots", glyph: "pi", label: "Dots 设置" },
  { id: "nativeHooks", glyph: "hooks", label: "执行钩子" },
  { id: "nativeImprovement", glyph: "improvement", label: "自我改进" },
  { id: "archive", glyph: "archive", label: "归档管理" },
  { id: "models", glyph: "models", label: "模型" },
  { id: "subagent", glyph: "subagents", label: "子代理设置" },
  { id: "assistant", glyph: "settings-assistant", label: "助理设置" },
  { id: "acp", glyph: "acp", label: "ACP 管理" },
  { id: "data", glyph: "data", label: "数据管理" },
  { id: "python", glyph: "python", label: "Python 运行时" },
  { id: "shortcuts", glyph: "shortcuts", label: "快捷键" },
  { id: "notifications", glyph: "notifications", label: "通知" },
  { id: "remote", glyph: "remote", label: "远程连接" },
  { id: "security", glyph: "settings-security", label: "安全中心" },
  { id: "help", glyph: "help", label: "帮助与反馈" },
];

/** 内容区分区卡片：标题 + 描述 + 行条目容器（透明底 + 细边框，清新风格） */
function SettingsSection({
  title,
  desc,
  children,
}: {
  title?: string;
  desc?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="settings-section">
      {(title || desc) && (
        <div className="settings-section-head">
          {title && <div className="settings-section-title">{title}</div>}
          {desc && <div className="settings-section-desc">{desc}</div>}
        </div>
      )}
      <div className="settings-section-card">{children}</div>
    </section>
  );
}


function Toggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`switch ${on ? "on" : ""}`}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!on);
      }}
    />
  );
}

function Row({
  label,
  desc,
  children,
}: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">{label}</div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

type FontTarget = "uiFontFamily" | "codeFontFamily" | "replyFontFamily";

const FONT_SIZES = Array.from({ length: 13 }, (_, index) => index + 12);
const FONT_WEIGHT_LABELS = { 400: "常规", 500: "中等", 600: "半粗", 700: "粗体" };
const NAVIGATION_FONT_LABELS = { menu: "菜单", workspace: "空间名称", task: "任务名称" };
const REPLY_LINE_HEIGHT_LABELS = { 1.5: "紧凑", 1.7: "标准", 1.95: "舒展" };
const REPLY_PARAGRAPH_GAP_LABELS = { 0.55: "紧凑", 0.85: "标准", 1.2: "舒展" };
const CHAT_WIDTH_LABELS = { narrow: "窄栏", standard: "标准", wide: "宽栏" };

function FontSizeSelect({ label, value, max, allowInherit, onChange, disabled }: {
  label: string;
  value: number | null;
  max: number;
  allowInherit?: boolean;
  onChange: (size: number | null) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <select className="settings-input typography-value-select" aria-label={label} value={value ?? ""} disabled={disabled}
      onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}>
      {allowInherit && <option value="">跟随界面</option>}
      {FONT_SIZES.filter((size) => size <= max).map((size) => <option key={size} value={size}>{size} px</option>)}
    </select>
  );
}

type FontPickerOption = {
  id: string;
  label: string;
  family: string;
  source: "default" | "system" | "imported";
  importedFont?: UserFontDto;
};

function FontPicker({
  value,
  options,
  placeholder,
  label,
  onSelect,
  disabled,
}: {
  value: string;
  options: FontPickerOption[];
  placeholder: string;
  label: string;
  onSelect: (option: FontPickerOption) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const selected = options.find((option) => option.family === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return options;
    return options.filter((option) => option.label.toLocaleLowerCase().includes(q));
  }, [options, query]);

  return (
    <div className={`typography-font-picker${open ? " open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="typography-font-picker-trigger"
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
        aria-expanded={open}
      >
        <span className="typography-font-picker-value" style={{ fontFamily: value || undefined }}>
          {selected?.label ?? (value || placeholder)}
        </span>
        <span className="typography-font-picker-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="typography-font-picker-popover">
          <div className="typography-font-picker-search-wrap">
            <input
              autoFocus
              className="typography-font-picker-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索字体"
            />
          </div>
          <div className="typography-font-picker-list thin-scrollbar">
            {filtered.length === 0 ? (
              <div className="typography-font-picker-empty">没有匹配的字体</div>
            ) : (
              filtered.map((option, index) => {
                const previous = filtered[index - 1];
                const showGroup = index === 0 || previous?.source !== option.source;
                const groupLabel = option.source === "default"
                  ? "默认"
                  : option.source === "imported"
                    ? "已导入"
                    : "系统字体";
                return (
                  <div key={option.id}>
                    {showGroup && <div className="typography-font-picker-group">{groupLabel}</div>}
                    <button
                      type="button"
                      className={`typography-font-picker-option${option.family === value ? " selected" : ""}`}
                      onClick={() => {
                        onSelect(option);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <span className="typography-font-picker-option-name" style={{ fontFamily: option.family || undefined }}>
                        {option.label}
                      </span>
                      {option.family === value && <span className="typography-font-picker-check">✓</span>}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function SystemTab(): React.JSX.Element {
  const theme = useAppStore(s => s.theme);
  const appearance = useAppStore(s => s.desktopAppearance);
  const setDesktopAppearance = useAppStore(s => s.setDesktopAppearance);
  const [typography, setTypography] = useState(getAppliedFontSettings);
  const { uiFontSize, codeFontSize, uiFontFamily, codeFontFamily, replyFontFamily, replyFontSize, uiFontWeight, replyFontWeight, navigationTypography, replyLayout } = typography;
  const [codeTheme, setCodeTheme] = useState<CodeThemeId>(DEFAULT_CODE_THEME);
  const [userFonts, setUserFonts] = useState<UserFontDto[]>([]);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [systemFontsLoading, setSystemFontsLoading] = useState(true);
  const [systemFontsError, setSystemFontsError] = useState("");
  const [language, setLanguage] = useState("zh-CN");
  const [proxyUrl, setProxyUrl] = useState("");
  const [closeToTray, setCloseToTray] = useState(true);
  const [residentHostEnabled, setResidentHostEnabled] = useState(false);
  const [hint, setHint] = useState("");
  const [fontHint, setFontHint] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [fontBusy, setFontBusy] = useState(true);
  const [appearanceBusy, setAppearanceBusy] = useState(false);
  const [appearanceError, setAppearanceError] = useState("");
  const [confirmRemoveFont, setConfirmRemoveFont] = useState<UserFontDto | null>(null);
  const [diskSpace, setDiskSpace] = useState<import("@shared/agent-ipc").DiskSpaceDto | null>(null);

  const refreshUserFonts = useCallback(async (): Promise<UserFontDto[]> => {
    const list = (await window.api?.agent?.listUserFonts?.()) ?? [];
    setUserFonts(list);
    await ensureAllUserFontsLoaded(list);
    return list;
  }, []);

  const refreshSystemFonts = useCallback(async (): Promise<void> => {
    setSystemFontsLoading(true);
    setSystemFontsError("");
    try {
      const fn = window.api?.agent?.listSystemFonts;
      if (!fn) {
        setSystemFonts([]);
        setSystemFontsError("主进程字体接口未加载，请完整重启应用");
        return;
      }
      const installed = await fn();
      setSystemFonts(installed ?? []);
      if (!installed?.length) setSystemFontsError("未读取到系统字体");
    } catch (err) {
      setSystemFonts([]);
      setSystemFontsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSystemFontsLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refreshSystemFonts();
    void (async () => {
      try {
        const [settings, fonts, disk] = await Promise.all([
          window.api?.agent?.getAppSettings?.(),
          window.api?.agent?.listUserFonts?.() ?? Promise.resolve([]),
          window.api?.agent?.getDiskSpace?.(),
        ]);
        await ensureAllUserFontsLoaded(fonts ?? []);
        if (!active) return;
        setUserFonts(fonts ?? []);
        if (disk) setDiskSpace(disk);
        if (!settings) return;

        const nextCodeTheme = normalizeCodeTheme(settings.codeTheme);

        setLanguage(settings.language || "zh-CN");
        setProxyUrl(settings.proxyUrl || "");
        setCloseToTray(settings.closeToTray !== false);
        setResidentHostEnabled(settings.residentHostEnabled === true);
        setTypography(applyFontSettings(resolveFontSettings(settings)));
        setCodeTheme(nextCodeTheme);
        document.documentElement.dataset.codeTheme = nextCodeTheme;
      } catch (err) {
        if (active) setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setFontBusy(false);
      }
    })();
    return () => { active = false; };
  }, [refreshSystemFonts]);

  const fontOptions = useMemo((): FontPickerOption[] => {
    const imported = userFonts.map((font) => ({
      id: `imported:${font.id}`,
      label: font.family,
      family: userFontCssFamily(font.family),
      source: "imported" as const,
      importedFont: font,
    }));
    const importedFamilies = new Set(imported.map((option) => option.family.toLocaleLowerCase()));
    const installed = systemFonts
      .map((name) => ({
        id: `system:${name}`,
        label: name,
        family: userFontCssFamily(name),
        source: "system" as const,
      }))
      .filter((option) => !importedFamilies.has(option.family.toLocaleLowerCase()));
    return [
      { id: "default", label: "系统默认", family: "", source: "default" as const },
      ...imported,
      ...installed,
    ];
  }, [systemFonts, userFonts]);

  const codeFontOptions = useMemo((): FontPickerOption[] => {
    const [defaultOption, ...rest] = fontOptions;
    return [
      { ...(defaultOption ?? { id: "default", label: "系统默认", family: "", source: "default" as const }), label: "系统等宽" },
      ...rest,
    ];
  }, [fontOptions]);

  const replyFontOptions = useMemo((): FontPickerOption[] => [
    { id: "inherit", label: "跟随界面", family: "", source: "default" },
    { id: "reading", label: "衬线阅读（Claude 风格）", family: READING_FONT_FAMILY, source: "default" },
    ...fontOptions.slice(1),
  ], [fontOptions]);

  const navigationFontOptions = useMemo((): FontPickerOption[] => [
    { id: "inherit", label: "跟随界面", family: "", source: "default" },
    ...fontOptions.slice(1),
  ], [fontOptions]);

  const codeThemePreviewVariants = useMemo<Array<"light" | "dark">>(() => {
    const option = CODE_THEME_OPTIONS.find((item) => item.id === codeTheme);
    return option?.mode === "dark" ? ["dark"] : ["light", "dark"];
  }, [codeTheme]);

  const persistTypography = async (partial: Partial<AppliedFontSettings>): Promise<void> => {
    const previous = getAppliedFontSettings();
    setFontBusy(true);
    setFontHint("保存中…");
    setErrorMsg("");
    try {
      const update = window.api?.agent?.updateAppSettings;
      if (!update) throw new Error("字体设置保存接口未就绪");
      setTypography(applyFontSettings(partial));
      await update(partial);
      setFontHint("已自动保存");
    } catch (err) {
      setTypography(applyFontSettings(previous));
      setFontHint("");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setFontBusy(false);
    }
  };

  const loadFontOption = async (option: FontPickerOption): Promise<boolean> => {
    if (option.importedFont) {
      try {
        await ensureUserFontLoaded(option.importedFont);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        return false;
      }
    }
    return true;
  };

  const selectFontOption = async (target: FontTarget, option: FontPickerOption): Promise<void> => {
    if (await loadFontOption(option)) await persistTypography({ [target]: option.family });
  };

  const updateNavigationFont = (role: NavigationFontRole, partial: Partial<NavigationFont>): Promise<void> => {
    const current = getAppliedFontSettings().navigationTypography;
    return persistTypography({
      navigationTypography: { ...current, [role]: { ...(current[role] ?? DEFAULT_NAVIGATION_FONT), ...partial } },
    });
  };

  const selectNavigationFont = async (role: NavigationFontRole, option: FontPickerOption): Promise<void> => {
    if (await loadFontOption(option)) await updateNavigationFont(role, { family: option.family });
  };

  const updateReplyLayout = (partial: Partial<ReplyLayout>): Promise<void> =>
    persistTypography({ replyLayout: { ...getAppliedFontSettings().replyLayout, ...partial } });

  const changeAppearance = async (partial: Partial<DesktopAppearance>): Promise<void> => {
    const previous = useAppStore.getState().desktopAppearance;
    const next = { ...previous, ...partial };
    setAppearanceBusy(true);
    setAppearanceError("");
    setDesktopAppearance(next);
    try {
      const update = window.api?.agent?.updateAppSettings;
      if (!update) throw new Error("主题设置保存接口未就绪");
      await update({ desktopAppearance: next, theme: next.mode });
    } catch (err) {
      setDesktopAppearance(previous);
      setAppearanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setAppearanceBusy(false);
    }
  };

  const importUserFont = async (): Promise<void> => {
    setFontBusy(true);
    setErrorMsg("");
    setFontHint("正在导入…");
    try {
      const importFn = window.api?.agent?.importUserFont;
      if (!importFn) throw new Error("导入接口未就绪，请完全退出并重新启动应用后再试");
      const imported = await importFn();
      if (!imported) {
        setFontHint("");
        return;
      }
      await unloadUserFont(imported.id);
      await ensureUserFontLoaded(imported);
      await refreshUserFonts();
      applyFontSettings({});
      setFontHint(`「${imported.family}」已永久保存到字体库`);
    } catch (err) {
      setFontHint("");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setFontBusy(false);
    }
  };

  const removeFont = async (font: UserFontDto): Promise<void> => {
    setFontBusy(true);
    setErrorMsg("");
    try {
      const family = userFontCssFamily(font.family);
      const agent = window.api?.agent;
      if (!agent?.removeUserFont || !agent.updateAppSettings) throw new Error("字体设置接口未就绪");
      const reset: Partial<AppliedFontSettings> = {};
      const current = getAppliedFontSettings();
      for (const target of ["uiFontFamily", "codeFontFamily", "replyFontFamily"] as const) {
        if (current[target] === family) reset[target] = "";
      }
      for (const role of NAVIGATION_FONT_ROLES) {
        const override = current.navigationTypography[role];
        if (override?.family === family) {
          reset.navigationTypography ??= { ...current.navigationTypography };
          reset.navigationTypography[role] = { ...override, family: "" };
        }
      }
      if (Object.keys(reset).length) {
        await agent.updateAppSettings(reset);
        setTypography(applyFontSettings(reset));
      }
      const list = await agent.removeUserFont(font.id);
      await unloadUserFont(font.id);
      setUserFonts(list);
      setFontHint(`已删除「${font.family}」`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setFontBusy(false);
    }
  };

  const changeLanguage = async (next: string): Promise<void> => {
    const previous = language;
    setLanguage(next);
    setErrorMsg("");
    try {
      await window.api?.agent?.updateAppSettings?.({ language: next });
      setHint("显示语言已保存");
    } catch (err) {
      setLanguage(previous);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const changeCodeTheme = async (next: CodeThemeId): Promise<void> => {
    const previous = codeTheme;
    setCodeTheme(next);
    document.documentElement.dataset.codeTheme = next;
    setErrorMsg("");
    try {
      await window.api?.agent?.updateAppSettings?.({ codeTheme: next });
    } catch (err) {
      setCodeTheme(previous);
      document.documentElement.dataset.codeTheme = previous;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const saveProxy = async (): Promise<void> => {
    setErrorMsg("");
    try {
      await window.api?.agent?.updateAppSettings?.({ proxyUrl });
      setHint("代理设置已保存");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const usagePercent =
    diskSpace && diskSpace.totalBytes > 0
      ? ((diskSpace.usedBytes / diskSpace.totalBytes) * 100).toFixed(1)
      : "--";

  const toggleCloseToTray = async (v: boolean): Promise<void> => {
    setCloseToTray(v);
    try {
      await window.api?.agent?.updateAppSettings?.({ closeToTray: v });
      setHint(v ? "已开启：点击关闭按钮将最小化到系统托盘" : "已关闭最小化到托盘");
    } catch (err) {
      setCloseToTray(!v);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };


  return (
    <div className="system-settings-v4">
      <SettingsSection title="常规">
        <Row label="显示语言" desc="应用程序界面语言">
          <select className="pill-select" value={language} onChange={(event) => void changeLanguage(event.target.value)}>
            <option value="zh-CN">中文(简体)</option>
            <option value="en">English</option>
          </select>
        </Row>
        <Row label="关闭时最小化到托盘" desc="关闭窗口后后台继续运行；托盘图标可恢复，菜单可退出。">
          <Toggle on={closeToTray} onChange={(v) => void toggleCloseToTray(v)} />
        </Row>
        <Row label="退出界面后保持助理在线" desc="由本机常驻进程继续任务、提醒和渠道回复。本机关机或断网时暂停；托盘菜单可停止助理。">
          <Toggle on={residentHostEnabled} onChange={(enabled) => {
            setResidentHostEnabled(enabled);
            void window.api?.agent.updateAppSettings({ residentHostEnabled: enabled }).catch(error => {
              setResidentHostEnabled(!enabled);
              setErrorMsg(error instanceof Error ? error.message : String(error));
            });
          }} />
        </Row>
      </SettingsSection>

      <SettingsSection title="主题">
        <DesktopAppearanceControls appearance={appearance} theme={theme} disabled={appearanceBusy || fontBusy}
          onChange={(partial) => void changeAppearance(partial)} />
        {appearanceError && <div className="settings-hint err" role="alert">{appearanceError}</div>}
      </SettingsSection>

      <SettingsSection
        title="字体"
      >
        <div className="typography-flat-layout">
          <div className="typography-flat-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">界面字体</div>
              <div className="settings-row-desc">用于输入框，也是菜单和侧栏的默认字体</div>
            </div>
            <FontPicker label="界面字体" value={uiFontFamily} options={fontOptions} placeholder="系统默认" onSelect={(option) => void selectFontOption("uiFontFamily", option)} disabled={fontBusy} />
          </div>

          <div className="typography-flat-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">界面字号与粗细</div>
            </div>
            <div className="typography-controls">
              <FontSizeSelect label="界面字号" value={uiFontSize} max={20} disabled={fontBusy}
                onChange={(size) => size !== null && void persistTypography({ uiFontSize: size })} />
              <select className="settings-input typography-value-select" aria-label="界面粗细" value={uiFontWeight} disabled={fontBusy}
                onChange={(event) => void persistTypography({ uiFontWeight: event.target.value === "500" ? 500 : 400 })}>
                {UI_FONT_WEIGHTS.map((weight) => <option key={weight} value={weight}>{FONT_WEIGHT_LABELS[weight]}</option>)}
              </select>
            </div>
          </div>

          <details className="typography-navigation">
            <summary className="settings-row-label">菜单、空间名称与任务名称</summary>
            {NAVIGATION_FONT_ROLES.map((role) => {
              const font = navigationTypography[role] ?? DEFAULT_NAVIGATION_FONT;
              const label = NAVIGATION_FONT_LABELS[role];
              return (
                <div key={role} className="typography-flat-row">
                  <div className="typography-flat-copy"><div className="settings-row-label">{label}</div></div>
                  <div className="typography-controls navigation-font-controls">
                    <FontPicker label={`${label}字体`} value={font.family} options={navigationFontOptions} placeholder="跟随界面"
                      onSelect={(option) => void selectNavigationFont(role, option)} disabled={fontBusy} />
                    <FontSizeSelect label={`${label}字号`} value={font.size} max={20} allowInherit disabled={fontBusy}
                      onChange={(size) => void updateNavigationFont(role, { size })} />
                    <select className="settings-input typography-value-select" aria-label={`${label}粗细`} value={font.weight ?? ""} disabled={fontBusy}
                      onChange={(event) => void updateNavigationFont(role, { weight: NAVIGATION_FONT_WEIGHTS.find((weight) => String(weight) === event.target.value) ?? null })}>
                      <option value="">跟随界面</option>
                      {NAVIGATION_FONT_WEIGHTS.map((weight) => <option key={weight} value={weight}>{FONT_WEIGHT_LABELS[weight]}</option>)}
                    </select>
                  </div>
                </div>
              );
            })}
          </details>

          <div className="typography-flat-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">回复字体</div>
              <div className="settings-row-desc">用于助手回复正文</div>
            </div>
            <FontPicker label="回复字体" value={replyFontFamily} options={replyFontOptions} placeholder="跟随界面" onSelect={(option) => void selectFontOption("replyFontFamily", option)} disabled={fontBusy} />
          </div>

          <div className="typography-flat-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">回复字号与粗细</div>
            </div>
            <div className="typography-controls">
              <FontSizeSelect label="回复字号" value={replyFontSize} max={24} allowInherit disabled={fontBusy}
                onChange={(size) => void persistTypography({ replyFontSize: size })} />
              <select className="settings-input typography-value-select" aria-label="回复粗细" value={replyFontWeight} disabled={fontBusy}
                onChange={(event) => {
                  const weight = REPLY_FONT_WEIGHTS.find((item) => String(item) === event.target.value);
                  if (weight !== undefined) void persistTypography({ replyFontWeight: weight });
                }}>
                {REPLY_FONT_WEIGHTS.map((weight) => <option key={weight} value={weight}>{FONT_WEIGHT_LABELS[weight]}</option>)}
              </select>
            </div>
          </div>

          <div className="typography-flat-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">代码字体</div>
              <div className="settings-row-desc">用于代码块、编辑器和终端</div>
            </div>
            <FontPicker label="代码字体" value={codeFontFamily} options={codeFontOptions} placeholder="系统等宽" onSelect={(option) => void selectFontOption("codeFontFamily", option)} disabled={fontBusy} />
          </div>

          <div className="typography-flat-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">代码字号</div>
              <div className="settings-row-desc">终端跟随此字号，最低 14 px</div>
            </div>
            <FontSizeSelect label="代码字号" value={codeFontSize} max={20} disabled={fontBusy}
              onChange={(size) => size !== null && void persistTypography({ codeFontSize: size })} />
          </div>

          <div className="typography-preview" aria-label="字体预览">
            <div className="typography-preview-title">MyBuddy Dots</div>
            <div className="md md-chat"><p>项目文档已更新。打开 <code>README.md</code> 查看详细说明。</p></div>
          </div>

          <div className="typography-code-theme">
            <div className="typography-code-theme-head">
              <div>
                <div className="settings-row-label">代码主题</div>
                <div className="settings-row-desc">选择代码块的语法高亮配色</div>
              </div>
            </div>
            <select className="code-theme-select" value={codeTheme} onChange={(event) => void changeCodeTheme(event.target.value as CodeThemeId)}>
              <optgroup label="浅色 + 深色">
                {CODE_THEME_OPTIONS.filter((option) => option.mode === "dual").map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </optgroup>
              <optgroup label="深色">
                {CODE_THEME_OPTIONS.filter((option) => option.mode === "dark").map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </optgroup>
            </select>
            <div className="code-theme-preview" data-preview-code-theme={codeTheme} aria-label="代码主题预览">
              {codeThemePreviewVariants.map((variant) => (
                <div key={variant} className="code-theme-preview-pane" data-variant={variant}>
                  <div className="code-theme-preview-line"><span className="code-theme-preview-ln">1</span><code><span className="tok-keyword">function</span> <span className="tok-function">greet</span>() {"{"}</code></div>
                  <div className="code-theme-preview-line"><span className="code-theme-preview-ln">2</span><code>  <span className="tok-keyword">const</span> name = <span className="tok-string">&quot;world&quot;</span></code></div>
                  <div className="code-theme-preview-line"><span className="code-theme-preview-ln">3</span><code>  console.<span className="tok-function">log</span>(name)</code></div>
                  <div className="code-theme-preview-line"><span className="code-theme-preview-ln">4</span><code>  <span className="tok-keyword">return</span> <span className="tok-number">true</span></code></div>
                  <div className="code-theme-preview-line"><span className="code-theme-preview-ln">5</span><code>{"}"}</code></div>
                </div>
              ))}
            </div>
          </div>

          <div className="typography-custom-font-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">字体库</div>
              <div className="settings-row-desc">
                {systemFontsLoading ? "正在读取系统字体…" : systemFontsError ? systemFontsError : `系统字体 ${systemFonts.length} 个 · 已导入 ${userFonts.length} 个`}
                {fontHint ? <span className="typography-save-state"> · {fontHint}</span> : null}
              </div>
            </div>
            <div className="typography-custom-font-actions">
              <button type="button" className="btn" onClick={() => void refreshSystemFonts()} disabled={systemFontsLoading}><IconRefresh size={14} />刷新</button>
              <button type="button" className="btn" onClick={() => void window.api?.agent?.openFontsDir?.()}><IconFolder size={14} />目录</button>
              <button type="button" className="btn" disabled={fontBusy} onClick={() => void importUserFont()}><IconPlus size={14} />导入字体</button>
            </div>
          </div>

          {userFonts.length > 0 && (
            <div className="typography-imported-font-list">
              {userFonts.map((font) => (
                <div key={font.id} className="typography-imported-font-item">
                  <span style={{ fontFamily: userFontCssFamily(font.family) }}>{font.family}</span>
                  <button type="button" title={`删除 ${font.family}`} onClick={() => setConfirmRemoveFont(font)} disabled={fontBusy}><IconX size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="对话排版">
        <div className="appearance-controls">
          <div className="typography-flat-row">
            <div className="typography-flat-copy"><div className="settings-row-label">行距与段距</div></div>
            <div className="typography-controls">
              <select className="settings-input typography-value-select" aria-label="回复行距" value={replyLayout.lineHeight} disabled={fontBusy}
                onChange={(event) => {
                  const lineHeight = REPLY_LINE_HEIGHTS.find((option) => String(option) === event.target.value);
                  if (lineHeight !== undefined) void updateReplyLayout({ lineHeight });
                }}>
                {REPLY_LINE_HEIGHTS.map((value) => <option key={value} value={value}>行距 · {REPLY_LINE_HEIGHT_LABELS[value]}</option>)}
              </select>
              <select className="settings-input typography-value-select" aria-label="回复段距" value={replyLayout.paragraphGap} disabled={fontBusy}
                onChange={(event) => {
                  const paragraphGap = REPLY_PARAGRAPH_GAPS.find((option) => String(option) === event.target.value);
                  if (paragraphGap !== undefined) void updateReplyLayout({ paragraphGap });
                }}>
                {REPLY_PARAGRAPH_GAPS.map((value) => <option key={value} value={value}>段距 · {REPLY_PARAGRAPH_GAP_LABELS[value]}</option>)}
              </select>
            </div>
          </div>
          <div className="typography-flat-row">
            <label className="settings-row-label" htmlFor="appearance-chat-width">对话宽度</label>
            <select id="appearance-chat-width" className="settings-input typography-value-select" value={replyLayout.width} disabled={fontBusy}
              onChange={(event) => {
                const width = event.target.value;
                if (width === "narrow" || width === "standard" || width === "wide") void updateReplyLayout({ width });
              }}>
              {Object.entries(CHAT_WIDTH_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>
          <div className="typography-flat-row">
            <label className="settings-row-label" htmlFor="appearance-reply-headings">回复标题样式</label>
            <select id="appearance-reply-headings" className="settings-input typography-value-select" value={replyLayout.headings} disabled={fontBusy}
              onChange={(event) => void updateReplyLayout({ headings: event.target.value === "prominent" ? "prominent" : "subtle" })}>
              <option value="subtle">紧凑</option>
              <option value="prominent">突出层级</option>
            </select>
          </div>
          <div className="typography-preview" aria-label="对话排版预览">
            <div className="md md-chat"><h2>项目文档</h2><p>已补充项目定位和数据来源，文件可以直接打开。</p><p>详细说明见 <code>README.md</code>。</p></div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="自动上下文管理" desc="默认自动生效：日常不需要手动压缩，达到阈值时自动整理上下文。">
        <CompactionSettingsControl />
      </SettingsSection>

      <SettingsSection title="网络">
        <Row label="代理" desc="可选，写入 settings.json">
          <input
            className="settings-input"
            value={proxyUrl}
            onChange={(event) => setProxyUrl(event.target.value)}
            onBlur={() => void saveProxy()}
            onKeyDown={(event) => { if (event.key === "Enter") void saveProxy(); }}
            placeholder="http://127.0.0.1:7890"
          />
        </Row>
      </SettingsSection>

      <SettingsSection title="存储" desc="数据目录 ~/.mybuddy（任务记录、缓存等）">
        <div className="storage-inline">
          <div className="storage-bar">
            <div
              className="storage-bar-used"
              style={{ width: usagePercent === "--" ? "0%" : `${Math.min(100, Math.max(0, Number(usagePercent)))}%` }}
            />
          </div>
          <div className="settings-row-desc">
            已用 {formatBytes(diskSpace?.usedBytes ?? 0)} · 可用 {formatBytes(diskSpace?.freeBytes ?? 0)} · 共 {formatBytes(diskSpace?.totalBytes ?? 0)}
            {usagePercent !== "--" ? `（磁盘 ${usagePercent}%）` : null}
          </div>
        </div>
      </SettingsSection>

      {(hint || errorMsg) && (
        <div className="system-settings-inline-status">
          {hint ? <span className="settings-hint ok">{hint}</span> : null}
          {errorMsg ? <span className="settings-hint err">{errorMsg}</span> : null}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemoveFont !== null}
        title={`删除已导入字体「${confirmRemoveFont?.family ?? ""}」？`}
        body="字体将从字体库移除。正在使用它的字体选项会恢复为默认。"
        confirmLabel="删除"
        danger
        onCancel={() => !fontBusy && setConfirmRemoveFont(null)}
        onConfirm={() => {
          const target = confirmRemoveFont;
          setConfirmRemoveFont(null);
          if (target) void removeFont(target);
        }}
      />
    </div>
  );
}

/** WebAccess（pi-web-access）搜索配置卡片：API key + 路由，写入 ~/.mybuddy/web-search.json */
function PersonalizeTab(): React.JSX.Element {
  const soul = useAppStore((s) => s.soul);
  const updateSoul = useAppStore((s) => s.updateSoul);
  const [welcome, setWelcome] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const memoryFiles = [
    { key: "alias", title: "MyBuddy 对你的称呼", value: soul.alias },
    { key: "name", title: "MyBuddy 的名字", value: soul.name },
    { key: "persona", title: "MyBuddy 的人设 / 人格描述", value: soul.persona, long: true },
  ] as const;

  return (
    <>
      <Row label="基本风格和语调" desc="设置 MyBuddy 回复你的风格和语调。这不会影响 MyBuddy 的功能。">
        <select className="pill-select">
          <option>默认</option>
          <option>简洁</option>
          <option>正式</option>
          <option>活泼</option>
        </select>
      </Row>
      <Row label="加载过程欢迎语" desc="在 MyBuddy 生成等待过程中展示辅助提示。关闭后可在这里重新打开。">
        <Toggle on={welcome} onChange={setWelcome} />
      </Row>

      <div className="settings-row column">
        <div className="settings-row-label">自定义指令</div>
        <div className="settings-row-desc">
          告诉 MyBuddy 你希望它始终遵循的规则和偏好，这会直接影响所有对话。
        </div>
        <textarea
          className="soul-textarea"
          rows={5}
          placeholder='例如："每次回答我之前都说 ok, 再接后续内容"'
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <div className="instructions-footer">
          <span className="settings-row-desc">这些指令会应用于你的所有对话</span>
          <span className="settings-row-desc">{instructions.length} / 1500</span>
        </div>
        <div className="instructions-actions">
          <button className="btn primary" disabled={!instructions.trim()}>
            确认
          </button>
        </div>
      </div>

      <div className="settings-row column">
        <div className="settings-row-label">本地个性化资料</div>
        <div className="settings-row-desc">
          以下资料存储在本地数据库。长期记忆请在独立的“记忆”页面中管理。
        </div>
        {memoryFiles.map((f) => (
          <div key={f.key} className="memory-file-card">
            <div className="memory-file-title">{f.title}</div>
            {editing === f.key ? (
              <textarea
                className="soul-textarea"
                rows={"long" in f && f.long ? 6 : 2}
                value={f.value}
                onChange={(e) => updateSoul({ [f.key]: e.target.value })}
              />
            ) : (
              <div className={`memory-file-value ${"long" in f && f.long ? "clamp" : ""}`}>
                {f.value || "（未设置）"}
              </div>
            )}
            <div className="memory-file-actions">
              <button
                className="btn"
                onClick={() => setEditing(editing === f.key ? null : f.key)}
              >
                {editing === f.key ? "完成" : "编辑"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}


function AssistantTab(): React.JSX.Element {
  return (
    <>
      <div className="settings-row-desc" style={{ marginBottom: 12 }}>
        仅对符合授权条件的消息进行文字对话，并回复原会话；不调用本机工具或读取个人资料，附件暂不读取。连接成功不代表消息已处理或回复成功，请查看本地助理消息记录。应用重启后尝试恢复已保存的连接。
      </div>

      <QQGatewaySettings />
      <WeixinGatewaySettings />

      <GatewayBlock
        channelId="slack-default"
        title="Slack 私聊"
        desc="接收指定工作区的私聊和频道 @ 提及，结果回复原讨论串。频道仅限 owner 触发；应用需已加入频道。令牌加密保存。"
        fields={[
          { key: "appId", label: "App ID", placeholder: "A0123456789" },
          { key: "teamId", label: "工作区 ID", placeholder: "T0123456789" },
          { key: "appToken", label: "App Token（connections:write）", type: "password", placeholder: "已有 xapp-… 令牌" },
          { key: "botToken", label: "Bot Token", type: "password", placeholder: "已安装 Bot 的 xoxb-… 令牌" },
        ]}
      />

      <GatewayBlock
        channelId="telegram-default"
        title="Telegram（推荐）"
        desc="在 @BotFather 创建 Bot，填写 Token 和允许的用户 ID；无需公网回调。"
        fields={[
          { key: "botToken", label: "Bot Token", type: "password", placeholder: "123456:AA-xxx" },
        ]}
      />

      <GatewayBlock
        channelId="dingtalk-default"
        registration={onConnected => <BusinessGatewayRegistration provider="dingtalk" onConnected={onConnected} />}
        title="钉钉企业机器人"
        desc="官方 Stream 长连接，无需公网回调。仅接受指定企业与员工消息，文字回复发回原会话；需要机器人消息权限。凭据加密保存。"
        fields={[
          { key: "clientId", label: "Client ID", placeholder: "应用 AppKey" },
          { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "应用 AppSecret" },
          { key: "corpId", label: "企业 Corp ID", placeholder: "企业标识" },
          { key: "robotCode", label: "Robot Code", placeholder: "机器人编码" },
        ]}
      />
      <GatewayBlock
        channelId="discord-default"
        title="Discord 官方 Bot"
        desc="使用官方 Bot Token 和 Gateway 长连接，服务器中仅接受 @Bot，私聊需显式启用。文字回复发回原频道或讨论串；需要发送消息权限。凭据加密保存，不支持个人账号 Token。"
        fields={[
          { key: "applicationId", label: "Application ID", placeholder: "Discord 应用 ID" },
          { key: "botToken", label: "Bot Token", type: "password", placeholder: "官方机器人 Token" },
          { key: "guildIds", label: "允许的服务器 ID", type: "list", placeholder: "多个 ID 用逗号分隔" },
        ]}
      />
      <GatewayBlock
        channelId="feishu-default"
        registration={onConnected => <BusinessGatewayRegistration provider="feishu" onConnected={onConnected} />}
        title="飞书"
        desc="推荐 websocket：飞书官方 SDK 长连接，无需公网回调。保留 webhook 模式，需 Verification Token 与公网 /feishu 回调。渠道支持接收文本与媒体，但本地助理当前仅处理文字，不读取附件或提供完整 Hermes 卡片能力。"
        fields={[
          { key: "transport", label: "接入方式", placeholder: "websocket 或 webhook（旧配置保留 webhook）" },
          { key: "appId", label: "App ID", placeholder: "cli_xxx" },
          { key: "appSecret", label: "App Secret", type: "password", placeholder: "密钥" },
          { key: "verificationToken", label: "Verification Token", type: "password", placeholder: "事件订阅校验令牌" },
        ]}
      />

      <GatewayBlock
        channelId="wecom-default"
        registration={onConnected => <BusinessGatewayRegistration provider="wecom" onConnected={onConnected}/> }
        title="企微"
        desc="smart：官方 Smart Robot 长连接，填写 Bot ID 和 Secret；callback：原自建应用回调，填写下方 Corp ID、Agent ID、Secret、Token 和 AES Key，需公网 /wecom。Smart Robot 支持文本与媒体收取、Markdown 回复；本地助理当前仅处理文字，不读取附件，不提供主动 Work 通知或原生流式。"
        fields={[
          { key: "mode", label: "接入方式", placeholder: "smart 或 callback（旧配置保留 callback）" },
          { key: "botId", label: "Bot ID", placeholder: "Smart Robot ID" },
          { key: "corpId", label: "Corp ID", placeholder: "ww_xxx" },
          { key: "agentId", label: "Agent ID", placeholder: "1000002" },
          { key: "secret", label: "Secret", type: "password", placeholder: "密钥" },
          { key: "token", label: "Token", type: "password", placeholder: "回调 Token" },
          { key: "encodingAESKey", label: "EncodingAESKey", type: "password", placeholder: "43 位密钥" },
        ]}
      />

      <GatewayBlock
        channelId="wechat-default"
        title="微信公众号"
        desc="公众号消息回调接入，需要将本应用 /wechat 路径提供为平台可达的公网 HTTPS 地址。与个人微信扫码接入不同。"
        fields={[
          { key: "appId", label: "App ID", placeholder: "wx_xxx" },
          { key: "appSecret", label: "App Secret", type: "password", placeholder: "密钥" },
          { key: "token", label: "Token", type: "password", placeholder: "回调 Token" },
          { key: "encodingAESKey", label: "EncodingAESKey", type: "password", placeholder: "43 位密钥" },
        ]}
      />
    </>
  );
}

const RECORD_PAGE_SIZE = 8;

function RecordPager({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }): React.JSX.Element {
  const pages = Math.max(1, Math.ceil(total / RECORD_PAGE_SIZE));
  return (
    <nav className="record-pager" aria-label="记录分页">
      <span>{total ? `共 ${total} 条 · ${(page - 1) * RECORD_PAGE_SIZE + 1}–${Math.min(page * RECORD_PAGE_SIZE, total)} 条` : "共 0 条"}</span>
      <div>
        <button type="button" className="btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
        <span aria-live="polite">{page} / {pages}</span>
        <button type="button" className="btn" disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</button>
      </div>
    </nav>
  );
}

function DataTab(): React.JSX.Element {
  const rows: Array<{
    icon: React.ComponentType<{ size?: number }>;
    label: string;
    tab?: SettingsTab;
  }> = [
    { icon: IconFile, label: "我分享的文件" },
    { icon: IconShare, label: "我分享的任务" },
    { icon: IconGrid, label: "我发布的应用" },
    { icon: IconClock, label: "已归档任务", tab: "archive" },
  ];
  return (
    <>
      {rows.map((r) => (
        <div key={r.label} className="settings-row">
          <div className="settings-row-label with-icon">
            <r.icon size={15} /> {r.label}
          </div>
          <button
            className="btn"
            onClick={r.tab ? () => useAppStore.setState({ settingsTab: r.tab }) : undefined}
          >
            管理
          </button>
        </div>
      ))}
    </>
  );
}

function ShortcutsTab(): React.JSX.Element {
  const shortcuts = [
    { label: "新建任务", keys: "Ctrl + N" },
    { label: "发送消息", keys: "Enter" },
    { label: "换行", keys: "Shift + Enter" },
    { label: "打开设置", keys: "Ctrl + ," },
  ];
  return (
    <>
      {shortcuts.map((s) => (
        <div key={s.label} className="settings-row">
          <div className="settings-row-label">{s.label}</div>
          <span className="kbd">{s.keys}</span>
        </div>
      ))}
    </>
  );
}

function NotificationsTab(): React.JSX.Element {
  const [preferences, setPreferences] = useState<NotificationPreferencesDto>({ ...DEFAULT_NOTIFICATION_PREFERENCES });
  const [status, setStatus] = useState("");

  useEffect(() => {
    void window.api?.agent?.getAppSettings?.().then((settings) => {
      setPreferences(normalizeNotificationPreferences(settings?.notificationPreferences));
    });
  }, []);

  const updatePreference = async (key: keyof NotificationPreferencesDto, value: boolean): Promise<void> => {
    const previous = preferences;
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    setStatus("");
    try {
      const saved = await window.api?.agent?.updateAppSettings?.({ notificationPreferences: next });
      setPreferences(normalizeNotificationPreferences(saved?.notificationPreferences ?? next));
    } catch (error) {
      setPreferences(previous);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const toggle = (key: keyof NotificationPreferencesDto) => (
    <Toggle on={preferences[key]} onChange={(value) => void updatePreference(key, value)} />
  );

  return (
    <>
      <SettingsSection title="通知方式" desc="通知中心是统一真源；桌面通知只是额外提醒，不影响通知历史。">
        <Row label="应用内通知" desc="保存到左下角铃铛通知中心，并保留未读状态。">
          {toggle("inAppEnabled")}
        </Row>
        <Row label="桌面通知" desc="通过 Windows / macOS 原生通知提醒重要事件。">
          {toggle("desktopEnabled")}
        </Row>
        <Row label="普通通知仅后台弹出" desc="MyBuddy 正在前台时，完成类通知只进入铃铛；错误和待处理仍可桌面提醒。">
          {toggle("desktopBackgroundOnly")}
        </Row>
      </SettingsSection>

      <SettingsSection title="任务">
        <Row label="任务完成" desc="长任务执行完成后提醒。">{toggle("taskCompleted")}</Row>
        <Row label="任务失败" desc="模型、工具或运行过程失败。">{toggle("taskFailed")}</Row>
        <Row label="需要我处理" desc="任务等待你确认、选择或补充信息时提醒。">{toggle("actionRequired")}</Row>
      </SettingsSection>

      <SettingsSection title="自动化与项目">
        <Row label="自动化完成">{toggle("automationCompleted")}</Row>
        <Row label="自动化失败">{toggle("automationFailed")}</Row>
        <Row label="项目需要关注" desc="项目出现阻塞、风险或待确认事项时提醒。">{toggle("projectAttention")}</Row>
        <Row label="运行环境失败" desc="必需的 MCP / 专业工具运行环境启动失败。">{toggle("runtimeFailed")}</Row>
      </SettingsSection>
      {status && <div className="settings-hint error">{status}</div>}
    </>
  );
}

type ShellIsolationLevelUi = "cwd-only" | "guarded" | "os-sandbox";

function SecurityTab(): React.JSX.Element {
  const tasks = useAppStore((s) => s.tasks);
  const spaces = useAppStore((s) => s.spaces);
  const [shellIsolation, setShellIsolation] = useState<ShellIsolationLevelUi>("guarded");
  const [backups, setBackups] = useState<FileBackupInfoDto[]>([]);
  const [view, setView] = useState<"all" | "spaces" | "tasks">("all");
  const [section, setSection] = useState<"settings" | "backups">("settings");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [page, setPage] = useState(1);
  const listRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const loadBackups = useCallback((): void => {
    void window.api?.agent?.listBackups?.().then((rows) => setBackups(rows ?? []));
  }, []);

  useEffect(() => {
    void window.api?.agent?.getAppSettings?.().then((s) => {
      const level = s?.shellIsolationLevel;
      if (level === "cwd-only" || level === "guarded" || level === "os-sandbox") {
        setShellIsolation(level);
      }
    });
    loadBackups();
  }, [loadBackups]);

  const changeShellIsolation = async (level: ShellIsolationLevelUi): Promise<void> => {
    const prev = shellIsolation;
    setShellIsolation(level);
    try {
      await window.api?.agent?.updateAppSettings?.({ shellIsolationLevel: level });
      if (level === "os-sandbox") {
        setStatus(
          "本机代码执行已使用实验性环境加固；不影响 Pi 原生命令工具。",
        );
      } else if (level === "cwd-only") {
        setStatus("本机代码执行已切换为仅设置工作目录");
      } else {
        setStatus("本机代码执行已使用默认工作目录防护");
      }
    } catch (err) {
      setShellIsolation(prev);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const restore = async (b: FileBackupInfoDto): Promise<void> => {
    setBusy(true);
    try {
      await window.api?.agent?.restoreBackup?.({ taskId: b.taskId, backupId: b.backupId });
      setStatus(`已还原：${b.relPath}`);
      loadBackups();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const taskTitleOf = (taskId: string): string =>
    tasks.find((t) => t.id === taskId)?.title ?? taskId;
  /** 任务所属空间名；无空间（普通任务）返回 null */
  const spaceOf = (taskId: string): string | null => {
    const spaceId = tasks.find((t) => t.id === taskId)?.spaceId;
    if (!spaceId) return null;
    return spaces.find((s) => s.id === spaceId)?.name ?? spaceId;
  };

  /** 按工作空间分组：备份 → 任务 → 空间；无空间归属的任务归「未分组任务」 */
  const groupBySpace = useMemo(() => {
    const map = new Map<string, { key: string; name: string; list: FileBackupInfoDto[] }>();
    for (const b of backups) {
      const spaceId = tasks.find((t) => t.id === b.taskId)?.spaceId ?? "__none__";
      const name =
        spaceId === "__none__"
          ? "未分组任务"
          : (spaces.find((s) => s.id === spaceId)?.name ?? spaceId);
      let g = map.get(spaceId);
      if (!g) {
        g = { key: spaceId, name, list: [] };
        map.set(spaceId, g);
      }
      g.list.push(b);
    }
    return [...map.values()]
      .map((g) => ({ ...g, list: [...g.list].sort((a, b) => b.createdAt - a.createdAt) }))
      .sort((a, b) => (b.list[0]?.createdAt ?? 0) - (a.list[0]?.createdAt ?? 0));
  }, [backups, tasks, spaces]);

  /** 按任务分组 */
  const groupByTask = useMemo(() => {
    const map = new Map<string, { key: string; name: string; list: FileBackupInfoDto[] }>();
    for (const b of backups) {
      let g = map.get(b.taskId);
      if (!g) {
        g = { key: b.taskId, name: taskTitleOf(b.taskId), list: [] };
        map.set(b.taskId, g);
      }
      g.list.push(b);
    }
    return [...map.values()]
      .map((g) => ({ ...g, list: [...g.list].sort((a, b) => b.createdAt - a.createdAt) }))
      .sort((a, b) => (b.list[0]?.createdAt ?? 0) - (a.list[0]?.createdAt ?? 0));
  }, [backups, tasks, spaces]);

  const groups = view === "spaces" ? groupBySpace : groupByTask;
  const selectedGroup = groups.find((item) => item.key === group);
  const needle = query.trim().toLocaleLowerCase();
  const filteredBackups = (view !== "all" && selectedGroup ? selectedGroup.list : backups)
    .filter((b) => `${b.relPath} ${taskTitleOf(b.taskId)} ${spaceOf(b.taskId) ?? ""}`.toLocaleLowerCase().includes(needle))
    .slice().sort((a, b) => b.createdAt - a.createdAt);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredBackups.length / RECORD_PAGE_SIZE)));
  useEffect(() => { setPage(currentPage); }, [currentPage]);
  useEffect(() => { listRef.current?.scrollTo(0, 0); }, [currentPage, section, query, view, group]);

  /** 单条备份卡片；showOwner 时额外显示所属空间/任务（全部视图用） */
  const renderBackup = (b: FileBackupInfoDto, showOwner = false): React.JSX.Element => {
    const deleted = b.kind === "deleted";
    const owner = showOwner
      ? (spaceOf(b.taskId) ? `${spaceOf(b.taskId)} · ` : "") + taskTitleOf(b.taskId)
      : "";
    return (
      <div key={`${b.taskId}-${b.backupId}`} className="memory-note-card backup-card">
        <div className="memory-note-content">
          {deleted && <span className="backup-badge deleted">已删除</span>}
          {!deleted && <span className="backup-badge modified">已修改</span>}
          {b.isDir && <span className="backup-badge dir">目录</span>}
          <span className="backup-path" title={b.relPath}>{b.relPath}</span>
        </div>
        <div className="memory-note-footer">
          <div className="memory-note-meta">
            {owner && <span className="memory-source manual">{owner}</span>}
            <span>{formatTime(b.createdAt)}</span>
            <span>{formatSize(b.size)}</span>
          </div>
          <div className="memory-note-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              title={deleted ? "重新创建该文件/目录（内容为删除前的副本）" : "覆盖为备份时的内容"}
              onClick={() => void restore(b)}
            >
              还原
            </button>
          </div>
        </div>
      </div>
    );
  };

  const formatTime = (timestamp: number): string =>
    new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp);

  const formatSize = (size: number): string => {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div className="record-management security-management">
      <div className="record-tabs" role="group" aria-label="安全中心分类">
        <button type="button" aria-pressed={section === "settings"} onClick={() => setSection("settings")}>安全设置</button>
        <button type="button" aria-pressed={section === "backups"} onClick={() => setSection("backups")}>历史备份 <span>{backups.length}</span></button>
      </div>
      {section === "settings" && <div className="security-settings-scroll">
      <div className="radio-row security-setting-card">
        <div className="settings-row-label">本机代码执行环境</div>
        <div className="settings-row-desc" style={{ marginBottom: 6 }}>
          此设置用于本机代码执行工具。Pi 原生命令工具使用 Pi 的 Shell 配置；用户终端使用自己的偏好。实验性环境加固不保证防止任意脚本越界。
        </div>
        <label className="radio-option">
          <input
            type="radio"
            checked={shellIsolation === "guarded"}
            onChange={() => void changeShellIsolation("guarded")}
          />
          <span>
            <b>guarded（推荐）</b> —— 使用任务工作目录防护
          </span>
        </label>
        <label className="radio-option">
          <input
            type="radio"
            checked={shellIsolation === "os-sandbox"}
            onChange={() => void changeShellIsolation("os-sandbox")}
          />
          <span>
            <b>os-sandbox（实验）</b> —— 加固代码执行环境；默认关闭
          </span>
        </label>
        <label className="radio-option">
          <input
            type="radio"
            checked={shellIsolation === "cwd-only"}
            onChange={() => void changeShellIsolation("cwd-only")}
          />
          <span>
            <b>cwd-only</b> —— 仅设置工作目录，用于兼容对比
          </span>
        </label>
      </div>

      </div>}
      {section === "backups" && <>
        <div className="record-intro">旧版本留下的历史文件副本，可查找并手动还原。当前版本不再自动创建备份。</div>
        <div className="record-toolbar">
          <input className="record-search" type="search" aria-label="搜索备份" placeholder="搜索文件路径、任务或空间" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
          <button type="button" className="btn" onClick={loadBackups}><IconRefresh size={13} /> 刷新</button>
        </div>
        <div className="record-toolbar">
          <div className="record-tabs" role="group" aria-label="备份分类">
            {([['all', '全部'], ['spaces', '工作空间'], ['tasks', '任务']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => { setView(key); setGroup(""); setPage(1); }}>{label}</button>)}
          </div>
          {view !== "all" && <select className="record-select" aria-label={view === "spaces" ? "筛选空间" : "筛选任务"} value={selectedGroup ? group : ""} onChange={(e) => { setGroup(e.target.value); setPage(1); }}>
            <option value="">{view === "spaces" ? "所有空间" : "所有任务"}</option>
            {groups.map((g) => <option key={g.key} value={g.key}>{g.name}（{g.list.length}）</option>)}
          </select>}
        </div>
        <div className="record-list" ref={listRef}>
          {filteredBackups.length === 0 && <div className="record-empty"><IconShield size={28} /><b>{needle ? "没有匹配的备份" : "暂无历史备份"}</b><span>{needle ? "试试其他关键词，或清空搜索。" : "此处仅保留旧版本创建的文件副本。"}</span></div>}
          {filteredBackups.slice((currentPage - 1) * RECORD_PAGE_SIZE, currentPage * RECORD_PAGE_SIZE).map((b) => renderBackup(b, true))}
        </div>
        <RecordPager page={currentPage} total={filteredBackups.length} onChange={setPage} />
      </>}
      {status && <div className="record-status" role="status">{status}</div>}
    </div>
  );
}

function HelpTab(): React.JSX.Element {
  const versions = window.api?.versions;
  return (
    <div className="about-block">
      <div>
        <b>MyBuddy</b> v{APP_VERSION} — MyBuddy 形态的桌面 Agent
      </div>
      <div>Agent 底座：pi（@earendil-works，阶段 2 接入）</div>
      <div>
        上下文管理：基于 billion-context / acp-kernel (MIT)
      </div>
      <div>
        billion-context：{" "}
        <button
          type="button"
          className="link-btn"
          onClick={() => { window.api?.browser?.openExternal?.("https://github.com/ranxianglei/billion-context"); }}
        >
          https://github.com/ranxianglei/billion-context
        </button>
        {" · "}
        acp-kernel：{" "}
        <button
          type="button"
          className="link-btn"
          onClick={() => { window.api?.browser?.openExternal?.("https://github.com/ranxianglei/acp-kernel"); }}
        >
          https://github.com/ranxianglei/acp-kernel
        </button>
      </div>
      <div>
        Electron {versions?.electron ?? "-"} · Node {versions?.node ?? "-"}
      </div>
      <div>数据目录：~/.mybuddy</div>
      <div style={{ marginTop: 8 }}>
        <button className="btn">反馈问题</button> <button className="btn">检查更新</button>
      </div>
    </div>
  );
}

const TAB_TITLE: Record<SettingsTab, string> = {
  system: "设置",
  extensions: "工具能力",
  modes: "模式与提示词",
  personalize: "个性化",
  memory: "记忆",
  dots: "Dots 设置",
  nativeHooks: "执行钩子",
  nativeImprovement: "自我改进",
  materialRetrieval: "资料检索",
  archive: "归档管理",
  models: "模型",
  subagent: "子代理设置",
  assistant: "助理设置",
  acp: "ACP 管理",
  data: "数据管理",
  python: "Python 运行时",
  shortcuts: "快捷键",
  notifications: "通知",
  remote: "远程连接",
  security: "安全中心",
  help: "帮助与反馈",
};

export default function SettingsModal({ desktop = false }: { desktop?: boolean }): React.JSX.Element {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const tab = useAppStore((s) => s.settingsTab);
  // Settings hides the desktop underlay without unmounting embedded native document views.
  useBlockNativeSurfaces(true);
  const changeTab = (id: SettingsTab): void => { useAppStore.setState({ settingsTab: id }); };

  const content = (
      <div className={desktop ? "settings-modal desktop-settings" : "settings-modal"} onClick={(e) => e.stopPropagation()}>
        {desktop ? <DesktopSectionSidebar title="设置" scrollKey="settings">
          {TABS.map(t => <DesktopSectionRow key={t.id} className={`settings-nav-btn${tab === t.id ? " active" : ""}`} active={tab === t.id} icon={<UiIcon name={t.glyph} size={15} accent={tab !== t.id} />} onClick={() => changeTab(t.id)}>{t.label}</DesktopSectionRow>)}
        </DesktopSectionSidebar> : <div className="settings-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-nav-btn ${tab === t.id ? "active" : ""}`}
              onClick={() => changeTab(t.id)}
            >
              <span className="nav-icon">
                <UiIcon name={t.glyph} size={15} accent={tab !== t.id} />
              </span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>}
        <div className="settings-content">
          <div className="settings-content-head">
            <span className="settings-content-title">{TAB_TITLE[tab]}</span>
            <button className="icon-btn" title="关闭设置" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>
              <IconX size={16} />
            </button>
          </div>
          <div className="settings-content-body">
            {tab === "system" && <SystemTab />}
            {tab === "extensions" && <CapabilitiesTab />}
            {tab === "modes" && <ModesTab />}
            {tab === "personalize" && <PersonalizeTab />}
            {tab === "memory" && <MemoryTab />}
            {tab === "dots" && <DotsSettingsTab />}
            {tab === "nativeHooks" && <NativeHooksTab />}
            {tab === "nativeImprovement" && <NativeImprovementTab />}
            {tab === "materialRetrieval" && <MaterialRetrievalTab />}
            {tab === "archive" && <ArchivesTab />}
            {tab === "models" && <ModelsTab />}
            {tab === "subagent" && <SubagentSettingsTab />}
            {tab === "assistant" && <AssistantTab />}
            {tab === "acp" && <AcpTab />}
            {tab === "data" && <DataTab />}
            {tab === "python" && <PythonRuntimeTab />}
            {tab === "shortcuts" && <ShortcutsTab />}
            {tab === "notifications" && <NotificationsTab />}
            {tab === "remote" && <RemoteAccessTab />}
            {tab === "security" && <SecurityTab />}
            {tab === "help" && <HelpTab />}
          </div>
        </div>
      </div>
  );
  return desktop ? content : <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>{content}</div>;
}
